/**
 * The playtest agent on the audit's validation fixtures, plus the additions
 * over the prototype: goals, the column window, caps, the resumable stepper.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../apps/editor/src/suggest/config";
import { FIXTURES, flatLevel, gapLevel, staircaseLevel, tunnelLevel, wallLevel } from "./fixtures";
import { gridFromMatrix, type SolidGrid } from "./grid";
import {
  AgentSearch,
  BH,
  bodyCell,
  frame,
  Level,
  replay,
  replayPath,
  search,
  spawnBody,
  T,
  type SearchResult,
} from "./sim";

/** Generous cap for "prove it" tests (impossible verdicts need exhaustion). */
const PROVE = { capMs: 60_000 };

function endsInGoal(grid: SolidGrid, r: SearchResult, goalX: number): void {
  expect(r.found).toBe(true);
  expect(r.inputs!.length).toBe(r.frames);
  const tr = replay(grid, r.start, r.inputs!);
  const last = tr[tr.length - 1];
  expect(last[4]).toBe(1); // standing
  expect(bodyCell({ x: last[0], y: last[1] }).x).toBeGreaterThanOrEqual(goalX);
  // The tile path is the replay's centre cells.
  expect(r.path).toEqual(replayPath(grid, r.start, r.inputs!));
  expect(r.path[0]).toEqual(r.start);
}

describe("physics primitives", () => {
  it("spawns standing centred in the cell and stays put with no input", () => {
    const L = new Level(flatLevel(8));
    const b = spawnBody(2, 7, L);
    expect(b.x).toBe(2 * T + 3);
    expect(b.y + BH).toBe(8 * T);
    for (let i = 0; i < 30; i++) frame(L, b, 0, false);
    expect(b.down).toBe(true);
    expect(b.y + BH).toBe(8 * T);
    expect(bodyCell(b)).toEqual({ x: 2, y: 7 });
  });

  it("falls under gravity when nothing is below and lands on the floor", () => {
    const L = new Level(flatLevel(8));
    const b = spawnBody(2, 2, L);
    expect(b.down).toBe(false);
    for (let i = 0; i < 60; i++) frame(L, b, 0, false);
    expect(b.down).toBe(true);
    expect(bodyCell(b)).toEqual({ x: 2, y: 7 });
  });

  it("a wall stops the body and sets blocked.right", () => {
    const L = new Level(wallLevel(3, 1, 5, 10));
    const b = spawnBody(2, 7, L);
    let hit = false;
    for (let i = 0; i < 60; i++) {
      frame(L, b, 1, false);
      hit ||= b.right;
    }
    expect(hit).toBe(true);
    expect(b.x + 10).toBeLessThanOrEqual(5 * T + 1e-9);
  });
});

describe("agent on the audit's validation fixtures", () => {
  for (const f of FIXTURES) {
    it(`${f.name}: ${f.beatable ? "beatable" : "impossible"}`, () => {
      const r = search(f.grid, f.from, f.to, PROVE);
      expect(r.found).toBe(f.beatable);
      expect(r.timedOut).toBe(false);
      if (f.beatable) endsInGoal(f.grid, r, f.grid.w - 1);
      else {
        expect(r.exhausted).toBe(true);
        expect(r.path).toEqual([]);
        expect(r.inputs).toBeUndefined();
      }
    }, 60_000);
  }

  it("beatable fixtures verify well under the suggestion cap (plan: < 100 ms)", () => {
    for (const f of FIXTURES.filter((x) => x.beatable)) {
      const r = search(f.grid, f.from, f.to, { capMs: DEFAULT_CONFIG.agentCapMs });
      expect(r.found, f.name).toBe(true);
      expect(r.ms, f.name).toBeLessThan(DEFAULT_CONFIG.agentCapMs);
    }
  });

  it("reports how far it got on a wall too tall to climb", () => {
    const g = wallLevel(7);
    const r = search(g, { x: 0, y: 7 }, { x0: g.w - 1 }, PROVE);
    expect(r.found).toBe(false);
    expect(r.blockedAt).toEqual({ x: 7, y: 7 });
  });

  it("is deterministic", () => {
    const g = staircaseLevel();
    const a = search(g, { x: 0, y: 7 }, { x0: g.w - 1 });
    const b = search(g, { x: 0, y: 7 }, { x0: g.w - 1 });
    expect(a.inputs).toEqual(b.inputs);
    expect(a.nodes).toBe(b.nodes);
  });
});

describe("goals", () => {
  it("reaches an exact cell on a raised ledge", () => {
    const g = gapLevel(2, 3, 2); // landing 2 rows up
    const goal = { x: g.w - 2, y: 5 };
    const r = search(g, { x: 0, y: 7 }, goal);
    expect(r.found).toBe(true);
    expect(r.path[r.path.length - 1]).toEqual(goal);
  });

  it("accepts a predicate goal with a column hint", () => {
    const g = flatLevel(20);
    const r = search(g, { x: 0, y: 7 }, ({ x, y }) => x === 15 && y === 7, { hint: { x: 15, y: 7 } });
    expect(r.found).toBe(true);
    expect(r.path[r.path.length - 1]).toEqual({ x: 15, y: 7 });
  });

  it("can go left", () => {
    const g = gapLevel(0, 6);
    const r = search(g, { x: g.w - 1, y: 7 }, { x: 0, y: 7 });
    expect(r.found).toBe(true);
  });

  it("an airborne goal cell never counts (the knight must stand there)", () => {
    const g = flatLevel(10);
    const r = search(g, { x: 0, y: 7 }, { x: 5, y: 4 }, { capMs: 2000 });
    expect(r.found).toBe(false);
  });
});

