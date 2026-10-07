/**
 * Fixture levels for the agent and the rule check, ported from the audit's
 * validation set (playtest-agent/ladder_test.ts, ceiling_test.ts,
 * mk_validation.ts). Small grids, ground at row 8 of 12 unless noted, start
 * standing at (0, 7), goal = any standing cell in the last column.
 *
 * Exported so other modules' tests (verify/playability, patrol) can reuse them.
 */
import type { Point } from "../../../apps/editor/src/contracts";
import { gridFromMatrix, gridFromRows, type SolidGrid, type TileRect } from "./grid";

export interface Fixture {
  name: string;
  grid: SolidGrid;
  from: Point;
  to: Point | TileRect;
  /** What the physics agent should conclude. */
  beatable: boolean;
  /** What the NORMAL-tier rule check concludes (where it differs, the note says why). */
  rules: boolean;
  note?: string;
}

const H = 12;
const GROUND = 8;

function blank(w: number, h = H): number[][] {
  return Array.from({ length: h }, () => Array<number>(w).fill(0));
}

function fill(g: number[][], x0: number, x1: number, y0: number, y1 = g.length - 1): void {
  for (let y = Math.max(0, y0); y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = 1;
}

/**
 * Takeoff ledge with `runway` flat tiles behind its edge tile, a pit of
 * `gap` empty columns, and a 3-wide landing `rise` rows higher (negative =
 * lower). The audit's gapLevel.
 */
export function gapLevel(runway: number, gap: number, rise = 0): SolidGrid {
  const w = runway + 1 + gap + 3;
  const g = blank(w);
  fill(g, 0, runway, GROUND);
  fill(g, runway + 1 + gap, w - 1, GROUND - rise);
  return gridFromMatrix(g);
}

/** Flat ground, `w` wide. */
export function flatLevel(w = 24): SolidGrid {
  const g = blank(w);
  fill(g, 0, w - 1, GROUND);
  return gridFromMatrix(g);
}

/** Steps `width` tiles wide rising `step` rows each, `count` of them, then flat. */
export function staircaseLevel(step = 2, width = 3, count = 3, w = 24): SolidGrid {
  const g = blank(w);
  fill(g, 0, 3, GROUND);
  let x = 4;
  let top = GROUND;
  for (let i = 0; i < count; i++) {
    top -= step;
    fill(g, x, x + width - 1, top);
    x += width;
  }
  fill(g, x, w - 1, top);
  return gridFromMatrix(g);
}

/** Flat ground with a solid wall `wallW` wide and `tall` tiles high at column `at`. */
export function wallLevel(tall: number, wallW = 2, at = 8, w = 16): SolidGrid {
  const g = blank(w);
  fill(g, 0, w - 1, GROUND);
  fill(g, at, at + wallW - 1, GROUND - tall, GROUND - 1);
  return gridFromMatrix(g);
}

/**
 * The audit's ceiling_test: a pit of `gap` columns at column `at` under a
 * solid mass whose underside is `clear` tiles above the ground, spanning
 * from 3 columns before the pit to 2 after.
 */
export function tunnelLevel(gap: number, clear: number, at = 8, w = 24): SolidGrid {
  const g = blank(w);
  for (let x = 0; x < w; x++) if (!(x >= at && x < at + gap)) fill(g, x, x, GROUND);
  fill(g, at - 3, at + gap + 1, 0, GROUND - 1 - clear);
  return gridFromMatrix(g);
}

const end = (grid: SolidGrid): TileRect => ({ x0: grid.w - 1 });

function fx(
  name: string,
  grid: SolidGrid,
  beatable: boolean,
  rules: boolean,
  note?: string,
): Fixture {
  return { name, grid, from: { x: 0, y: GROUND - 1 }, to: end(grid), beatable, rules, note };
}

/** The validation set. */
export const FIXTURES: Fixture[] = [
  fx("flat", flatLevel(), true, true),
  fx("staircase", staircaseLevel(), true, true),
  fx("tall staircase (rise 3)", staircaseLevel(3, 3, 2), true, true),
  fx("gap 4, standing", gapLevel(0, 4), true, true),
  fx("gap 8, standing", gapLevel(0, 8), true, true),
  fx("gap 11, full run-up", gapLevel(7, 11), true, true),
  fx(
    "gap 12, full run-up",
    gapLevel(7, 12),
    true,
    false,
    "ULTRA reach: the design tier (NORMAL) stops at 11, the physics allows 12",
  ),
  fx("gap 13, full run-up", gapLevel(7, 13), false, false, "impossibleGap(0) = 13"),
  fx("gap 9 rising 5, standing", gapLevel(0, 9, 5), false, false),
  fx("wall 6 tall", wallLevel(6), true, true),
  fx("wall 7 tall", wallLevel(7), false, false, "maxRise is 6"),
  fx("pit 5 under a 3-high tunnel", tunnelLevel(5, 3), true, true),
  fx(
    "pit 7 under a 2-high tunnel",
    tunnelLevel(7, 2),
    false,
    true,
    "rule-checker false positive: the rules never trace the arc into the ceiling",
  ),
  fx(
    "pit 3 under a 1-high tunnel",
    tunnelLevel(3, 1),
    false,
    true,
    "rule-checker false positive: no headroom to jump at all",
  ),
];

/** ASCII helper for inline fixtures in tests. */
export { gridFromRows };
