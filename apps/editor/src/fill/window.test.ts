import { describe, expect, it } from "vitest";
import { knightLimits } from "@jump-tables";
import { AUTHOR, TILE, type FillRequest } from "../contracts";
import { canonicalJson, hashRequest } from "../research/hash";
import { LevelModel } from "../level/LevelModel";
import { FIXTURES, freshStart, midStaircase, patrolRightEdge, verticalTower } from "./__fixtures__/states";
import { requestHash, requestHashSync, sha256HexSync, sha256Text } from "./hash";
import { PlacementStream } from "./stream";
import {
  buildFillRequest,
  estimateTokens,
  gridRows,
  inWindow,
  levelSummary,
  levelToWindow,
  placeWindow,
  renderCells,
  windowToLevel,
  zeroMeasure,
  PLACEHOLDER_BRIEF,
  PLACEHOLDER_BRIEF_VERSION,
} from "./window";

/** Everything in the request except the brief, as reviewable text. */
function golden(req: FillRequest): string {
  const { grid, brief, ...rest } = req;
  return `${grid}\n\n--- fields (brief: ${brief.length} chars, ${req.briefVersion}) ---\n${JSON.stringify(rest, null, 1)}\n`;
}

function build(fx: ReturnType<(typeof FIXTURES)[number]>, extra: Parameters<typeof buildFillRequest>[2] = {}) {
  return buildFillRequest(fx.model, fx.stream, {
    now: fx.now,
    mode: fx.mode,
    blockedAt: fx.blockedAt,
    previousFailure: fx.previousFailure,
    lastGhosts: fx.lastGhosts,
    cols: 24,
    rows: 12,
    recentCount: 12,
    historyCount: 5,
    ...extra,
  });
}

describe("golden windows", () => {
  for (const make of FIXTURES) {
    it(`matches the golden window for ${make().name}`, async () => {
      const fx = make();
      const req = build(fx);
      await expect(golden(req)).toMatchFileSnapshot(`./__snapshots__/window-${fx.name}.txt`);
    });
  }

  it("is deterministic: same state, same request and hash", async () => {
    for (const make of FIXTURES) {
      const a = build(make());
      const b = build(make());
      expect(a).toEqual(b);
      expect(await requestHash(a)).toBe(await requestHash(b));
    }
  });
});

describe("window placement", () => {
  it("fresh start: frontier at the floor's end, window shifted toward it", () => {
    const req = build(freshStart());
    // Stroke centre x=13, frontier x=19: centre moves 3 toward the frontier.
    expect(req.origin).toEqual({ x: 4, y: 8 });
    expect(req.size).toEqual({ w: 24, h: 12 });
    // Frontier: rightmost floor column 19, top row 15 -> window-relative.
    expect(req.frontier).toEqual({ x: 15, y: 7, idleMs: 900 });
  });

  it("mid staircase: last stroke, ghost steps and frontier all inside, bias capped", () => {
    const fx = midStaircase();
    const req = build(fx);
    const f = fx.stream.frontier(fx.model, fx.now)!;
    expect(f).toMatchObject({ x: 70, y: 17, direction: "horizontal" });
    expect(inWindow(levelToWindow(f, req), req)).toBe(true);
    for (const e of fx.stream.lastStroke()) expect(inWindow(levelToWindow(e, req), req)).toBe(true);
    for (const x of [50, 51, 52]) expect(inWindow(levelToWindow({ x, y: 15 }, req), req)).toBe(true);
    // Stroke centre 55 shifted by at most a quarter window (6) toward x=70.
    expect(req.origin.x).toBe(55 + 6 - 12);
  });

  it("vertical tower: room above the frontier", () => {
    const fx = verticalTower();
    const req = build(fx);
    expect(fx.stream.direction()).toBe("vertical");
    const top = fx.stream.frontier(fx.model, fx.now)!;
    // The fruit placed on top is the last stroke and the highest placement.
    expect(top).toMatchObject({ x: 103, y: 5 });
    const rel = levelToWindow(top, req);
    expect(rel.y).toBe(4); // ~40% from the top
    expect(inWindow(rel, req)).toBe(true);
  });

  it("patrol: blockedAt ~40% from the left, far side in view", () => {
    const fx = patrolRightEdge();
    const req = build(fx);
    expect(req.origin).toEqual({ x: 185 - 9, y: 8 });
    expect(req.blockedAt).toEqual({ x: 9, y: 7 });
    expect(gridRows(req.grid)[7][22]).toBe("F"); // the far side (flag) is in view
    expect(req.blockedAt).toEqual(levelToWindow(fx.blockedAt!, req));
    expect(req.mode).toBe("patrol");
    expect(req.previousFailure?.stage).toBe("agent");
  });

  it("clamps to small levels and shrinks the window when the level is smaller", () => {
    expect(placeWindow({ levelW: 10, levelH: 6, cols: 24, rows: 12, stroke: [{ x: 5, y: 3 }] })).toEqual({
      x: 0,
      y: 0,
      w: 10,
      h: 6,
    });
    const r = placeWindow({ levelW: 200, levelH: 20, cols: 24, rows: 12, stroke: [{ x: 199, y: 19 }] });
    expect(r).toEqual({ x: 176, y: 8, w: 24, h: 12 });
    const l = placeWindow({ levelW: 200, levelH: 20, cols: 24, rows: 12, stroke: [{ x: 0, y: 0 }] });
    expect(l).toEqual({ x: 0, y: 0, w: 24, h: 12 });
  });

  it("a far frontier: the window follows the stroke, shifted at most a quarter window", () => {
    const r = placeWindow({
      levelW: 200,
      levelH: 20,
      cols: 24,
      rows: 12,
      stroke: [{ x: 80, y: 10 }],
      frontier: { x: 100, y: 10, direction: "horizontal" },
    });
    expect(80 - r.x).toBeGreaterThanOrEqual(2);
    // Centre moved toward the frontier by the cap (a quarter window), no more.
    expect(r.x).toBe(80 + 6 - 12);
  });

  it("uses the level start when nothing has been drawn", () => {
    const model = new LevelModel({ clock: () => 0 });
    const stream = new PlacementStream({ clock: () => 0 });
    const req = buildFillRequest(model, stream, { now: 0 });
    expect(windowToLevel(req.frontier, req)).toEqual(model.start);
    expect(req.recent).toEqual([]);
    expect(req.frontier.idleMs).toBe(0);
  });
});

