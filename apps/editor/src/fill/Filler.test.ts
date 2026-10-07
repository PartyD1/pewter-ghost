import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTHOR, TILE, type Filler, type FillRequest, type Suggestion } from "../contracts";
import { applyOverrides, resetConfig } from "../suggest/config";
import { freshStart, midStaircase, verticalTower } from "./__fixtures__/states";
import { FillerRegistry, StubFiller, isAbortError, isFillerName, sleep, stubStaircase } from "./Filler";
import { requestHash } from "./hash";
import { buildFillRequest, gridRows, levelToWindow } from "./window";

afterEach(() => {
  resetConfig();
  vi.useRealTimers();
});

function reqFor(fx: ReturnType<typeof freshStart>, mode: FillRequest["mode"] = "requested") {
  return buildFillRequest(fx.model, fx.stream, { now: fx.now, mode, cols: 24, rows: 12, recentCount: 12 });
}

class FakeFiller implements Filler {
  calls = 0;
  constructor(readonly name: Filler["name"]) {}
  async fill(): Promise<Suggestion | null> {
    this.calls++;
    return null;
  }
}

describe("FillerRegistry", () => {
  it("registers fillers and switches the active one", async () => {
    const llm = new FakeFiller("llm");
    const stub = new StubFiller();
    const reg = new FillerRegistry([llm, stub], "llm");
    expect(reg.names()).toEqual(["llm", "stub"]);
    expect(reg.activeName).toBe("llm");
    await reg.fill(reqFor(freshStart()));
    expect(llm.calls).toBe(1);
    reg.setActive("stub");
    expect(reg.active).toBe(stub);
    reg.setActive("none");
    expect(reg.active).toBeUndefined();
    expect(await reg.fill(reqFor(freshStart()))).toBeNull();
  });

  it("refuses to activate an unregistered filler and rejects bad names", () => {
    const reg = new FillerRegistry();
    expect(() => reg.setActive("algo")).toThrow(/not registered/);
    expect(() => reg.register({ name: "gpt" as never, fill: async () => null })).toThrow();
    expect(isFillerName("jev")).toBe(true);
    expect(isFillerName("none")).toBe(false);
  });

  it("follows config.filler, falling back to none when it is not registered", () => {
    const reg = new FillerRegistry([new StubFiller()]);
    applyOverrides({ filler: "stub" });
    expect(reg.useConfig()).toBe("stub");
    applyOverrides({ filler: "llm" });
    expect(reg.useConfig()).toBe("none");
    expect(reg.useConfig({ filler: "none" })).toBe("none");
  });

  it("unregistering the active filler deactivates it; register replaces by name", () => {
    const a = new FakeFiller("algo");
    const b = new FakeFiller("algo");
    const reg = new FillerRegistry([a], "algo");
    reg.register(b);
    expect(reg.get("algo")).toBe(b);
    expect(reg.unregister("algo")).toBe(true);
    expect(reg.activeName).toBe("none");
    expect(reg.has("algo")).toBe(false);
  });
});

describe("stubStaircase", () => {
  it("continues the person's last diagonal with the same tile", () => {
    const fx = midStaircase(); // last paints (54,13) (55,13) (56,12): up-right
    const req = reqFor(fx);
    const a = stubStaircase(req);
    expect(a.act).toBe(true);
    const last = levelToWindow({ x: 56, y: 12 }, req);
    expect(a.adds).toEqual([1, 2, 3].map((k) => ({ x: last.x + k, y: last.y - k, tile: "grass" })));
    expect(a.entities).toEqual([{ kind: "coin", x: last.x + 3, y: last.y - 4 }]);
    expect(a.label).toBe("staircase, 3 more steps");
  });

  it("turns a flat run into steps up and stops at occupied cells and the window edge", () => {
    const fx = freshStart(); // last paints: blocks (12..14, 12)
    const req = reqFor(fx);
    const a = stubStaircase(req, { steps: 40 });
    const rows = gridRows(req.grid);
    expect(a.adds.length).toBeGreaterThan(0);
    for (const c of a.adds) {
      expect(c.tile).toBe("block");
      expect(rows[c.y][c.x]).toBe(".");
    }
    // Up-right until the top row (needs headroom, so it stops at y=0).
    const base = levelToWindow({ x: 14, y: 12 }, req);
    expect(a.adds).toHaveLength(base.y);
    expect(a.adds[0]).toEqual({ x: base.x + 1, y: base.y - 1, tile: "block" });
  });

  it("starts from the frontier with grass when nothing was painted", () => {
    const a = stubStaircase(
      { grid: "", size: { w: 10, h: 10 }, frontier: { x: 2, y: 8, idleMs: 0 }, recent: [] },
      { coin: false },
    );
    expect(a.adds).toEqual([
      { x: 3, y: 7, tile: "grass" },
      { x: 4, y: 6, tile: "grass" },
      { x: 5, y: 5, tile: "grass" },
    ]);
    expect(a.entities).toEqual([]);
  });

  it("tries other directions when blocked, and declines when boxed in", () => {
    // Window 3x3, last paint in the top-right corner: up-right is out, so down-left... first fit wins.
    const grid = "   012\n0 ..G\n1 ...\n2 ...";
    const req = {
      grid,
      size: { w: 3, h: 3 },
      frontier: { x: 2, y: 0, idleMs: 0 },
      recent: [{ dt: 0, x: 2, y: 0, tile: "grass", tool: "paint" as const }],
    };
    const a = stubStaircase(req, { steps: 1, coin: false });
    expect(a.adds).toEqual([{ x: 1, y: 1, tile: "grass" }]); // (-dx, +dy) — up is blocked by the edge
    const boxed = stubStaircase(
      { ...req, grid: "   0\n0 G", size: { w: 1, h: 1 }, recent: [{ dt: 0, x: 0, y: 0, tile: "grass", tool: "paint" }] },
    );
    expect(boxed.act).toBe(false);
  });
});

