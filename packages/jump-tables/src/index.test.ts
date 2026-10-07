import { describe, expect, it } from "vitest";
import {
  maxStepUpTiles,
  movementFacts,
  reachableFrontier,
} from "../../../apps/editor/src/player/movementCapabilities";
import {
  latitudeForGap,
  solveJump,
} from "../../../apps/editor/src/player/jumpSolver";
import { LEVEL_H, type KnightLimits } from "../../../apps/editor/src/contracts";
import {
  arcCells,
  arcCoins,
  arcFor,
  arcSweep,
  arcTableText,
  canJump,
  canReach,
  DESIGN_TIER,
  FULL_RUNWAY,
  impossibleGap,
  knightLimits,
  maxGap,
  maxGapRaw,
  TABLES,
  TIERS,
} from "./index";

describe("knightLimits", () => {
  it("returns a contracts.KnightLimits for the design tier", () => {
    const k: KnightLimits = knightLimits();
    expect(DESIGN_TIER).toBe("NORMAL");
    expect(k).toEqual({ maxGapStand: 8, maxGapRun: 11, maxRise: 6 });
  });

  it("agrees with the fork's movementFacts for every tier", () => {
    for (const tier of TIERS) {
      const f = movementFacts(tier);
      const k = knightLimits(tier);
      expect(k.maxGapStand, tier).toBe(f.standingGapTiles);
      expect(k.maxGapRun, tier).toBe(f.maxGapTiles);
      expect(k.maxRise, tier).toBe(maxStepUpTiles(tier));
    }
  });

  it("is monotone in tier", () => {
    for (let i = 1; i < TIERS.length; i++) {
      const a = knightLimits(TIERS[i - 1]);
      const b = knightLimits(TIERS[i]);
      expect(b.maxGapStand).toBeGreaterThanOrEqual(a.maxGapStand);
      expect(b.maxGapRun).toBeGreaterThanOrEqual(a.maxGapRun);
      expect(b.maxRise).toBeGreaterThanOrEqual(a.maxRise);
    }
  });

  it("returns a fresh object (callers may mutate it)", () => {
    const a = knightLimits();
    a.maxGapRun = 99;
    expect(knightLimits().maxGapRun).toBe(11);
  });
});

describe("maxGap / canReach", () => {
  const k = knightLimits();

  it("flat ground matches the limits", () => {
    expect(maxGap(0, false)).toBe(k.maxGapStand);
    expect(maxGap(0, true)).toBe(k.maxGapRun);
    expect(maxGap(0)).toBe(k.maxGapRun); // runUp defaults to true
    expect(canReach(k.maxGapRun, 0)).toBe(true);
    expect(canReach(k.maxGapRun + 1, 0)).toBe(false);
    expect(canReach(k.maxGapStand, 0, false)).toBe(true);
    expect(canReach(k.maxGapStand + 1, 0, false)).toBe(false);
  });

  it("uses y-down dy: negative is a rise", () => {
    expect(maxGap(-3)).toBeLessThan(maxGap(0));
    expect(maxGap(3)).toBeGreaterThan(maxGap(0));
    expect(canReach(1, -k.maxRise)).toBe(true);
    expect(canReach(0, -(k.maxRise + 1))).toBe(false);
    expect(maxGap(-(k.maxRise + 1))).toBe(-1);
  });

  it("matches the fork's reachable frontier at the rungs it samples", () => {
    for (const runway of [0, 2, 7]) {
      for (const t of reachableFrontier(runway, DESIGN_TIER)) {
        // The table is the minimum over this and longer run-ups, so it may
        // only be at or below the raw frontier, and by at most one tile.
        const ours = maxGap(-t.deltaYTiles, runway);
        expect(ours).toBeLessThanOrEqual(t.gapTiles);
        expect(ours).toBeGreaterThanOrEqual(t.gapTiles - 1);
      }
    }
  });

  it("every gap it allows has real timing slack in the solver at that run-up", () => {
    for (const runway of [0, 1, 4, FULL_RUNWAY]) {
      for (let dy = -k.maxRise; dy <= 8; dy++) {
        const g = maxGap(dy, runway);
        if (g < 1) continue;
        const ms = latitudeForGap({ runwayTiles: runway, deltaYTiles: -dy }, g);
        expect(ms, `runway ${runway} dy ${dy} gap ${g}`).toBeGreaterThan(0);
      }
    }
  });

  it("is monotone in run-up and in tier", () => {
    for (let dy = TABLES.dyMin; dy <= TABLES.dyMax; dy++) {
      for (let r = 1; r <= FULL_RUNWAY; r++) {
        for (const tier of TIERS) {
          expect(maxGap(dy, r, tier)).toBeGreaterThanOrEqual(
            maxGap(dy, r - 1, tier),
          );
        }
      }
      for (let i = 1; i < TIERS.length; i++) {
        expect(maxGap(dy, true, TIERS[i])).toBeGreaterThanOrEqual(
          maxGap(dy, true, TIERS[i - 1]),
        );
      }
    }
  });

  it("deeper drops never reach less (within a tile of discretisation)", () => {
    for (let dy = 1; dy <= TABLES.dyMax; dy++) {
      expect(maxGap(dy)).toBeGreaterThanOrEqual(maxGap(dy - 1) - 1);
    }
    expect(maxGap(TABLES.dyMax)).toBeGreaterThan(maxGap(0));
  });

  it("covers the whole level height and clamps beyond it", () => {
    expect(TABLES.dyMax).toBeGreaterThanOrEqual(LEVEL_H - 1);
    expect(maxGap(TABLES.dyMax + 50)).toBe(maxGap(TABLES.dyMax));
    expect(maxGap(TABLES.dyMin - 1)).toBe(-1);
    expect(canReach(0, TABLES.dyMin - 5)).toBe(false);
  });

  it("treats direction symmetrically and accepts numeric run-ups", () => {
    expect(canReach(-5, 0)).toBe(canReach(5, 0));
    expect(maxGap(0, 99)).toBe(maxGap(0, true));
    expect(maxGap(0, -3)).toBe(maxGap(0, false));
    expect(maxGap(0, 2.9)).toBe(maxGap(0, 2));
    expect(maxGap(0, Number.NaN)).toBe(maxGap(0, false));
  });

  it("level and lower targets are always reachable with no gap", () => {
    for (let dy = 0; dy <= TABLES.dyMax; dy++)
      expect(canReach(0, dy, false, "GUARANTEED")).toBe(true);
  });

  it("raw reach brackets the floored reach", () => {
    for (let dy = -k.maxRise; dy <= 10; dy++) {
      const g = maxGap(dy);
      const raw = maxGapRaw(dy);
      if (g >= 1) {
        expect(raw).toBeGreaterThanOrEqual(g);
        expect(raw).toBeLessThan(g + 1);
      }
    }
  });
});