describe("grid format", () => {
  it("has rulers every column, numbered rows and a legend", () => {
    const req = build(midStaircase());
    const lines = req.grid.split("\n");
    expect(lines[1]).toMatch(/^Legend:/);
    expect(lines[2]).toBe("   000000000011111111112222");
    expect(lines[3]).toBe("   012345678901234567890123");
    const rows = gridRows(req.grid);
    expect(rows).toHaveLength(12);
    for (const r of rows) expect(r).toHaveLength(24);
  });

  it("distinguishes person terrain, accepted-ghost terrain and entities", () => {
    const fx = midStaircase();
    const req = build(fx);
    const rows = gridRows(req.grid);
    const at = (x: number, y: number) => {
      const p = levelToWindow({ x, y }, req);
      return rows[p.y][p.x];
    };
    expect(at(60, 17)).toBe("D"); // person dirt
    expect(at(50, 16)).toBe("g"); // ghost grass
    expect(fx.model.authorAt(50, 16)).toBe(AUTHOR.GHOST);
    expect(at(55, 13)).toBe("G"); // person grass
    expect(at(52, 13)).toBe("o"); // coin (accepted with the ghost steps)
    expect(at(62, 16)).toBe("S"); // slime
    expect(at(60, 16)).toBe("~"); // its patrol span
    expect(req.grid).toMatch(/Enemies: slime \(\d+,\d+\) patrols x \d+\.\.\d+\./);
  });

  it("marks the start, flag, sign and ultraslime", () => {
    const fx = patrolRightEdge();
    const rows = renderCells(fx.model, { x: 176, y: 8, w: 24, h: 12 }).join("\n");
    expect(rows).toContain("F");
    expect(rows).toContain("!");
    expect(rows).toContain("U");
    expect(rows).toContain("Q");
    const fresh = freshStart();
    expect(renderCells(fresh.model, { x: 0, y: 8, w: 24, h: 12 })[6][2]).toBe("@");
  });

  it("renders a level smaller than the window without out-of-level cells", () => {
    const m = new LevelModel({ w: 8, h: 5, clock: () => 0 });
    m.paintTile(3, 4, TILE.GRASS);
    m.setStart({ x: 3, y: 3 });
    expect(renderCells(m, { x: 0, y: 0, w: 8, h: 5 })).toEqual(["........", "........", "........", "...@....", "...G...."]);
    const req = buildFillRequest(m, new PlacementStream({ clock: () => 0 }), { now: 0, cols: 24, rows: 12 });
    expect(req.size).toEqual({ w: 8, h: 5 });
    expect(req.origin).toEqual({ x: 0, y: 0 });
    expect(gridRows(req.grid)).toEqual(["........", "........", "........", "...@....", "...G...."]);
    expect(req.grid).not.toContain("/");
  });
});

describe("summary", () => {
  it("describes what lies outside the window", () => {
    const fx = midStaircase();
    const req = build(fx);
    expect(req.summary).toMatch(/^Level 200x20/);
    expect(req.summary).toContain("start ");
    expect(req.summary).toContain("no flag yet");
    const s = levelSummary(fx.model, { x: 60, y: 8, w: 24, h: 12 });
    expect(s).toMatch(/left of window: \d+ tiles \(3 Ghost\), 3 coins\/fruit/);
  });

  it("can be left out", () => {
    const req = build(midStaircase(), { summary: false });
    expect(req.summary).toBeUndefined();
  });
});

