import { afterAll, describe, expect, it } from "vitest";
import { AgentClient } from "@physsim";
import { TILE, type FillRequest, type TileId } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { verifyOnce, verifyWithSendBack } from "../verify";
import { FIXTURES, midStaircase, patrolRightEdge, verticalTower } from "./__fixtures__/states";
import {
  ALGO_TIMING,
  AlgoFiller,
  extendConfidence,
  finishConfidence,
  parseWindowGrid,
  similarityToHistory,
  windowSnapshot,
} from "./AlgoFiller";
import { measureRequestWindow } from "./brief";
import { PlacementStream } from "./stream";
import { buildFillRequest } from "./window";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());
const ALL = { kinds: { finish: true, extend: true, fix: true }, pauseMs: 800 };
const EXTEND_ONLY = { kinds: { finish: false, extend: true, fix: true }, pauseMs: 800 };

/** A floor from x 0..x1 at row `y` (with dirt below), drawn earlier; then a short stroke at its end. */
function floorScene(opts: { x1?: number; y?: number; idle?: number; tile?: TileId } = {}) {
  let t = 1000;
  const clock = () => t;
  const model = new LevelModel({ clock });
  const stream = new PlacementStream({ clock, recentCount: 12, pauseMs: 800, longPauseMs: 2500, newStructureTiles: 6 });
  stream.attach(model);
  const x1 = opts.x1 ?? 20;
  const y = opts.y ?? 15;
  const cells = [];
  for (let x = 0; x <= x1; x++) cells.push({ x, y, tile: opts.tile ?? TILE.GRASS }, { x, y: y + 1, tile: TILE.DIRT });
  model.paint(cells);
  t += 2000;
  // One last tile on the floor's end, alone in its stroke (nothing to repeat).
  model.beginStroke();
  model.paint([
    { x: x1 + 1, y, tile: opts.tile ?? TILE.GRASS },
    { x: x1 + 1, y: y + 1, tile: TILE.DIRT },
  ]);
  model.endStroke();
  t += opts.idle ?? 1200;
  return { model, stream, now: t };
}

function request(s: { model: LevelModel; stream: PlacementStream; now: number }, extra: Partial<Parameters<typeof buildFillRequest>[2]> = {}): FillRequest {
  return buildFillRequest(s.model, s.stream, { now: s.now, measure: measureRequestWindow, cols: 24, rows: 12, ...extra });
}

describe("parseWindowGrid", () => {
  it("reads the window back into tiles, entities and blocked cells", () => {
    const f = midStaircase();
    const req = request(f, { lastGhosts: f.lastGhosts });
    const g = parseWindowGrid(req)!;
    expect(g).not.toBeNull();
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) expect(g.tiles[y * g.w + x]).toBe(f.model.tileAt(req.origin.x + x, req.origin.y + y));
    const kinds = g.entities.map((e) => e.kind).sort();
    const inRect = f.model.entitiesInRect(req.origin.x, req.origin.y, req.size.w, req.size.h).map((e) => e.kind).sort();
    expect(kinds).toEqual(inRect);
    expect(kinds).toContain("slime");
    expect(parseWindowGrid({ grid: "nonsense", size: { w: 24, h: 12 } })).toBeNull();
  });
});

describe("timing rule", () => {
  it("repeat of 3 -> 0.85, weak repeat lower, stale scaled down", () => {
    expect(finishConfidence({ repeats: 3, open: false, touchesLast: true })).toBe(0.85);
    expect(finishConfidence({ repeats: 2, open: false, touchesLast: true })).toBe(ALGO_TIMING.weakRepeatConfidence);
    expect(finishConfidence({ repeats: 2, open: true, touchesLast: true })).toBe(ALGO_TIMING.openConfidence);
    expect(finishConfidence({ repeats: 5, open: false, touchesLast: false })).toBeCloseTo(0.85 * ALGO_TIMING.staleFactor, 2);
  });

  it("pause at the frontier -> 0.5, still drawing -> lower, requested -> at least 0.5", () => {
    const base = { recent: [{ dt: 100, x: 10, y: 5, tile: "grass", tool: "paint" as const }], mode: "auto" as const };
    expect(extendConfidence({ ...base, frontier: { x: 11, y: 5, idleMs: 900 } }, 800)).toBe(0.5);
    expect(extendConfidence({ ...base, frontier: { x: 11, y: 5, idleMs: 100 } }, 800)).toBe(ALGO_TIMING.busyConfidence);
    expect(extendConfidence({ ...base, frontier: { x: 20, y: 5, idleMs: 900 } }, 800)).toBe(ALGO_TIMING.busyConfidence);
    expect(extendConfidence({ ...base, mode: "requested", frontier: { x: 20, y: 5, idleMs: 0 } }, 800)).toBe(0.5);
  });
});