describe("impossibleGap", () => {
  it("is above every requirable gap and matches the solver's best case", () => {
    for (let dy = -6; dy <= 10; dy++) {
      for (const tier of TIERS) {
        const g = maxGap(dy, true, tier);
        if (g >= 1) expect(impossibleGap(dy)).toBeGreaterThan(g);
      }
    }
    expect(impossibleGap(0)).toBe(
      solveJump({ runwayTiles: 7, deltaYTiles: 0 }).impossibleTiles,
    );
    expect(impossibleGap(0)).toBe(movementFacts("NORMAL").impossibleGapTiles);
  });
});

describe("canJump (standing cells)", () => {
  it("converts cell positions to gap and dy", () => {
    const from = { x: 10, y: 15 };
    expect(canJump(from, { x: 10 + 1 + 11, y: 15 })).toBe(true); // 11 empty columns
    expect(canJump(from, { x: 10 + 1 + 12, y: 15 })).toBe(false);
    expect(canJump(from, { x: 11, y: 15 - 6 })).toBe(true); // straight up 6, adjacent
    expect(canJump(from, { x: 11, y: 15 - 7 })).toBe(false);
    expect(canJump(from, { x: 10 - 9, y: 15 }, false)).toBe(true); // leftward, 8 empty, standing
    expect(canJump(from, { x: 10 - 10, y: 15 }, false)).toBe(false);
  });
});

