/**
 * Local Finish detectors (G-34): no model, just the person's last placements
 * and the grid around them.
 *
 *  Repeats (constant offset over the last k placements):
 *   - staircase / row / column: single cells at a constant step (|dx|,|dy| <= 1);
 *   - spaced: single cells at a larger constant step (stepping stones);
 *   - pillars / platforms / repeat: multi-cell units (4-connected groups of one
 *     tile) of the same shape at a constant offset, including completing a
 *     unit that is still being drawn; zigzag: the same with offsets
 *     alternating a, b, a, b (a climbing tower of ledges);
 *   - arc / coin-line: coins at a constant dx whose heights follow a line, a
 *     parabola, or (once past the apex) mirror the way up.
 *  Open structures:
 *   - end-cap: a floating platform shorter than its sibling platforms gets its
 *     far end (extended to the siblings' median length);
 *   - pit-floor: two hanging walls with nothing between them get the floor
 *     that closes the U.
 *
 * Everything is in one coordinate frame (the caller's window). Detectors only
 * ADD cells, onto empty, unblocked cells, and stop at the first obstruction.
 */
import type { Point } from "../../../apps/editor/src/contracts";

export interface DetectGrid {
  w: number;
  h: number;
  /** Row-major tile ids, 0 = empty. */
  tiles: ArrayLike<number>;
  /** Row-major; non-zero = not placeable (outside the level, start marker...). */
  blocked?: ArrayLike<number>;
  entities: readonly { kind: string; x: number; y: number }[];
}

export interface DetectPlacement {
  x: number;
  y: number;
  /** Tile name ("grass", "block", ...), entity kind ("coin", ...) or "erase". */
  tile: string;
  tool: "paint" | "erase";
}

export type FinishPattern =
  | "staircase"
  | "row"
  | "column"
  | "spaced"
  | "pillars"
  | "platforms"
  | "repeat"
  | "zigzag"
  | "arc"
  | "coin-line"
  | "end-cap"
  | "pit-floor";

export interface FinishProposal {
  pattern: FinishPattern;
  adds: { x: number; y: number; tile: string }[];
  entities: { kind: string; x: number; y: number }[];
  /** Units observed in the repeat (cells, units or coins), or siblings / walls for open structures. */
  repeats: number;
  /** An open structure (end-cap, pit-floor) rather than a repeat. */
  open: boolean;
  /** The proposal continues from the most recent placement. */
  touchesLast: boolean;
  label: string;
}

export interface DetectOptions {
  /** Placements looked at (default 16). */
  k?: number;
  /** Names that are terrain tiles (default grass, dirt, block, grass_half, question). */
  terrain?: ReadonlySet<string>;
  /** Cells added for single-cell repeats: staircase / column / spaced (default 3) and row (default 4). */
  moreCells?: number;
  moreRowCells?: number;
  /** Units added for unit repeats (default 2). */
  moreUnits?: number;
  /** Most coins added to an arc (default 6). */
  maxArcCoins?: number;
  /** Put a coin above the top of a finished staircase (default true). */
  stairCoin?: boolean;
  /** Widest pit interior for pit-floor (default 12). */
  maxPitWidth?: number;
}

export const DEFAULT_TERRAIN: ReadonlySet<string> = new Set(["grass", "dirt", "block", "grass_half", "question"]);

const key = (x: number, y: number) => `${x},${y}`;
const sgn = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

class View {
  readonly entityAt = new Map<string, string>();
  constructor(readonly g: DetectGrid) {
    for (const e of g.entities) this.entityAt.set(key(e.x, e.y), e.kind);
  }
  inside(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.g.w && y < this.g.h;
  }
  solid(x: number, y: number) {
    return this.inside(x, y) && this.g.tiles[y * this.g.w + x] !== 0;
  }
  free(x: number, y: number) {
    if (!this.inside(x, y)) return false;
    const i = y * this.g.w + x;
    return this.g.tiles[i] === 0 && !(this.g.blocked && this.g.blocked[i]) && !this.entityAt.has(key(x, y));
  }
  /** Empty for collision purposes (entities do not block). */
  air(x: number, y: number) {
    return this.inside(x, y) && this.g.tiles[y * this.g.w + x] === 0;
  }
}

