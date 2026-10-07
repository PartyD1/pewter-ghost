import { describe, expect, it } from "vitest";
import { knightLimits } from "@jump-tables";
import { FLAT, GAP_RUN, PILLAR_HOP, STAIRCASE, ENEMY_GATE } from "./__fixtures__/levels";
import { DIFFICULTY_WEIGHTS, HIST_BINS } from "./constants";
import { fullRect, parseAscii, type EntityLike } from "./grid";
import {
  analyzeWindow,
  histogram,
  linearityOf,
  measureWindow,
  measureWindowFull,
  toMeasuredNumbers,
} from "./measures";

function full(rows: string[], extra: EntityLike[] = []) {
  const p = parseAscii(rows);
  return measureWindowFull(p.grid, [...p.entities, ...extra], fullRect(p.grid));
}

const pits = (gap: number, n = 3, ledge = 4) => {
  const top = ".".repeat(ledge + n * (gap + ledge));
  let row = "#".repeat(ledge);
  for (let i = 0; i < n; i++) row += ".".repeat(gap) + "#".repeat(ledge);
  return [top, top, top, top, top, row];
};

describe("helpers", () => {
  it("histogram bins fractions into five shares", () => {
    expect(histogram([])).toEqual([0, 0, 0, 0, 0]);
    expect(histogram([0, 0.19, 0.2, 0.5, 0.99, 3])).toEqual([0.3333, 0.1667, 0.1667, 0, 0.3333]);
    expect(histogram([0.4]).length).toBe(HIST_BINS);
  });
  it("linearity is 1 for any straight line and drops with scatter", () => {
    expect(linearityOf([])).toBe(1);
    expect(linearityOf([{ x: 0, y: 3 }, { x: 1, y: 3 }, { x: 2, y: 3 }])).toBe(1);
    expect(linearityOf([0, 1, 2, 3, 4].map((x) => ({ x, y: 10 - 2 * x })))).toBeCloseTo(1, 10);
    const zig = linearityOf([0, 1, 2, 3, 4, 5].map((x) => ({ x, y: x % 2 ? 0 : 6 })));
    expect(zig).toBeLessThan(0.5);
  });
  it("difficulty weights sum to one", () => {
    const s = Object.values(DIFFICULTY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(s).toBeCloseTo(1, 10);
  });
});

describe("measureWindow numbers", () => {
  it("flat floor: nothing to do", () => {
    const m = full(FLAT.rows);
    expect(m.density).toBe(0.25);
    expect(m.gapHist).toEqual([0, 0, 0, 0, 0]);
    expect(m.verticality).toBe(0);
    expect(m.linearity).toBe(1);
    expect(m.leniency).toBe(1);
    expect(m.pressure).toBe(0);
    expect(m.difficulty).toBe(0);
    expect(m.rewardSpacing).toBe(0);
  });

  it("gap histogram uses maxGapRun", () => {
    const { maxGapRun } = knightLimits();
    const m = full(GAP_RUN.rows);
    // three gaps of 3: 3 / 11 = 0.27 -> bin 1
    expect(3 / maxGapRun).toBeGreaterThanOrEqual(0.2);
    expect(3 / maxGapRun).toBeLessThan(0.4);
    expect(m.gapHist).toEqual([0, 1, 0, 0, 0]);
    expect(m.counts.gaps).toBe(3);
    expect(m.counts.lethal).toBe(3);
  });

  it("an impossible gap lands in the last bin and makes the window hard", () => {
    const { maxGapRun } = knightLimits();
    const m = full(pits(maxGapRun + 2, 1));
    expect(m.gapHist).toEqual([0, 0, 0, 0, 1]);
    expect(m.counts.unreachable).toBe(1);
    expect(m.leniency).toBe(0);
    expect(m.difficultyParts.maxGapRatio).toBe(1);
  });

  it("wider gaps are more difficult and less lenient", () => {
    const easy = full(pits(2));
    const mid = full(pits(6));
    const hard = full(pits(10));
    expect(easy.difficulty).toBeLessThan(mid.difficulty);
    expect(mid.difficulty).toBeLessThan(hard.difficulty);
    expect(hard.meanSlack).toBeLessThan(easy.meanSlack);
    expect(easy.leniency).toBe(1);
  });

  it("rise histogram and verticality for a staircase", () => {
    const m = full(STAIRCASE.rows);
    expect(m.riseHist).toEqual([1, 0, 0, 0, 0]); // 1/6 per step
    expect(m.verticality).toBe(0.5); // dy 1 per column moved
    expect(m.gapHist).toEqual([0, 0, 0, 0, 0]);
  });

  it("a pure ramp is perfectly linear; stacked layers are not", () => {
    const ramp = full([
      "..........",
      ".........#",
      "........##",
      ".......###",
      "......####",
      ".....#####",
      "....######",
      "...#######",
      "..########",
      ".#########",
      "##########",
    ]);
    expect(ramp.linearity).toBe(1);
    const layers = full([
      "....................",
      "####............####",
      "....................",
      "....................",
      "....................",
      "....................",
      "....................",
      "########....########",
    ]);
    expect(layers.linearity).toBeLessThan(0.8);
  });

  it("narrow lethal landings are not lenient", () => {
    const m = full(PILLAR_HOP.rows);
    expect(m.leniency).toBeLessThan(0.5);
    expect(m.difficultyParts.narrow).toBeGreaterThan(0.5);
  });

  it("pressure: enemies near landings over landings", () => {
    const m = full(ENEMY_GATE.rows);
    expect(m.counts.transitions).toBe(2);
    expect(m.counts.enemies).toBe(1);
    expect(m.pressure).toBe(0.5);
    // An enemy far from both landings adds nothing.
    const far = full(ENEMY_GATE.rows, [{ kind: "slime", x: 22, y: 5 }]);
    expect(far.pressure).toBe(0.5);
    // Two near enemies: 2 / 2.
    const two = full(ENEMY_GATE.rows, [{ kind: "ultraslime", x: 17, y: 5 }]);
    expect(two.pressure).toBe(1);
    expect(two.difficulty).toBeGreaterThan(m.difficulty);
  });

  it("reward spacing is the mean distance between consecutive collectables", () => {
    const m = full(FLAT.rows, [
      { kind: "coin", x: 2, y: 5 },
      { kind: "coin", x: 5, y: 1 },
      { kind: "fruit", x: 11, y: 1 },
    ]);
    expect(m.rewardSpacing).toBe(5.5); // (5 + 6) / 2
    expect(full(FLAT.rows, [{ kind: "coin", x: 2, y: 5 }]).rewardSpacing).toBe(0);
  });

  it("only counts what is inside the rect", () => {
    const p = parseAscii(GAP_RUN.rows);
    const left = analyzeWindow(p.grid, [{ kind: "slime", x: 20, y: 5 }], { x: 0, y: 0, w: 10, h: 8 });
    expect(left.counts.transitions).toBe(1);
    expect(left.counts.enemies).toBe(0);
    expect(left.density).toBeCloseTo((7 * 2) / 80, 4);
  });

  it("an empty or off-grid rect gives zeros", () => {
    const p = parseAscii(FLAT.rows);
    const m = measureWindow(p.grid, [], { x: 100, y: 0, w: 10, h: 10 });
    expect(m.density).toBe(0);
    expect(m.difficulty).toBe(0);
    expect(m.patterns).toEqual([]);
  });
});

describe("contract shape", () => {
  it("measureWindow returns exactly the MeasuredNumbers fields", () => {
    const p = parseAscii(GAP_RUN.rows);
    const m = measureWindow(p.grid, p.entities, fullRect(p.grid));
    expect(Object.keys(m).sort()).toEqual(
      ["density", "difficulty", "gapHist", "patterns", "pressure", "rewardSpacing", "verticality"].sort(),
    );
    expect(m).toEqual(toMeasuredNumbers(measureWindowFull(p.grid, p.entities, fullRect(p.grid))));
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it("is deterministic and does not mutate its inputs", () => {
    const p = parseAscii(ENEMY_GATE.rows);
    const cells = [...p.grid.cells];
    const ents = JSON.stringify(p.entities);
    const a = measureWindowFull(p.grid, p.entities, fullRect(p.grid));
    const b = measureWindowFull(p.grid, p.entities, fullRect(p.grid));
    expect(a).toEqual(b);
    expect(p.grid.cells).toEqual(cells);
    expect(JSON.stringify(p.entities)).toBe(ents);
  });

  it("every number is finite and in range", () => {
    for (const rows of [FLAT.rows, GAP_RUN.rows, PILLAR_HOP.rows, STAIRCASE.rows, pits(14, 2)]) {
      const m = full(rows);
      for (const v of [m.density, m.verticality, m.linearity, m.leniency, m.difficulty, m.coinsOnArcShare]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(m.meanSlack).toBeGreaterThanOrEqual(-1);
      expect(m.meanSlack).toBeLessThanOrEqual(1);
      const s = m.gapHist.reduce((a, b) => a + b, 0);
      expect(s === 0 || Math.abs(s - 1) < 1e-3).toBe(true);
    }
  });
});