describe("StubFiller", () => {
  it("returns a deterministic level-coordinate suggestion with the request's hash", async () => {
    const fx = midStaircase();
    const req = reqFor(fx);
    const stub = new StubFiller({ clock: () => 0 });
    const a = await stub.fill(req);
    const b = await stub.fill(req);
    expect(a).not.toBeNull();
    expect({ ...a, id: "" }).toEqual({ ...b, id: "" });
    expect(a!.adds).toEqual([
      { x: 57, y: 11, tile: TILE.GRASS },
      { x: 58, y: 10, tile: TILE.GRASS },
      { x: 59, y: 9, tile: TILE.GRASS },
    ]);
    expect(a!.filler).toBe("stub");
    expect(a!.mode).toBe("requested");
    expect(a!.verified).toBe(false);
    expect(a!.requestHash).toBe(await requestHash(req));
    expect(a!.id.startsWith("stub-")).toBe(true);
  });

  it("can read placements from a stream instead of the request", async () => {
    const fx = verticalTower();
    const req = { ...reqFor(fx), recent: [] };
    const fromStream = await new StubFiller({ stream: fx.stream }).fill(req);
    expect(fromStream).not.toBeNull();
    // Last terrain paint is the half-block pair at y=6, left-to-right: continue right and up.
    expect(fromStream!.adds[0].tile).toBe(TILE.GRASS_HALF);
  });

  it("accepting the stub's ghost writes author = ghost in one undo step", async () => {
    const fx = midStaircase();
    const s = (await new StubFiller().fill(reqFor(fx)))!;
    const depth = fx.model.undoDepth;
    fx.model.applySuggestion(s);
    for (const a of s.adds) {
      expect(fx.model.tileAt(a.x, a.y)).toBe(a.tile);
      expect(fx.model.authorAt(a.x, a.y)).toBe(AUTHOR.GHOST);
      expect(fx.model.provenanceAt(a.x, a.y)).toBe(s.id);
    }
    expect(fx.model.undoDepth).toBe(depth + 1);
    expect(fx.model.undo()?.what).toBe("ghost");
  });

  it("honours the abort signal before, during and after the delay", async () => {
    const fx = freshStart();
    const req = reqFor(fx);
    const pre = new AbortController();
    pre.abort();
    await expect(new StubFiller().fill(req, pre.signal)).rejects.toSatisfy(isAbortError);

    vi.useFakeTimers();
    const mid = new AbortController();
    const p = new StubFiller({ delayMs: 500 }).fill(req, mid.signal);
    const check = expect(p).rejects.toSatisfy(isAbortError);
    await vi.advanceTimersByTimeAsync(100);
    mid.abort();
    await check;

    const ok = new StubFiller({ delayMs: 500 }).fill(req);
    await vi.advanceTimersByTimeAsync(500);
    expect(await ok).not.toBeNull();
  });

  it("sleep resolves and rejects as expected", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    const c = new AbortController();
    const err = new Error("custom");
    err.name = "AbortError";
    c.abort(err);
    await expect(sleep(10, c.signal)).rejects.toBe(err);
  });
});
