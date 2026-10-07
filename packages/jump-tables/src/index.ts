/**
 * @jump-tables — "can the knight make this?" answered from one source.
 *
 * Every number comes from tables.json, which export.ts derives from the
 * fork's frame-accurate jump solver (apps/editor/src/player/jumpSolver.ts).
 * This module only reads the JSON, so it is safe in the editor bundle, in
 * Web Workers and in the proxy: it never loads the solver.
 *
 * Units and conventions (same as contracts.ts):
 *  - tiles; x grows right, y grows DOWN.
 *  - `gap` / `dx`: EMPTY columns between the last solid tile of the takeoff
 *    ledge and the first solid tile of the target. Direction does not matter
 *    (the knight is symmetric), so a negative dx is read as |dx|.
 *  - `dy`: target standing row minus takeoff standing row. Negative = the
 *    target is HIGHER (a rise of 3 is dy = -3); positive = a drop.
 *  - run-up: `true` = full speed (7+ flat tiles before the ledge), `false` =
 *    standing jump from the ledge, or a number of flat tiles (floored and
 *    clamped to 0..7).
 *  - tier: how much jump-timing slop a jump must leave. The editor designs to
 *    NORMAL (66 ms); the agent and rule check may ask for ULTRA (the physical
 *    bound at every frame rate) to reject impossible geometry.
 *
 * Gaps narrower than the maximum count as reachable: the solver only models
 * holding right, so for high targets it sees narrow gaps as a face-plant;
 * a player lets go of right and drops on. Arcs below are real trajectories
 * for each narrow gap, including those.
 */
import type { KnightLimits, Point } from "../../../apps/editor/src/contracts";
import tablesJson from "./tables.json";
import type { ArcEntry, JumpTables, Tier } from "./types";

export type { ArcEntry, JumpTables, Tier } from "./types";
export { TIERS } from "./types";

export const TABLES = tablesJson as unknown as JumpTables;

/** The tier the editor and the brief design to. */
export const DESIGN_TIER: Tier = TABLES.designTier;
/** Run-up (tiles) beyond which the knight is already at top speed. */
export const FULL_RUNWAY: number = TABLES.runways[TABLES.runways.length - 1];

export type RunUp = boolean | number;

function runwayIndex(runUp: RunUp): number {
  const tiles = runUp === true ? FULL_RUNWAY : runUp === false ? 0 : runUp;
  const t = Math.max(
    0,
    Math.min(FULL_RUNWAY, Math.floor(Number.isFinite(tiles) ? tiles : 0)),
  );
  // runways are 0..FULL_RUNWAY in steps of one tile.
  const i = TABLES.runways.indexOf(t);
  return i >= 0 ? i : 0;
}

function cell(
  table: number[][],
  dy: number,
  runUp: RunUp,
  belowRange: number,
): number {
  const d = Math.round(dy);
  if (d < TABLES.dyMin) return belowRange;
  // Deeper than the table: the deepest row is a safe (smaller) answer, since
  // a lower target only ever lets the knight travel further.
  const di = Math.min(d, TABLES.dyMax) - TABLES.dyMin;
  return table[runwayIndex(runUp)][di];
}

/** Knight limits for the request (contracts.KnightLimits). Defaults to the design tier. */
export function knightLimits(tier: Tier = DESIGN_TIER): KnightLimits {
  const l = TABLES.limits[tier];
  return {
    maxGapStand: l.maxGapStand,
    maxGapRun: l.maxGapRun,
    maxRise: l.maxRise,
  };
}

/**
 * Widest gap (empty tiles) the knight can clear onto a target `dy` rows
 * away. 0 = only a target directly adjacent (no gap) is reachable;
 * -1 = nothing at that height is reachable.
 */
export function maxGap(
  dy: number,
  runUp: RunUp = true,
  tier: Tier = DESIGN_TIER,
): number {
  return cell(TABLES.reach[tier], dy, runUp, -1);
}

/** The solver's fractional reach in tiles (0 when none); for measures and fractions. */
export function maxGapRaw(
  dy: number,
  runUp: RunUp = true,
  tier: Tier = DESIGN_TIER,
): number {
  return cell(TABLES.reachRaw[tier], dy, runUp, 0);
}