interface Cell extends Point {
  tile: string;
}

/** Distinct cells in placement order (first occurrence wins), still present in the grid. */
function liveSequence(placements: readonly DetectPlacement[], want: (tile: string) => boolean, present: (c: Cell) => boolean): Cell[] {
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const p of placements) {
    if (p.tool !== "paint" || !want(p.tile)) continue;
    const c = { x: p.x, y: p.y, tile: p.tile };
    const k = key(c.x, c.y);
    if (seen.has(k) || !present(c)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** Run every detector; proposals come best first (fresh, then open structures, then strong repeats, then most repeats). */
export function detectFinish(grid: DetectGrid, recent: readonly DetectPlacement[], opts: DetectOptions = {}): FinishProposal[] {
  const v = new View(grid);
  const k = Math.max(2, opts.k ?? 16);
  const terrainNames = opts.terrain ?? DEFAULT_TERRAIN;
  const window = recent.slice(-k);
  const lastPaint = [...window].reverse().find((p) => p.tool === "paint");
  const terrain = liveSequence(window, (t) => terrainNames.has(t), (c) => v.solid(c.x, c.y));
  const coins = liveSequence(window, (t) => t === "coin", (c) => v.entityAt.get(key(c.x, c.y)) === "coin");
  const lastIsCoin = lastPaint?.tile === "coin";
  const lastCell = lastPaint ? key(lastPaint.x, lastPaint.y) : "";
  const isLast = (c: Point | undefined) => !!c && key(c.x, c.y) === lastCell;

  const out: FinishProposal[] = [];
  const push = (p: FinishProposal | null) => {
    if (p && p.adds.length + p.entities.length > 0) out.push(p);
  };
  push(cellRepeat(v, terrain, opts, isLast(terrain[terrain.length - 1]) && !lastIsCoin));
  push(unitRepeat(v, terrain, opts, isLast(terrain[terrain.length - 1]) && !lastIsCoin));
  push(coinArc(v, coins, opts, isLast(coins[coins.length - 1]) && lastIsCoin));
  const freshTerrain = isLast(terrain[terrain.length - 1]) && !lastIsCoin;
  push(endCap(v, terrain, opts, freshTerrain));
  push(pitFloor(v, terrain, opts, freshTerrain));

  // Fresh first; an open structure the last placement belongs to is more
  // specific than a repeat through the same cell (a pit wall is also a column).
  out.sort(
    (a, b) =>
      Number(b.touchesLast) - Number(a.touchesLast) ||
      Number(b.open) - Number(a.open) ||
      Number(b.repeats >= 3) - Number(a.repeats >= 3) ||
      b.repeats - a.repeats,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Single-cell repeats
// ---------------------------------------------------------------------------

function cellRepeat(v: View, seq: Cell[], o: DetectOptions, fresh: boolean): FinishProposal | null {
  const n = seq.length;
  if (n < 2) return null;
  const last = seq[n - 1];
  const dx = last.x - seq[n - 2].x;
  const dy = last.y - seq[n - 2].y;
  if (dx === 0 && dy === 0) return null;
  let count = 2;
  for (let i = n - 2; i > 0; i--) {
    if (seq[i].x - seq[i - 1].x !== dx || seq[i].y - seq[i - 1].y !== dy || seq[i].tile !== last.tile) break;
    count++;
  }
  const near = Math.max(Math.abs(dx), Math.abs(dy)) <= 1;
  // A two-cell spaced "repeat" is too weak to act on.
  if (!near && count < 3) return null;
  const pattern: FinishPattern = !near ? "spaced" : dx !== 0 && dy !== 0 ? "staircase" : dy === 0 ? "row" : "column";
  const more = pattern === "row" ? (o.moreRowCells ?? 4) : (o.moreCells ?? 3);
  const adds: FinishProposal["adds"] = [];
  for (let j = 1; j <= more; j++) {
    const x = last.x + j * dx;
    const y = last.y + j * dy;
    if (!v.free(x, y)) break;
    // Stairs and stepping stones need headroom to stand on.
    if ((pattern === "staircase" || pattern === "spaced") && !v.air(x, y - 1) && v.inside(x, y - 1)) break;
    adds.push({ x, y, tile: last.tile });
  }
  if (!adds.length) return null;
  const entities: FinishProposal["entities"] = [];
  if (pattern === "staircase" && (o.stairCoin ?? true) && dy < 0) {
    const top = adds[adds.length - 1];
    if (v.free(top.x, top.y - 1)) entities.push({ kind: "coin", x: top.x, y: top.y - 1 });
  }
  const what = { staircase: "staircase", row: "row", column: "column", spaced: "stepping stones" }[pattern as "row"];
  const unit = pattern === "staircase" ? "step" : pattern === "spaced" ? "stone" : "tile";
  return {
    pattern,
    adds,
    entities,
    repeats: count,
    open: false,
    touchesLast: fresh,
    label: `finish the ${what}: ${adds.length} more ${unit}${adds.length === 1 ? "" : "s"}`,
  };
}

// ---------------------------------------------------------------------------
// Unit repeats
// ---------------------------------------------------------------------------

interface Unit {
  cells: Cell[];
  anchor: Point;
  tile: string;
  /** Shape: offsets from the anchor, as keys. */
  shape: Set<string>;
}

function units(seq: Cell[]): Unit[] {
  const out: Unit[] = [];
  let cur: Unit | null = null;
  for (const c of seq) {
    const adjacent =
      cur && cur.tile === c.tile && cur.cells.some((d) => Math.abs(d.x - c.x) + Math.abs(d.y - c.y) === 1);
    if (!cur || !adjacent) {
      cur = { cells: [], anchor: { x: c.x, y: c.y }, tile: c.tile, shape: new Set() };
      out.push(cur);
    }
    cur.cells.push(c);
    cur.shape.add(key(c.x - cur.anchor.x, c.y - cur.anchor.y));
  }
  return out;
}

const sameShape = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));
const subShape = (a: Set<string>, b: Set<string>) => a.size < b.size && [...a].every((k) => b.has(k));
const shapeCells = (s: Set<string>): Point[] =>
  [...s].map((k) => {
    const [x, y] = k.split(",").map(Number);
    return { x, y };
  });

function unitKind(shape: Set<string>): FinishPattern {
  const cells = shapeCells(shape);
  if (cells.every((c) => c.x === cells[0].x)) return "pillars";
  if (cells.every((c) => c.y === cells[0].y)) return "platforms";
  return "repeat";
}

/**
 * Place `shape` at `anchor`. Cells already solid are skipped; any other
 * blocked cell fails the unit. When the reference unit stood on something and
 * this one would float, it is extended down (<= 4 rows) to the ground.
 */
function placeUnit(v: View, shape: Set<string>, anchor: Point, tile: string, grounded: boolean, skip: Set<string>): Cell[] | null {
  const cells: Cell[] = [];
  for (const o of shapeCells(shape)) {
    const x = anchor.x + o.x;
    const y = anchor.y + o.y;
    if (skip.has(key(x, y)) || v.solid(x, y)) continue;
    if (!v.free(x, y)) return null;
    cells.push({ x, y, tile });
  }
  if (grounded) {
    const all = shapeCells(shape).map((o) => ({ x: anchor.x + o.x, y: anchor.y + o.y }));
    const bottomY = Math.max(...all.map((c) => c.y));
    for (const b of all.filter((c) => c.y === bottomY)) {
      let y = b.y + 1;
      let extra = 0;
      // Reaching the window bottom is fine: the ground is below the window.
      while (y < v.g.h && !v.solid(b.x, y) && !skip.has(key(b.x, y))) {
        if (extra >= 4 || !v.free(b.x, y)) return null;
        cells.push({ x: b.x, y, tile });
        extra++;
        y++;
      }
    }
  }
  return cells;
}

function unitRepeat(v: View, seq: Cell[], o: DetectOptions, fresh: boolean): FinishProposal | null {
  const us = units(seq);
  const m = us.length;
  if (m < 2) return null;
  const moreUnits = Math.max(1, o.moreUnits ?? 2);
  const groundedOf = (u: Unit) => {
    const bottomY = Math.max(...u.cells.map((c) => c.y));
    return u.cells.filter((c) => c.y === bottomY).every((c) => v.solid(c.x, c.y + 1));
  };
  const eq = (p: Point, q: Point) => p.x === q.x && p.y === q.y;

  const last = us[m - 1];
  const prev = us[m - 2];
  const same = (a: Unit, b: Unit) => a.tile === b.tile && sameShape(a.shape, b.shape);
  let partial: Unit | null = null;
  if (same(last, prev)) {
    if (last.cells.length < 2) return null; // single cells: cellRepeat's job
  } else if (last.tile === prev.tile && prev.cells.length >= 2 && subShape(last.shape, prev.shape)) {
    partial = last; // the last unit is still being drawn
  } else return null;
  const full = partial ? us.slice(0, m - 1) : us;
  const ref = full[full.length - 1];
  let s0 = full.length - 1;
  while (s0 > 0 && same(full[s0 - 1], ref)) s0--;
  const anchors = full.slice(s0).map((u) => u.anchor);
  if (partial) anchors.push(partial.anchor);
  if (anchors.length < 2) return null;
  const offsets = anchors.slice(1).map((a, i) => ({ x: a.x - anchors[i].x, y: a.y - anchors[i].y }));
  const n = offsets.length;
  // Period 1 (constant offset) or 2 (zig-zag: a, b, a, b...), over the trailing offsets.
  let t1 = 1;
  while (t1 < n && eq(offsets[n - 1 - t1], offsets[n - 1])) t1++;
  let t2 = 0;
  if (n >= 3 && !eq(offsets[n - 1], offsets[n - 2])) {
    t2 = 2;
    while (t2 < n && eq(offsets[n - 1 - t2], offsets[n - 1 - t2 + 2])) t2++;
  }
  const period = t2 >= 3 ? 2 : 1;
  const used = period === 2 ? t2 : t1;
  if (offsets.slice(n - used).some((o) => o.x === 0 && o.y === 0)) return null;
  const repeats = used + 1; // units in the periodic run (the partial one included)
  const nextOffset = (j: number): Point => offsets[n - period + ((j - 1) % period)];
  const grounded = groundedOf(ref);
  const adds: Cell[] = [];
  const taken = new Set<string>();
  const take = (cells: Cell[]) => {
    for (const c of cells) {
      taken.add(key(c.x, c.y));
      adds.push(c);
    }
  };
  let placed = 0;
  if (partial) {
    const rest = placeUnit(v, ref.shape, partial.anchor, ref.tile, grounded, taken);
    if (!rest) return null;
    take(rest);
    placed++;
  }
  let a = { ...(partial ?? ref).anchor };
  for (let j = 1; j <= moreUnits - (partial ? 1 : 0); j++) {
    const o = nextOffset(j);
    a = { x: a.x + o.x, y: a.y + o.y };
    const cells = placeUnit(v, ref.shape, a, ref.tile, grounded, taken);
    if (!cells || !cells.length) break;
    take(cells);
    placed++;
  }
  if (!adds.length) return null;
  const pattern: FinishPattern = period === 2 ? "zigzag" : unitKind(ref.shape);
  const noun = pattern === "pillars" ? "pillar" : pattern === "platforms" || pattern === "zigzag" ? "platform" : "unit";
  return {
    pattern,
    adds,
    entities: [],
    repeats,
    open: false,
    touchesLast: fresh,
    label: partial
      ? `finish the ${noun} you are drawing${placed > 1 ? ` and add ${placed - 1} more` : ""}`
      : `repeat the ${noun}: ${placed} more`,
  };
}

// ---------------------------------------------------------------------------
// Coin arcs and lines
// ---------------------------------------------------------------------------

function coinArc(v: View, seq: Cell[], o: DetectOptions, fresh: boolean): FinishProposal | null {
  const n = seq.length;
  if (n < 3) return null;
  const dx = seq[n - 1].x - seq[n - 2].x;
  if (dx === 0 || Math.abs(dx) > 2) return null;
  let start = n - 2;
  while (start > 0 && seq[start].x - seq[start - 1].x === dx) start--;
  const run = seq.slice(start);
  if (run.length < 3) return null;
  const dys = run.slice(1).map((c, i) => c.y - run[i].y);
  const ddys = dys.slice(1).map((d, i) => d - dys[i]);
  const maxCoins = o.maxArcCoins ?? 6;
  const add: Point[] = [];
  const lastC = run[run.length - 1];
  const tryAdd = (x: number, y: number) => {
    if (!v.free(x, y)) return false;
    add.push({ x, y });
    return true;
  };

  // Apex reached (rising, then flat or falling): mirror the way up.
  const nUp = dys.findIndex((d) => d >= 0);
  const after = nUp > 0 ? dys.slice(nUp) : [];
  const nFlat = after.findIndex((d) => d !== 0);
  const downs = nFlat < 0 ? [] : after.slice(nFlat);
  let pattern: FinishPattern;
  if (nUp > 0 && downs.every((d) => d > 0)) {
    pattern = "arc";
    const mirror = dys.slice(0, nUp).map((d) => -d).reverse();
    let y = lastC.y;
    let x = lastC.x;
    for (const d of mirror.slice(downs.length)) {
      x += dx;
      y += d;
      if (add.length >= maxCoins || !tryAdd(x, y)) break;
    }
  } else if (ddys.length && ddys.every((d) => d === ddys[0]) && ddys[0] !== 0) {
    pattern = "arc";
    const ddy = ddys[0];
    const y0 = run[0].y;
    let d = dys[dys.length - 1];
    let x = lastC.x;
    let y = lastC.y;
    for (let j = 0; j < maxCoins; j++) {
      d += ddy;
      x += dx;
      y += d;
      if ((y - y0) * sgn(ddy) > 0) break; // passed back beyond the starting height
      if (!tryAdd(x, y)) break;
    }
  } else if (dys.every((d) => d === dys[0]) && Math.abs(dys[0]) <= 1) {
    pattern = "coin-line";
    let x = lastC.x;
    let y = lastC.y;
    for (let j = 0; j < 3; j++) {
      x += dx;
      y += dys[0];
      if (!tryAdd(x, y)) break;
    }
  } else return null;
  if (!add.length) return null;
  return {
    pattern,
    adds: [],
    entities: add.map((p) => ({ kind: "coin", x: p.x, y: p.y })),
    repeats: run.length,
    open: false,
    touchesLast: fresh,
    label: pattern === "arc" ? `finish the coin arc: ${add.length} more coin${add.length === 1 ? "" : "s"}` : `continue the coin line: ${add.length} more`,
  };
}

// ---------------------------------------------------------------------------
// Open structures
// ---------------------------------------------------------------------------

interface Run {
  y: number;
  x0: number;
  x1: number;
}

/** Floating horizontal runs (solid with air below) of length >= 2. */
function floatingRuns(v: View): Run[] {
  const out: Run[] = [];
  for (let y = 0; y < v.g.h - 1; y++) {
    let x0 = -1;
    for (let x = 0; x <= v.g.w; x++) {
      const ok = x < v.g.w && v.solid(x, y) && v.air(x, y + 1);
      if (ok && x0 < 0) x0 = x;
      if (!ok && x0 >= 0) {
        // Must be a thin run: no solid directly below any cell, and not glued to a wall.
        if (x - 1 - x0 >= 1) out.push({ y, x0, x1: x - 1 });
        x0 = -1;
      }
    }
  }
  return out;
}

function endCap(v: View, seq: Cell[], o: DetectOptions, fresh: boolean): FinishProposal | null {
  const last = seq[seq.length - 1];
  if (!last) return null;
  const runs = floatingRuns(v);
  const mine = runs.find((r) => r.y === last.y && r.x0 <= last.x && last.x <= r.x1);
  if (!mine) return null;
  // The whole contiguous solid row must be the floating run (not the edge of a ledge).
  if (v.solid(mine.x0 - 1, mine.y) || v.solid(mine.x1 + 1, mine.y)) return null;
  const len = mine.x1 - mine.x0 + 1;
  const siblings = runs.filter((r) => r !== mine).map((r) => r.x1 - r.x0 + 1);
  if (!siblings.length) return null;
  siblings.sort((a, b) => a - b);
  const target = siblings[Math.floor(siblings.length / 2)];
  if (target <= len || target - len > 6) return null;
  // Direction: the way the person was drawing along this row (default right).
  const row = seq.filter((c) => c.y === last.y && c.x >= mine.x0 && c.x <= mine.x1);
  const d = row.length >= 2 ? sgn(last.x - row[row.length - 2].x) || 1 : last.x === mine.x0 && last.x !== mine.x1 ? -1 : 1;
  const adds: FinishProposal["adds"] = [];
  let x = d > 0 ? mine.x1 : mine.x0;
  for (let i = 0; i < target - len; i++) {
    x += d;
    if (!v.free(x, mine.y) || v.solid(x + d, mine.y)) break;
    adds.push({ x, y: mine.y, tile: last.tile });
  }
  if (!adds.length) return null;
  return {
    pattern: "end-cap",
    adds,
    entities: [],
    repeats: siblings.length,
    open: true,
    touchesLast: fresh,
    label: `finish the platform: ${adds.length} more tile${adds.length === 1 ? "" : "s"} to match the others`,
  };
}

/** Vertical solid run in column x containing row y: [top, bottom], or null. */
function colRun(v: View, x: number, y: number): [number, number] | null {
  if (!v.solid(x, y)) return null;
  let a = y;
  let b = y;
  while (v.solid(x, a - 1)) a--;
  while (v.solid(x, b + 1)) b++;
  return [a, b];
}

function pitFloor(v: View, seq: Cell[], o: DetectOptions, fresh: boolean): FinishProposal | null {
  const maxW = o.maxPitWidth ?? 12;
  const tried = new Set<number>();
  // Most recent wall cells first.
  for (let i = seq.length - 1; i >= 0; i--) {
    const c = seq[i];
    if (tried.has(c.x)) continue;
    tried.add(c.x);
    const a = colRun(v, c.x, c.y);
    if (!a || a[1] - a[0] + 1 < 3) continue;
    for (const d of [1, -1]) {
      const p = pitBetween(v, c, a, d, maxW);
      if (!p) continue;
      return {
        pattern: "pit-floor",
        adds: p,
        entities: [],
        repeats: 2,
        open: true,
        touchesLast: fresh && i === seq.length - 1,
        label: `close the pit: a ${p.length}-tile floor`,
      };
    }
  }
  return null;
}

/** Walk from wall `c` (run `a`) in direction d to the facing wall; the missing floor cells, or null. */
function pitBetween(v: View, c: Cell, a: [number, number], d: number, maxW: number): FinishProposal["adds"] | null {
  const solidInBand = (x: number) => {
    for (let y = a[0]; y <= a[1]; y++) if (v.solid(x, y)) return y;
    return -1;
  };
  for (let w = 1; w <= maxW + 1; w++) {
    const x = c.x + d * w;
    if (!v.inside(x, c.y)) return null;
    const hit = solidInBand(x);
    if (hit < 0) continue; // interior column, clear over the wall's band
    const b = colRun(v, x, hit)!;
    if (b[1] - b[0] + 1 < 3) continue; // a partly drawn floor tile; the interior check below judges it
    if (w === 1) return null; // a thick wall, not a pit
    const top = Math.max(a[0], b[0]);
    const floorY = Math.min(a[1], b[1]);
    if (floorY - top < 2) return null;
    // At least one wall must hang above the window bottom: a built U, not the edges of a ground pit.
    if (a[1] >= v.g.h - 1 && b[1] >= v.g.h - 1) return null;
    const xl = Math.min(c.x, x);
    const xr = Math.max(c.x, x);
    const adds: FinishProposal["adds"] = [];
    for (let ix = xl + 1; ix < xr; ix++) {
      for (let y = top; y < floorY; y++) if (v.solid(ix, y)) return null;
      if (v.solid(ix, floorY)) continue; // already drawn part of the floor
      // Open below: the floor is really missing.
      if (!v.free(ix, floorY) || v.solid(ix, floorY + 1)) return null;
      adds.push({ x: ix, y: floorY, tile: c.tile });
    }
    return adds.length ? adds : null;
  }
  return null;
}