/** A 200 x 20 level: flat ground at row 16 with pits and steps along it. */
function bigLevel(): SolidGrid {
  const W = 200;
  const H = 20;
  const m = Array.from({ length: H }, () => Array<number>(W).fill(0));
  const col = (x: number, top: number) => {
    for (let y = top; y < H; y++) m[y][x] = 1;
  };
  for (let x = 0; x < W; x++) col(x, 16);
  const pit = (x0: number, n: number) => {
    for (let x = x0; x < x0 + n; x++) for (let y = 0; y < H; y++) m[y][x] = 0;
  };
  pit(30, 4);
  pit(60, 9); // beatable with run-up
  for (let x = 80; x < 84; x++) col(x, 14); // a step up
  pit(120, 14); // impossible
  return gridFromMatrix(m);
}

describe("bounded window (verifying one suggestion)", () => {
  const big = bigLevel();
  const L = new Level(big);

  it("verifies a 24-wide window of a 200-wide level under the cap", () => {
    const cap = DEFAULT_CONFIG.agentCapMs;
    for (const [x0, x1] of [
      [22, 45],
      [52, 75],
      [70, 93],
    ]) {
      const r = search(L, { x: x0, y: 15 }, { x: x1, y: 15 }, { capMs: cap, xRange: [x0, x1] });
      expect(r.found, `${x0}..${x1}`).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.ms).toBeLessThan(cap);
      // Never left the window.
      for (const s of replay(L, r.start, r.inputs!)) {
        expect(s[0]).toBeGreaterThanOrEqual(x0 * T);
        expect(s[0] + 10).toBeLessThanOrEqual((x1 + 1) * T);
      }
    }
  });

  it("an impossible window fails within the cap (over cap counts as a fail)", () => {
    const cap = DEFAULT_CONFIG.agentCapMs;
    const r = search(L, { x: 110, y: 15 }, { x: 133, y: 15 }, { capMs: cap, xRange: [110, 133] });
    expect(r.found).toBe(false);
    expect(r.ms).toBeLessThan(cap + 50);
    // The furthest standing body overhangs the ledge edge (column 119) by up to 5 px.
    expect(r.blockedAt!.x).toBeLessThanOrEqual(120);
  });

  it("the window really prunes: a run-up from outside it is not available", () => {
    const g = gapLevel(7, 12);
    const open = search(g, { x: 7, y: 7 }, { x0: g.w - 1 }, PROVE);
    expect(open.found).toBe(true); // backs up left for a run-up, then jumps
    const boxed = search(g, { x: 7, y: 7 }, { x0: g.w - 1 }, { ...PROVE, xRange: [7, g.w - 1] });
    expect(boxed.found).toBe(false);
    expect(boxed.exhausted).toBe(true);
  }, 60_000);

  it("the window always contains the start and a cell goal", () => {
    const g = flatLevel(30);
    const r = search(g, { x: 2, y: 7 }, { x: 20, y: 7 }, { xRange: [10, 15] });
    expect(r.found).toBe(true);
  });
});

describe("caps and stepping", () => {
  it("maxNodes stops the search as timedOut, not exhausted", () => {
    const g = gapLevel(7, 13);
    const r = search(g, { x: 0, y: 7 }, { x0: g.w - 1 }, { maxNodes: 500, capMs: 60_000 });
    expect(r.found).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exhausted).toBe(false);
    expect(r.nodes).toBeLessThanOrEqual(501);
  });

  it("capMs stops the search using the injected clock", () => {
    let t = 0;
    const g = gapLevel(7, 13);
    const r = search(g, { x: 0, y: 7 }, { x0: g.w - 1 }, { capMs: 100, now: () => (t += 1) });
    expect(r.found).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(100);
  });

  it("AgentSearch.run(slice) resumes to the same verdict", () => {
    const g = tunnelLevel(5, 3);
    const whole = search(g, { x: 0, y: 7 }, { x0: g.w - 1 });
    let t = 0;
    const s = new AgentSearch(g, { x: 0, y: 7 }, { x0: g.w - 1 }, { now: () => (t += 0.03), capMs: 1e9 });
    let r: SearchResult | null = null;
    let slices = 0;
    while (!r) {
      r = s.run(0.05);
      slices++;
    }
    expect(slices).toBeGreaterThan(1);
    expect(r.found).toBe(true);
    expect(r.inputs).toEqual(whole.inputs);
    expect(s.done).toBe(r);
  });

  it("can start from a mid-air body", () => {
    const g = gapLevel(0, 4);
    const r = search(g, { x: 2, y: 3 }, { x0: g.w - 1 }, { startBody: { x: 2 * T + 3, y: 3 * T, vx: 200 } });
    expect(r.found).toBe(true);
  });
});