/**
 * Can the knight jump a gap of `dx` empty tiles onto a target `dy` rows away?
 * See the module header for conventions.
 */
export function canReach(
  dx: number,
  dy: number,
  runUp: RunUp = true,
  tier: Tier = DESIGN_TIER,
): boolean {
  const gap = Math.abs(Math.round(dx));
  return gap <= maxGap(dy, runUp, tier);
}

/**
 * Gaps this wide or wider never land, at any timing on any machine, with
 * this run-up (best case across frame rates). Use to call geometry flatly
 * impossible; use `canReach` to decide what a design may require.
 */
export function impossibleGap(dy: number, runUp: RunUp = true): number {
  return cell(TABLES.impossible, dy, runUp, 0);
}

/**
 * Cell-to-cell form for grid code. `from` and `to` are STANDING cells (the
 * empty cell above a solid tile), the takeoff being the last standing cell on
 * its ledge and `to` the first on the target. The gap is the columns
 * strictly between them.
 */
export function canJump(
  from: Point,
  to: Point,
  runUp: RunUp = true,
  tier: Tier = DESIGN_TIER,
): boolean {
  const gap = Math.max(0, Math.abs(to.x - from.x) - 1);
  return canReach(gap, to.y - from.y, runUp, tier);
}

const arcIndex = new Map<string, ArcEntry>();
for (const e of TABLES.arcs.entries) arcIndex.set(`${e.gap},${e.dy}`, e);

/** The full arc record for a gap and height difference, or null if the jump is not reachable. */
export function arcFor(gap: number, dy: number): ArcEntry | null {
  return arcIndex.get(`${Math.abs(Math.round(gap))},${Math.round(dy)}`) ?? null;
}

const toPoints = (flat: number[], dir: 1 | -1): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2)
    out.push({ x: flat[i] * dir || 0, y: flat[i + 1] });
  return out;
};

/**
 * Tile cells along the knight's jump over `gap` empty tiles onto a target
 * `dy` rows away, as offsets from the takeoff cell (the cell the knight
 * stands in on the ledge's last tile; the landing cell is (gap + 1, dy)).
 * Airborne cells only, in flight order. Empty when the jump is not
 * reachable at the design tier. A negative `gap` mirrors the arc leftward.
 */
export function arcCells(gap: number, dy: number): Point[] {
  const e = arcFor(gap, dy);
  return e ? toPoints(e.cells, gap < 0 ? -1 : 1) : [];
}

/**
 * One coin per gap column on the same arc (x = 1..gap): the classic coin
 * arc. Offsets as in `arcCells`.
 */
export function arcCoins(gap: number, dy: number): Point[] {
  const e = arcFor(gap, dy);
  return e ? toPoints(e.coins, gap < 0 ? -1 : 1) : [];
}

/**
 * Every cell the knight's body touches on the arc (offsets as in
 * `arcCells`). If any of these is solid in the level, the arc is clipped —
 * typically a ceiling — and coins placed on it may be unreachable.
 */
export function arcSweep(gap: number, dy: number): Point[] {
  const e = arcFor(gap, dy);
  if (!e) return [];
  const dir = gap < 0 ? -1 : 1;
  const out: Point[] = [];
  for (let i = 0; i + 2 < e.sweep.length; i += 3) {
    for (let y = e.sweep[i + 1]; y <= e.sweep[i + 2]; y++)
      out.push({ x: e.sweep[i] * dir || 0, y });
  }
  return out;
}

/**
 * Small table of coin offsets per gap width for a prompt (G-26 brief): one
 * line per gap, "gap 4: (1,-3) (2,-5) (3,-5) (4,-4)". Level targets by
 * default.
 */
export function arcTableText(dy = 0, gaps?: number[]): string {
  const list =
    gaps ?? TABLES.arcs.entries.filter((e) => e.dy === dy).map((e) => e.gap);
  const lines: string[] = [];
  for (const g of list) {
    const coins = arcCoins(g, dy);
    if (coins.length === 0) continue;
    lines.push(`gap ${g}: ` + coins.map((c) => `(${c.x},${c.y})`).join(" "));
  }
  return lines.join("\n");
}