describe("request fields", () => {
  it("carries recent placements window-relative with dt", () => {
    const fx = midStaircase();
    const req = build(fx);
    const last = req.recent[req.recent.length - 1];
    expect(windowToLevel(last, req)).toEqual({ x: 56, y: 12 });
    expect(last).toMatchObject({ dt: 120, tile: "grass", tool: "paint" });
    expect(req.recent.length).toBeLessThanOrEqual(12);
  });

  it("uses jump-table knight limits, zero measures and the placeholder brief by default", () => {
    const req = build(freshStart());
    expect(req.knight).toEqual(knightLimits());
    expect(req.measured).toEqual(zeroMeasure(null as never, { x: 0, y: 0, w: 1, h: 1 }));
    expect(req.brief).toBe(PLACEHOLDER_BRIEF);
    expect(req.briefVersion).toBe(PLACEHOLDER_BRIEF_VERSION);
    expect(req.mode).toBe("auto");
  });

  it("passes the measured rect to an injected measure function", () => {
    const fx = midStaircase();
    let seen: unknown;
    const req = build(fx, {
      measure: (_m, rect) => {
        seen = rect;
        return { density: 0.5, gapHist: [1, 0, 0, 0, 0], verticality: 0.1, rewardSpacing: 3, pressure: 0 };
      },
    });
    expect(seen).toEqual({ ...req.origin, ...req.size });
    expect(req.measured.density).toBe(0.5);
  });

  it("keeps only the last historyCount ghosts", () => {
    const ghosts = Array.from({ length: 8 }, (_, i) => ({ kind: "extend" as const, label: `g${i}`, outcome: "esc" as const }));
    expect(build(freshStart(), { lastGhosts: ghosts, historyCount: 5 }).lastGhosts.map((g) => g.label)).toEqual([
      "g3",
      "g4",
      "g5",
      "g6",
      "g7",
    ]);
    expect(build(freshStart(), { lastGhosts: ghosts, historyCount: 0 }).lastGhosts).toEqual([]);
  });

  it("stays under 1,300 tokens (~4 chars/token) with a 2,000-char brief", () => {
    const brief = "x".repeat(2000);
    for (const make of FIXTURES) {
      const req = build(make(), { brief, briefVersion: "test" });
      const tokens = estimateTokens(canonicalJson(req));
      expect(tokens, make().name).toBeLessThan(1300);
    }
  });
});

describe("coordinates", () => {
  it("round-trips window <-> level for every cell of every fixture window", () => {
    for (const make of FIXTURES) {
      const req = build(make());
      for (let y = 0; y < req.size.h; y++)
        for (let x = 0; x < req.size.w; x++) {
          const lv = windowToLevel({ x, y }, req);
          expect(lv.x).toBeGreaterThanOrEqual(0);
          expect(lv.x).toBeLessThan(200);
          expect(lv.y).toBeGreaterThanOrEqual(0);
          expect(lv.y).toBeLessThan(20);
          expect(levelToWindow(lv, req)).toEqual({ x, y });
          expect(levelToWindow(lv, req.origin)).toEqual({ x, y });
        }
    }
  });

  it("the grid glyph at a window cell matches the level cell", () => {
    const fx = midStaircase();
    const req = build(fx);
    const rows = gridRows(req.grid);
    for (let y = 0; y < req.size.h; y++)
      for (let x = 0; x < req.size.w; x++) {
        const lv = windowToLevel({ x, y }, req);
        const solid = fx.model.isSolid(lv.x, lv.y);
        expect(/[GDBHQgdbhq]/.test(rows[y][x])).toBe(solid);
      }
  });

  it("inWindow rejects fractional and out-of-range cells", () => {
    const req = { size: { w: 24, h: 12 } };
    expect(inWindow({ x: 0, y: 0 }, req)).toBe(true);
    expect(inWindow({ x: 23, y: 11 }, req)).toBe(true);
    expect(inWindow({ x: 24, y: 0 }, req)).toBe(false);
    expect(inWindow({ x: -1, y: 0 }, req)).toBe(false);
    expect(inWindow({ x: 1.5, y: 0 }, req)).toBe(false);
  });
});

describe("requestHash", () => {
  it("matches known SHA-256 vectors in the pure-JS path", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sha256HexSync(enc(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexSync(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256HexSync(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    // Multi-block and non-ASCII input agree with WebCrypto.
  });

  it("WebCrypto and the JS fallback agree (so Node and browsers agree)", async () => {
    for (const s of ["", "é—🙂", "a".repeat(55), "a".repeat(56), "a".repeat(64), "b".repeat(1000)]) {
      expect(await sha256Text(s, { forceFallback: true })).toBe(await sha256Text(s));
    }
    for (const make of FIXTURES) {
      const req = build(make());
      const a = await requestHash(req);
      expect(await requestHash(req, { forceFallback: true })).toBe(a);
      expect(requestHashSync(req)).toBe(a);
      expect(await hashRequest(req)).toBe(a); // same as the proxy's
    }
  });

  it("ignores key order and undefined members, changes with content", async () => {
    const req = build(freshStart());
    const shuffled = Object.fromEntries(Object.entries(req).reverse()) as FillRequest;
    expect(await requestHash(shuffled)).toBe(await requestHash(req));
    expect(await requestHash({ ...req, summary: undefined, blockedAt: undefined })).toBe(
      await requestHash({ ...req, summary: undefined }),
    );
    expect(await requestHash({ ...req, mode: "requested" })).not.toBe(await requestHash(req));
  });
});
