/**
 * Grid input shared by the playtest agent (sim.ts) and the rule check
 * (rules.ts). Pure data, no Phaser, safe in Web Workers.
 *
 * Coordinates: tiles, x right, y DOWN, origin top-left (contracts.ts).
 * A "standing cell" is an empty cell with a solid cell directly below it:
 * the cell the knight's body occupies while it stands on that tile.
 */
import { SOLID_TILES, type Point } from "../../../apps/editor/src/contracts";

/** Row-major solid map. `solid[y * w + x]` truthy = solid tile. */
export interface SolidGrid {
  w: number;
  h: number;
  solid: ArrayLike<number | boolean>;
}

/** Inclusive tile rectangle. Missing bounds mean "unbounded on that side". */
export interface TileRect {
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
}

/**
 * Where a search or rule check should end:
 *  - a Point: standing in exactly that cell;
 *  - a TileRect: standing in any cell inside it (e.g. `{ x0: 120 }` = any
 *    cell at column 120 or further right, the patrol goal);
 *  - a predicate over the standing cell.
 */
export type GoalSpec = Point | TileRect | ((cell: Point) => boolean);

/** Inclusive column range [x0, x1] the agent may move in. */
export type XRange = [number, number];

export function isPoint(g: unknown): g is Point {
  return (
    typeof g === "object" &&
    g !== null &&
    typeof (g as Point).x === "number" &&
    typeof (g as Point).y === "number"
  );
}

/** Compile a GoalSpec into a fast cell predicate. */
export function goalPredicate(goal: GoalSpec): (x: number, y: number) => boolean {
  if (typeof goal === "function") return (x, y) => goal({ x, y });
  if (isPoint(goal)) {
    const gx = goal.x;
    const gy = goal.y;
    return (x, y) => x === gx && y === gy;
  }
  const r = goal as TileRect;
  const x0 = r.x0 ?? -Infinity;
  const x1 = r.x1 ?? Infinity;
  const y0 = r.y0 ?? -Infinity;
  const y1 = r.y1 ?? Infinity;
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/**
 * Horizontal target of a goal, used by the A* heuristic: the column interval
 * the agent must reach, or null when the goal is an opaque predicate.
 */
export function goalColumns(goal: GoalSpec, hint?: Point): [number, number] | null {
  if (typeof goal === "function") return hint ? [hint.x, hint.x] : null;
  if (isPoint(goal)) return [goal.x, goal.x];
  const r = goal as TileRect;
  return [r.x0 ?? -Infinity, r.x1 ?? Infinity];
}

/** Grid accessor with out-of-bounds = empty (the level has no world-bounds collision). */
export function makeSolid(grid: SolidGrid): (x: number, y: number) => boolean {
  const { w, h, solid } = grid;
  return (x, y) => x >= 0 && y >= 0 && x < w && y < h && !!solid[y * w + x];
}

/** True when (x, y) is empty and has a solid tile directly below. */
export function isStandable(grid: SolidGrid, x: number, y: number): boolean {
  const s = makeSolid(grid);
  return x >= 0 && x < grid.w && y >= 0 && y + 1 < grid.h && !s(x, y) && s(x, y + 1);
}

/** Copy any SolidGrid into a compact Uint8Array grid (0/1). */
export function toUint8Grid(grid: SolidGrid): SolidGrid & { solid: Uint8Array } {
  const out = new Uint8Array(grid.w * grid.h);
  for (let i = 0; i < out.length; i++) out[i] = grid.solid[i] ? 1 : 0;
  return { w: grid.w, h: grid.h, solid: out };
}

/**
 * Parse rows of ASCII art. Any character in `solidChars` (default `#`, `X`,
 * `B`, `=`, `G`, `D`, `?`) is solid; everything else is empty. Rows are padded
 * to the longest row with empty cells.
 */
export function gridFromRows(rows: string[], solidChars = "#XB=GD?"): SolidGrid & { solid: Uint8Array } {
  const h = rows.length;
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const solid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < rows[y].length; x++) if (solidChars.includes(rows[y][x])) solid[y * w + x] = 1;
  return { w, h, solid };
}

/** `matrix[y][x]` truthy = solid (the audit's grid format). */
export function gridFromMatrix(matrix: ArrayLike<ArrayLike<number | boolean>>): SolidGrid & { solid: Uint8Array } {
  const h = matrix.length;
  const w = h ? matrix[0].length : 0;
  const solid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (matrix[y][x]) solid[y * w + x] = 1;
  return { w, h, solid };
}

/**
 * From level tile ids (LevelSnapshot.cells, row-major TileIds). Tiles in
 * `SOLID_TILES` (contracts.ts) are solid.
 */
export function gridFromCells(cells: ArrayLike<number>, w: number, h: number): SolidGrid & { solid: Uint8Array } {
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (SOLID_TILES.has(cells[i])) solid[i] = 1;
  return { w, h, solid };
}

/** Render a grid as ASCII rows (`#` solid, `.` empty), optional marks on top. */
export function gridToRows(grid: SolidGrid, marks: Record<string, string> = {}): string[] {
  const s = makeSolid(grid);
  const rows: string[] = [];
  for (let y = 0; y < grid.h; y++) {
    let r = "";
    for (let x = 0; x < grid.w; x++) r += marks[`${x},${y}`] ?? (s(x, y) ? "#" : ".");
    rows.push(r);
  }
  return rows;
}

/**
 * Snap a requested start cell to where the knight would actually stand:
 * if (x, y) is solid, step up until empty; then fall until standing. Returns
 * null when nothing below the column can be stood on.
 */
export function settleStart(grid: SolidGrid, p: Point): Point | null {
  const s = makeSolid(grid);
  let y = Math.max(0, Math.min(grid.h - 1, Math.round(p.y)));
  const x = Math.round(p.x);
  if (x < 0 || x >= grid.w) return null;
  while (y > 0 && s(x, y)) y--;
  if (s(x, y)) return null;
  while (y + 1 < grid.h && !s(x, y + 1)) y++;
  return y + 1 < grid.h && s(x, y + 1) ? { x, y } : null;
}

/** One maximal horizontal run of standing cells. */
export interface Surface {
  /** Standing row (the empty row above the tiles). */
  y: number;
  x0: number;
  x1: number;
}

/** All surfaces of a grid, left to right then top to bottom. */
export function surfaces(grid: SolidGrid, xRange?: XRange): Surface[] {
  const s = makeSolid(grid);
  const lo = Math.max(0, xRange ? xRange[0] : 0);
  const hi = Math.min(grid.w - 1, xRange ? xRange[1] : grid.w - 1);
  const out: Surface[] = [];
  for (let y = 0; y + 1 < grid.h; y++) {
    let start = -1;
    for (let x = lo; x <= hi + 1; x++) {
      const st = x <= hi && !s(x, y) && s(x, y + 1);
      if (st && start < 0) start = x;
      else if (!st && start >= 0) {
        out.push({ y, x0: start, x1: x - 1 });
        start = -1;
      }
    }
  }
  out.sort((a, b) => a.x0 - b.x0 || a.y - b.y);
  return out;
}
