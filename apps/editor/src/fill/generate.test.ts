import { afterAll, describe, expect, it } from "vitest";
import { AgentClient, checkRules, search } from "@physsim";
import { AUTHOR, TILE, type Filler, type FillRequest, type Suggestion } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { solidGridOf } from "../verify/merge";
import { AlgoFiller } from "./AlgoFiller";
import { FillerRegistry } from "./Filler";
import { generateLevel, generationRequest, installGenerateHook, reachableFrontier } from "./generate";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());
const ALGO_CFG = { kinds: { finish: true, extend: true, fix: true }, pauseMs: 800 };

function startLevel(): LevelModel {
  const m = new LevelModel({ clock: () => 0 });
  const cells = [];
  for (let x = 0; x <= 8; x++) cells.push({ x, y: 15, tile: TILE.GRASS }, { x, y: 16, tile: TILE.DIRT });
  m.paint(cells);
  return m;
}

/** A filler that replays a list of behaviours, recording the requests. */
class ScriptFiller implements Filler {
  readonly name = "stub" as const;
  readonly requests: FillRequest[] = [];
  constructor(private readonly script: ((req: FillRequest) => Suggestion | null)[]) {}
  async fill(req: FillRequest): Promise<Suggestion | null> {
    this.requests.push(req);
    const step = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    return step(req);
  }
}

const sugg = (adds: Suggestion["adds"], label = "piece"): Suggestion => ({
  id: `s-${Math.random().toString(36).slice(2)}`,
  kind: "extend",
  adds,
  removes: [],
  entities: [],
  confidence: 0.5,
  label,
  anchor: { x: adds[0]?.x ?? 0, y: adds[0]?.y ?? 0 },
  requestHash: "h",
  filler: "stub",
  latencyMs: 0,
  mode: "requested",
  verified: false,
  attempts: 1,
});

/** Flat floor continuing from the frontier (level coordinates). */
const floorFrom = (req: FillRequest, n: number) => {
  const fx = req.origin.x + req.frontier.x;
  const fy = req.origin.y + req.frontier.y;
  return Array.from({ length: n }, (_, i) => ({ x: fx + 1 + i, y: fy, tile: TILE.GRASS as Suggestion["adds"][number]["tile"] }));
};

describe("reachableFrontier / generationRequest", () => {
  it("finds the rightmost reachable standing cell and frames it a quarter into the window", () => {
    const m = startLevel();
    const f = reachableFrontier(solidGridOf(m.snapshot()), m.start)!;
    expect(f).toEqual({ x: 8, y: 14 });
    const req = generationRequest(m, f, { cols: 24, rows: 12 });
    expect(req.origin).toEqual({ x: 2, y: 7 });
    expect(req.frontier).toMatchObject({ x: 6, y: 8 });
    expect(req.mode).toBe("requested");
    expect(req.recent).toEqual([]);
    expect(req.grid).toContain("Window 24x12");
  });
});

describe("generateLevel with the AlgoFiller", () => {
  it("generates three screens of verified, beatable level and leaves the input untouched", async () => {
    const m = startLevel();
    const before = m.snapshot();
    const r = await generateLevel(m, new AlgoFiller({ config: ALGO_CFG, seed: 3 }), { agent, screens: 3, cols: 24, rows: 12 });
    expect(m.snapshot()).toEqual(before);
    expect(r.stopped).toBe("done");
    expect(r.filler).toBe("algo");
    expect(r.frontierX).toBeGreaterThanOrEqual(8 + 72);
    expect(r.pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of r.pieces) {
      expect(p.verdict?.ok).toBe(true);
      expect(p.toX).toBeGreaterThan(p.fromX);
    }
    // Generated cells are authored by Ghost; the seed floor stays the person's.
    const s = r.snapshot;
    expect(s.authors[15 * s.w + 3]).toBe(AUTHOR.PERSON);
    expect(s.authors.some((a) => a === AUTHOR.GHOST)).toBe(true);
    // The goal is on the far end and the rule check gets there from the start.
    expect(r.goal).toBeDefined();
    expect(s.goal).toEqual(r.goal);
    const grid = solidGridOf(s);
    expect(checkRules(grid, s.start, r.goal!).ok).toBe(true);
    // The physics agent beats the whole generated stretch too.
    const run = search(grid, s.start, { x0: r.goal!.x, x1: r.goal!.x }, { capMs: 5000, xRange: [0, r.goal!.x + 2] });
    expect(run.found).toBe(true);
  });

  it("fills a whole empty level from the start floor it lays itself", async () => {
    const m = new LevelModel({ clock: () => 0 });
    const r = await generateLevel(m, new AlgoFiller({ config: ALGO_CFG }), { agent });
    if (r.stopped !== "done") console.log(JSON.stringify(r.failures), r.frontierX, r.pieces.map((p) => p.suggestion.label));
    expect(r.stopped).toBe("done");
    expect(r.frontierX).toBeGreaterThanOrEqual(m.w - 6);
    expect(checkRules(solidGridOf(r.snapshot), r.snapshot.start, r.goal!).ok).toBe(true);
  }, 30000);

  it("is reproducible for the same seed", async () => {
    const a = await generateLevel(startLevel(), new AlgoFiller({ config: ALGO_CFG, seed: 9 }), { agent, screens: 2 });
    const b = await generateLevel(startLevel(), new AlgoFiller({ config: ALGO_CFG, seed: 9 }), { agent, screens: 2 });
    expect(b.snapshot.cells).toEqual(a.snapshot.cells);
    expect(b.pieces.map((p) => p.suggestion.label)).toEqual(a.pieces.map((p) => p.suggestion.label));
  });
});

