/**
 * Shape of packages/jump-tables/src/tables.json.
 *
 * Kept free of solver imports so the editor, Web Workers and the proxy can
 * load the tables without pulling the jump solver into their bundles.
 */
import type { KnightLimits } from "../../../apps/editor/src/contracts";

/** Same tiers as apps/editor/src/player/jumpSolver.ts, easiest to hardest. */
export type Tier = "GUARANTEED" | "NORMAL" | "EXPERT" | "ULTRA";
export const TIERS: readonly Tier[] = [
  "GUARANTEED",
  "NORMAL",
  "EXPERT",
  "ULTRA",
];

/** One coin arc: a gap width and height difference with the cells the knight flies through. */
export interface ArcEntry {
  /** Empty columns between the takeoff ledge and the target. */
  gap: number;
  /** Target row minus takeoff row (level convention, y down: negative = higher). */
  dy: number;
  /**
   * Airborne cells of the body centre in flight order, flattened
   * [x0, y0, x1, y1, ...], offsets from the takeoff cell. Coins go here.
   */
  cells: number[];
  /** One coin per gap column (x = 1..gap) on the centre path, flattened [x, y, ...]. */
  coins: number[];
  /** Per-column vertical spans the body box touches, flattened [x, yMin, yMax, ...]. */
  sweep: number[];
  /** Highest centre row offset reached (most negative). */
  apexDy: number;
  /** Input recipe that produced the arc (60 Hz). */
  input: {
    runwayTiles: number;
    jumpOffsetFrames: number;
    airHoldFrames: number | null;
  };
  /** Landing centre past the target's leading face, px (2 decimals). */
  overshootPx: number;
}

export interface JumpTables {
  version: 1;
  /** Where the numbers come from. */
  source: {
    fork: string;
    generator: string;
    physics: Record<string, number>;
    bodyPx: { width: number; height: number };
    tilePx: number;
    frameRates: number[];
  };
  /** Tier the editor designs to (KnightLimits, canReach default). */
  designTier: Tier;
  tiers: Tier[];
  /** Run-up lengths (tiles) the reach rows are indexed by. Last = full speed. */
  runways: number[];
  /** dy range covered (level convention, y down). Index = dy - dyMin. */
  dyMin: number;
  dyMax: number;
  /**
   * reach[tier][runwayIndex][dy - dyMin] = widest whole-tile gap landable,
   * 0 = only a gap-free step (target directly adjacent), -1 = unreachable.
   */
  reach: Record<Tier, number[][]>;
  /** Same layout, the solver's fractional gap in tiles (3 decimals); 0 if none. */
  reachRaw: Record<Tier, number[][]>;
  /**
   * impossible[runwayIndex][dy - dyMin]: gaps this wide or wider never land
   * at any timing on any machine (best case across frame rates).
   */
  impossible: number[][];
  /** Knight limits per tier, derived from `reach`. */
  limits: Record<Tier, KnightLimits>;
  /** Coin arcs at the design tier, full run-up allowed. */
  arcs: {
    tier: Tier;
    renderHz: number;
    entries: ArcEntry[];
  };
}