describe("arcs", () => {
  it("exist exactly for the reachable gaps at the design tier", () => {
    for (let dy = TABLES.dyMin; dy <= TABLES.dyMax; dy++) {
      const m = maxGap(dy, true);
      for (let g = 1; g <= 14; g++) {
        expect(arcFor(g, dy) !== null, `gap ${g} dy ${dy}`).toBe(g <= m);
      }
    }
  });

  it("arcCells: offsets from the takeoff cell, airborne, connected, ending next to the landing", () => {
    for (const e of TABLES.arcs.entries) {
      const cells = arcCells(e.gap, e.dy);
      expect(cells.length).toBeGreaterThan(0);
      // First visits in flight order: each new cell touches (8-way) a cell
      // the knight was already in, the takeoff cell included.
      for (let i = 1; i < cells.length; i++) {
        const touches = [{ x: 0, y: 0 }, ...cells.slice(0, i)].some(
          (p) =>
            Math.max(Math.abs(p.x - cells[i].x), Math.abs(p.y - cells[i].y)) ===
            1,
        );
        expect(touches, `gap ${e.gap} dy ${e.dy} cell ${i}`).toBe(true);
      }
      expect(new Set(cells.map((c) => `${c.x},${c.y}`)).size).toBe(
        cells.length,
      );
      const first = cells[0];
      expect(Math.abs(first.x) + Math.abs(first.y)).toBeLessThanOrEqual(2);
      // Cells are first visits in flight order, so a jump that climbs past
      // the target's lip and drops back onto it ends higher up; what must
      // hold is that the path touches the landing cell's neighbourhood.
      const nearLanding = cells.some(
        (c) => Math.abs(c.x - (e.gap + 1)) <= 1 && Math.abs(c.y - e.dy) <= 1,
      );
      expect(nearLanding, `gap ${e.gap} dy ${e.dy}`).toBe(true);
      // Never inside the takeoff ledge or the target platform.
      for (const c of cells) {
        expect(c.x <= 0 && c.y >= 1).toBe(false);
        expect(c.x >= e.gap + 1 && c.y >= e.dy + 1).toBe(false);
      }
      // Apex can't exceed the designed jump height (6.3 tiles + half a body).
      expect(Math.min(...cells.map((c) => c.y))).toBeGreaterThanOrEqual(-7);
    }
  });

  it("arcCoins: one coin per gap column, each on the arc", () => {
    for (const e of TABLES.arcs.entries) {
      const coins = arcCoins(e.gap, e.dy);
      expect(coins.map((c) => c.x)).toEqual(
        Array.from({ length: e.gap }, (_, i) => i + 1),
      );
      const cellKeys = new Set(
        arcCells(e.gap, e.dy).map((c) => `${c.x},${c.y}`),
      );
      const sweepKeys = new Set(
        arcSweep(e.gap, e.dy).map((c) => `${c.x},${c.y}`),
      );
      for (const c of coins) {
        // On the centre path (or, for a coyote takeoff's first column, at least
        // inside the body's swept box).
        expect(
          cellKeys.has(`${c.x},${c.y}`) || sweepKeys.has(`${c.x},${c.y}`),
          `gap ${e.gap} dy ${e.dy}`,
        ).toBe(true);
      }
    }
  });

  it("arcSweep contains the centre path and stays out of both platforms", () => {
    for (const e of TABLES.arcs.entries) {
      const sweep = arcSweep(e.gap, e.dy);
      const keys = new Set(sweep.map((c) => `${c.x},${c.y}`));
      for (const c of arcCells(e.gap, e.dy))
        expect(keys.has(`${c.x},${c.y}`)).toBe(true);
      for (const c of sweep) {
        expect(c.x <= 0 && c.y >= 1, `gap ${e.gap} dy ${e.dy}`).toBe(false);
        expect(
          c.x >= e.gap + 1 && c.y >= e.dy + 1,
          `gap ${e.gap} dy ${e.dy}`,
        ).toBe(false);
      }
    }
  });

  it("mirrors leftward and is empty for unreachable jumps", () => {
    const right = arcCells(4, 0);
    const left = arcCells(-4, 0);
    expect(left).toEqual(right.map((c) => ({ x: -c.x, y: c.y })));
    expect(arcCoins(-4, 0).map((c) => c.x)).toEqual([-1, -2, -3, -4]);
    expect(arcCells(maxGap(0) + 1, 0)).toEqual([]);
    expect(arcCells(1, -(knightLimits().maxRise + 1))).toEqual([]);
    expect(arcCoins(0, 0)).toEqual([]);
    expect(arcSweep(99, 0)).toEqual([]);
  });

  it("a flat arc rises then falls (a real arc, not a line)", () => {
    const coins = arcCoins(8, 0);
    const ys = coins.map((c) => c.y);
    const apex = Math.min(...ys);
    expect(apex).toBeLessThanOrEqual(-4);
    const i = ys.indexOf(apex);
    for (let j = 1; j <= i; j++) expect(ys[j]).toBeLessThanOrEqual(ys[j - 1]);
    for (let j = ys.lastIndexOf(apex) + 1; j < ys.length; j++)
      expect(ys[j]).toBeGreaterThanOrEqual(ys[j - 1]);
  });

  it("arcTableText renders one line per gap for the brief", () => {
    const text = arcTableText(0);
    const lines = text.split("\n");
    expect(lines).toHaveLength(maxGap(0));
    expect(lines[0]).toMatch(/^gap 1: \(1,-?\d+\)$/);
    expect(lines[3]).toMatch(/^gap 4: (\(\d+,-?\d+\) ?){4}$/);
    expect(arcTableText(0, [2, 3]).split("\n")).toHaveLength(2);
    expect(arcTableText(-20)).toBe("");
  });
});
