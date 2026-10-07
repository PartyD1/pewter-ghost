import { describe, expect, it } from "vitest";
import { LEVEL_W } from "../../../apps/editor/src/contracts";
import { REFERENCE_ROWS, FLAT } from "./__fixtures__/levels";
import { SCREEN_COLS, PATTERN_TAGS } from "./constants";
import { snapshotFromAscii } from "./grid";
import { measureLevel, recentScreens } from "./level";
import { measureWindowFull } from "./measures";

describe("measureLevel", () => {
  const level = snapshotFromAscii(REFERENCE_ROWS);
  const lm = measureLevel(level);

  it("measures every screen", () => {
    expect(lm.screenCols).toBe(SCREEN_COLS);
    expect(lm.screens).toHaveLength(Math.ceil(LEVEL_W / SCREEN_COLS));
    expect(lm.screens[lm.screens.length - 1].w).toBe(LEVEL_W - SCREEN_COLS * (lm.screens.length - 1));
    for (const k of ["density", "difficulty", "linearity", "leniency", "patterns"] as const)
      expect(lm.series[k]).toHaveLength(lm.screens.length);
  });

  it("screen numbers equal measuring that screen as a window", () => {
    const s = lm.screens[1];
    const direct = measureWindowFull(level, level.entities, { x: s.x, y: 0, w: s.w, h: level.h });
    expect(s.measures).toEqual(direct);
  });

  it("knows which screens have content", () => {
    const content = Math.ceil(REFERENCE_ROWS[0].length / SCREEN_COLS);
    expect(lm.aggregate.screensWithContent).toBe(content);
    expect(lm.screens[content].hasContent).toBe(false);
    expect(lm.aggregate.extent).toEqual({ x0: 0, x1: REFERENCE_ROWS[0].length - 1 });
  });

  it("aggregates over screens with content", () => {
    const live = lm.screens.filter((s) => s.hasContent).map((s) => s.measures.difficulty);
    const mean = live.reduce((a, b) => a + b, 0) / live.length;
    expect(lm.aggregate.meanDifficulty).toBeCloseTo(mean, 3);
    expect(lm.aggregate.maxDifficulty).toBe(Math.max(...live));
    expect(lm.aggregate.difficultySpread).toBeGreaterThan(0);
    expect(Object.keys(lm.aggregate.patternScreens)).toEqual([...PATTERN_TAGS]);
    expect(lm.whole.patterns).toEqual(expect.arrayContaining(["gap-run", "staircase", "enemy-gate", "rest", "pit"]));
    expect(lm.aggregate.distinctPatterns).toBe(lm.whole.patterns.length);
  });

  it("an empty level measures as empty", () => {
    const empty = measureLevel(snapshotFromAscii(["...."]));
    expect(empty.aggregate.screensWithContent).toBe(0);
    expect(empty.aggregate.extent).toBeNull();
    expect(empty.aggregate.meanDifficulty).toBe(0);
    expect(empty.whole.patterns).toEqual([]);
  });

  it("custom screen width", () => {
    const m = measureLevel(snapshotFromAscii(FLAT.rows), { screenCols: 50 });
    expect(m.screens).toHaveLength(4);
  });

  it("recentScreens returns the screen holding x and the ones before it", () => {
    expect(recentScreens(lm, 0).map((s) => s.index)).toEqual([0]);
    expect(recentScreens(lm, SCREEN_COLS * 2 + 3).map((s) => s.index)).toEqual([1, 2]);
    expect(recentScreens(lm, 10_000, 3).map((s) => s.index)).toEqual([6, 7, 8]);
  });
});