describe("AlgoFiller on the fixture requests (end to end through the verifier)", () => {
  it.each(FIXTURES.map((mk) => [mk.name, mk] as const))("%s", async (_n, mk) => {
    const f = mk();
    const req = request(f, { mode: f.mode, lastGhosts: f.lastGhosts, blockedAt: f.blockedAt, previousFailure: f.previousFailure });
    const filler = new AlgoFiller({ config: ALL });
    const s = await filler.fill(req);
    if (f.mode === "patrol") {
      expect(s).toBeNull();
      return;
    }
    expect(s).not.toBeNull();
    expect(s!.filler).toBe("algo");
    expect(s!.verified).toBe(false);
    expect(s!.confidence).toBeGreaterThan(0);
    expect(s!.confidence).toBeLessThanOrEqual(1);
    // Adds land on empty cells inside the window.
    for (const a of s!.adds) {
      expect(f.model.tileAt(a.x, a.y)).toBe(0);
      expect(a.x - req.origin.x).toBeGreaterThanOrEqual(0);
      expect(a.x - req.origin.x).toBeLessThan(req.size.w);
    }
    const v = await verifyOnce(f.model, s!, { agent, validate: { lastGhosts: f.lastGhosts } });
    expect(v.ok, v.reason).toBe(true);
  });

  it("mid-staircase: finishes the staircase the person is drawing", async () => {
    const f = midStaircase();
    const filler = new AlgoFiller({ config: ALL });
    const s = (await filler.fill(request(f, { lastGhosts: f.lastGhosts })))!;
    expect(s.kind).toBe("finish");
    expect(s.adds.map((a) => [a.x, a.y])).toEqual([[57, 11], [58, 10], [59, 9]]);
    expect(s.adds.every((a) => a.tile === TILE.GRASS)).toBe(true);
    expect(s.entities).toEqual([{ kind: "coin", x: 59, y: 8 }]);
    expect(filler.lastProposal?.finish?.pattern).toBe("staircase");
  });

  it("vertical tower: continues the zig-zag of half blocks", async () => {
    const f = verticalTower();
    const filler = new AlgoFiller({ config: ALL });
    const s = (await filler.fill(request(f, { mode: f.mode })))!;
    expect(filler.lastProposal?.finish?.pattern).toBe("zigzag");
    expect(s.adds.map((a) => [a.x, a.y])).toEqual([[100, 4], [101, 4], [102, 2], [103, 2]]);
    expect(s.adds.every((a) => a.tile === TILE.GRASS_HALF)).toBe(true);
  });

  it("patrol requests are declined", () => {
    const f = patrolRightEdge();
    const filler = new AlgoFiller({ config: ALL });
    const p = filler.propose(request(f, { mode: "patrol", blockedAt: f.blockedAt }));
    expect(p.source).toBe("none");
    expect(p.answer.act).toBe(false);
  });
});