describe("generateLevel with any filler", () => {
  it("sends a failed piece back with the verifier's reason, then accepts the fix", async () => {
    const f = new ScriptFiller([
      // 1st: a 14-wide pit and a far ledge: unbeatable.
      (req) => sugg([{ x: req.origin.x + req.frontier.x + 16, y: req.origin.y + req.frontier.y, tile: TILE.GRASS }]),
      (req) => sugg(floorFrom(req, 10)),
    ]);
    const r = await generateLevel(startLevel(), f, { agent, screens: 1, maxPieces: 1 });
    expect(r.pieces).toHaveLength(1);
    expect(r.pieces[0].attempts).toBe(2);
    expect(f.requests[1].previousFailure?.reason).toBeTruthy();
    expect(r.failures[0].stage === "rules" || r.failures[0].stage === "agent" || r.failures[0].stage === "measure").toBe(true);
    expect(r.stopped).toBe("maxPieces");
  });

  it("stops as stuck when the filler never offers anything usable", async () => {
    const f = new ScriptFiller([() => null]);
    const r = await generateLevel(startLevel(), f, { agent, maxAttempts: 3 });
    expect(r.stopped).toBe("stuck");
    expect(f.requests).toHaveLength(3);
    expect(r.failures.map((x) => x.stage)).toEqual(["none", "none", "none"]);
    expect(r.snapshot.cells).toEqual(startLevel().snapshot().cells);
  });

  it("rejects pieces that do not move the frontier", async () => {
    const f = new ScriptFiller([(req) => sugg([{ x: req.origin.x + 1, y: req.origin.y + 1, tile: TILE.BLOCK }])]);
    const r = await generateLevel(startLevel(), f, { agent, maxAttempts: 2 });
    expect(r.stopped).toBe("stuck");
    expect(r.failures.every((x) => x.stage === "progress")).toBe(true);
  });

  it("stops cleanly when aborted", async () => {
    const ac = new AbortController();
    const f = new ScriptFiller([
      (req) => {
        ac.abort();
        return sugg(floorFrom(req, 6));
      },
    ]);
    const r = await generateLevel(startLevel(), f, { agent, signal: ac.signal });
    expect(r.stopped).toBe("aborted");
    expect(r.goal).toBeUndefined();
  });

  it("verify: false only checks progress", async () => {
    const f = new ScriptFiller([(req) => sugg(floorFrom(req, 12))]);
    const r = await generateLevel(startLevel(), f, { verify: false, agent, screens: 1 });
    expect(r.stopped).toBe("done");
    expect(r.pieces.every((p) => p.verdict === null)).toBe(true);
  });
});

describe("installGenerateHook", () => {
  it("exposes generate(filler, options) on a target and can apply the result", async () => {
    const model = startLevel();
    const target: Record<string, unknown> = { model };
    const { generate, uninstall } = installGenerateHook({
      target,
      fillers: new FillerRegistry([new AlgoFiller({ config: ALGO_CFG })]),
    });
    expect(target.generate).toBe(generate);
    const r = await generate("algo", { agent, screens: 1 });
    expect(r.pieces.length).toBeGreaterThan(0);
    expect(model.snapshot().cells).toEqual(startLevel().snapshot().cells);
    await generate("algo", { agent, screens: 1, apply: true });
    expect(model.snapshot().cells).not.toEqual(startLevel().snapshot().cells);
    await expect(generate("llm")).rejects.toThrow(/not registered/);
    uninstall();
    expect(target.generate).toBeUndefined();
  });
});