describe("AlgoFiller Extend", () => {
  it("extends from the frontier with a rule-checked chunk that the verifier accepts", async () => {
    const scene = floorScene();
    const req = request(scene);
    const filler = new AlgoFiller({ config: EXTEND_ONLY });
    const s = (await filler.fill(req))!;
    expect(s.kind).toBe("extend");
    expect(s.label).toMatch(/^extend: /);
    expect(s.confidence).toBe(0.5); // paused at the frontier
    const fx = req.origin.x + req.frontier.x;
    expect(s.adds.every((a) => a.x > fx)).toBe(true);
    // Ground continues in the person's tiles: grass on top, dirt below.
    expect(s.adds.some((a) => a.tile === TILE.GRASS)).toBe(true);
    expect(s.adds.some((a) => a.tile === TILE.DIRT)).toBe(true);
    expect(filler.lastProposal!.valid).toBeGreaterThan(0);
    expect(filler.lastProposal!.ms).toBeLessThan(200);
    const v = await verifyOnce(scene.model, s, { agent });
    expect(v.ok, v.reason).toBe(true);
  });

  it("pre-validates on the window and prefers answers the validator accepts", () => {
    const req = request(floorScene());
    const on = new AlgoFiller({ config: EXTEND_ONLY }).propose(req);
    expect(on.prevalidated).toBe(true);
    const off = new AlgoFiller({ config: EXTEND_ONLY, prevalidate: false }).propose(req);
    expect(off.prevalidated).toBeUndefined();
    const g = parseWindowGrid(req)!;
    const snap = windowSnapshot(g, req);
    expect(snap.w).toBe(req.size.w);
    expect(snap.cells.filter(Boolean).length).toBe(g.solid.reduce((a, b) => a + b, 0));
    expect(snap.start).toEqual({ x: req.frontier.x, y: req.frontier.y - 1 });
  });

  it("while still drawing the confidence is lower", async () => {
    const s = (await new AlgoFiller({ config: EXTEND_ONLY }).fill(request(floorScene({ idle: 100 }))))!;
    expect(s.confidence).toBe(ALGO_TIMING.busyConfidence);
  });

  it("is deterministic per request and moves on when asked again (send-back / repeat)", () => {
    const req = request(floorScene());
    const a = new AlgoFiller({ config: EXTEND_ONLY }).propose(req);
    const b = new AlgoFiller({ config: EXTEND_ONLY }).propose(req);
    expect(b.answer).toEqual(a.answer);
    const f = new AlgoFiller({ config: EXTEND_ONLY });
    const first = f.propose(req);
    const second = f.propose({ ...req, previousFailure: { reason: "too hard", stage: "agent" } });
    expect(second.attempt).toBe(1);
    expect(second.answer).not.toEqual(first.answer);
  });

  it("picks the candidate least like the recent ghosts", () => {
    const req = request(floorScene());
    const first = new AlgoFiller({ config: EXTEND_ONLY }).propose(req);
    const tags = first.chunk ? first.answer.label : "";
    const history = [
      { kind: "extend" as const, label: tags, outcome: "esc" as const, patterns: [] },
      { kind: "extend" as const, label: tags, outcome: "esc" as const, patterns: [] },
    ];
    const next = new AlgoFiller({ config: EXTEND_ONLY }).propose({ ...req, lastGhosts: history });
    expect(next.answer.label).not.toBe(first.answer.label);
    expect(similarityToHistory([], next.answer.label, history)).toBeLessThan(similarityToHistory([], first.answer.label, history));
  });

  it("declines when there is no room to the right of the frontier", () => {
    const scene = floorScene({ x1: 196 });
    const p = new AlgoFiller({ config: EXTEND_ONLY }).propose(request(scene));
    expect(p.source).toBe("none");
    expect(p.answer.act).toBe(false);
  });

  it("every extend over many seeds and floor heights is beatable for the agent", async () => {
    let checked = 0;
    for (const y of [9, 12, 15, 17]) {
      const scene = floorScene({ y, x1: 30 });
      const req = request(scene);
      for (let seed = 0; seed < 6; seed++) {
        const s = await new AlgoFiller({ seed, config: EXTEND_ONLY }).fill(req);
        expect(s, `y ${y} seed ${seed}`).not.toBeNull();
        const v = await verifyOnce(scene.model, s!, { agent });
        expect(v.ok, `y ${y} seed ${seed}: ${v.reason}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(24);
  });

  it("runs through the send-back pipeline like any filler", async () => {
    const scene = floorScene();
    const req = request(scene);
    const filler = new AlgoFiller({ config: EXTEND_ONLY });
    const first = await filler.fill(req);
    const out = await verifyWithSendBack(scene.model, req, first, filler, { agent, config: { agentCapMs: 300, sendBackIfUnderMs: 500 } });
    expect(out.verified).not.toBeNull();
    expect(out.verified!.filler).toBe("algo");
  });
});

describe("AlgoFiller contract", () => {
  it("rejects with AbortError on an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new AlgoFiller({ config: ALL }).fill(request(floorScene()), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("respects disabled kinds", () => {
    const f = midStaircase();
    const p = new AlgoFiller({ config: { kinds: { finish: false, extend: false, fix: true }, pauseMs: 800 } }).propose(request(f));
    expect(p.source).toBe("none");
  });
});
