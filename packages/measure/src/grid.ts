/**
 * Grid access, rectangles and the ASCII fixture format shared by the measure
 * package, its tests and the sliced reference chunks.
 *
 * A grid is anything with `w`, `h` and row-major `cells` (a LevelSnapshot
 * qualifies). Coordinates are tiles, x right, y DOWN (contracts.ts). Cells
 * outside the grid read as empty: falling out of the bottom is a pit.
 */
import {
  AUTHOR,
  LEVEL_H,
  LEVEL_W,
  SOLID_TILES,
  TILE,
  type Entity,
  type EntityKind,
  type LevelSnapshot,
  type Point,
} from "../../../apps/editor/src/contracts";

export interface GridLike {
  w: number;
  h: number;
  /** Row-major TileId per cell, length w*h. */
  cells: ArrayLike<number>;
}

/** An entity as measures need it: ModelAnswer entities (no id) qualify. */
export type EntityLike = Pick<Entity, "kind" | "x" | "y"> & Partial<Pick<Entity, "id" | "patrol">>;

/** Inclusive-exclusive rectangle in tiles: columns x..x+w-1, rows y..y+h-1. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function isSolid(g: GridLike, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return false;
  return SOLID_TILES.has(g.cells[y * g.w + x]);
}

export function tileAt(g: GridLike, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return TILE.EMPTY;
  return g.cells[y * g.w + x];
}

/** Empty cell with a solid tile directly below: where the knight can stand. */
export function isStanding(g: GridLike, x: number, y: number): boolean {
  return x >= 0 && x < g.w && y >= 0 && y < g.h && !isSolid(g, x, y) && isSolid(g, x, y + 1);
}

/**
 * Empty cells from (x, y) upward until a solid tile, including (x, y) itself.
 * Returns Infinity when the column is open to the top of the level.
 */
export function headroom(g: GridLike, x: number, y: number): number {
  let n = 0;
  for (let yy = y; yy >= 0; yy--) {
    if (isSolid(g, x, yy)) return n;
    n++;
  }
  return Infinity;
}

/** Any solid tile in column x strictly below row y (down to the level bottom)? */
export function hasSolidBelow(g: GridLike, x: number, y: number): boolean {
  for (let yy = Math.max(0, y + 1); yy < g.h; yy++) if (isSolid(g, x, yy)) return true;
  return false;
}

export function fullRect(g: GridLike): Rect {
  return { x: 0, y: 0, w: g.w, h: g.h };
}

/** Intersect a rect with the grid. May return w or h = 0. */
export function clipRect(g: GridLike, r: Rect): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(g.w, Math.floor(r.x + r.w));
  const y1 = Math.min(g.h, Math.floor(r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export const inRect = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export const chebyshev = (a: Point, b: Point): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Bounding box of solid tiles and entities, or null for an empty level. */
export function contentBounds(g: GridLike, entities: readonly EntityLike[] = []): Rect | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      if (SOLID_TILES.has(g.cells[y * g.w + x])) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  for (const e of entities) {
    if (e.x < 0 || e.y < 0 || e.x >= g.w || e.y >= g.h) continue;
    x0 = Math.min(x0, e.x);
    x1 = Math.max(x1, e.x);
    y0 = Math.min(y0, e.y);
    y1 = Math.max(y1, e.y);
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------
// ASCII: fixtures and chunk text
// ---------------------------------------------------------------------------

/** Glyph -> tile for terrain. */
export const ASCII_TILES: Record<string, number> = {
  ".": TILE.EMPTY,
  "#": TILE.GRASS,
  d: TILE.DIRT,
  B: TILE.BLOCK,
  "=": TILE.GRASS_HALF,
  "?": TILE.QUESTION,
};

/** Glyph -> entity kind. */
export const ASCII_ENTITIES: Record<string, EntityKind> = {
  c: "coin",
  f: "fruit",
  s: "slime",
  U: "ultraslime",
  F: "flag",
  i: "sign",
};

const TILE_GLYPH: Record<number, string> = Object.fromEntries(
  Object.entries(ASCII_TILES).map(([g, t]) => [t, g]),
);
const ENTITY_GLYPH: Record<string, string> = Object.fromEntries(
  Object.entries(ASCII_ENTITIES).map(([g, k]) => [k, g]),
);

/** One line describing the glyphs, for prompts that show chunks. */
export const ASCII_LEGEND =
  ". empty  # grass  d dirt  B block  = half block  ? question block  " +
  "c coin  f fruit  s slime  U ultraslime  F flag  i sign  P start";

export interface ParsedAscii {
  grid: GridLike & { cells: number[] };
  entities: (EntityLike & { id: string })[];
  start?: Point;
}

/**
 * Parse fixture rows into a grid of the rows' size. Unknown glyphs throw.
 * Entities sit on empty cells; `P` marks the start. Rows may differ in length;
 * short rows are padded with empty cells.
 */
export function parseAscii(rows: readonly string[]): ParsedAscii {
  const h = rows.length;
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cells = new Array<number>(w * h).fill(TILE.EMPTY);
  const entities: (EntityLike & { id: string })[] = [];
  let start: Point | undefined;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch in ASCII_TILES) cells[y * w + x] = ASCII_TILES[ch];
      else if (ch in ASCII_ENTITIES)
        entities.push({ id: `e${entities.length + 1}`, kind: ASCII_ENTITIES[ch], x, y });
      else if (ch === "P") start = { x, y };
      else throw new Error(`parseAscii: unknown glyph '${ch}' at x=${x} y=${y}`);
    }
  }
  return { grid: { w, h, cells }, entities, start };
}

export interface AsciiSnapshotOptions {
  w?: number;
  h?: number;
  /** Column where the fixture's column 0 lands. Default 0. */
  offsetX?: number;
  /** Row where the fixture's row 0 lands. Default: bottom-aligned (h - rows). */
  offsetY?: number;
}

/**
 * Build a full LevelSnapshot (default 200 x 20) with the fixture pasted in,
 * bottom-aligned unless `offsetY` says otherwise. Every tile and entity is
 * authored by the person. Useful for tests and for the translation property.
 */
export function snapshotFromAscii(rows: readonly string[], opts: AsciiSnapshotOptions = {}): LevelSnapshot {
  const parsed = parseAscii(rows);
  const w = opts.w ?? LEVEL_W;
  const h = opts.h ?? LEVEL_H;
  const ox = opts.offsetX ?? 0;
  const oy = opts.offsetY ?? h - parsed.grid.h;
  const cells = new Array<number>(w * h).fill(TILE.EMPTY);
  const authors = new Array<number>(w * h).fill(AUTHOR.NONE);
  for (let y = 0; y < parsed.grid.h; y++)
    for (let x = 0; x < parsed.grid.w; x++) {
      const t = parsed.grid.cells[y * parsed.grid.w + x];
      const X = x + ox,
        Y = y + oy;
      if (t === TILE.EMPTY || X < 0 || Y < 0 || X >= w || Y >= h) continue;
      cells[Y * w + X] = t;
      authors[Y * w + X] = AUTHOR.PERSON;
    }
  const entities: Entity[] = [];
  const entityAuthors: LevelSnapshot["entityAuthors"] = {};
  for (const e of parsed.entities) {
    const X = e.x + ox,
      Y = e.y + oy;
    if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
    entities.push({ id: e.id, kind: e.kind, x: X, y: Y });
    entityAuthors[e.id] = AUTHOR.PERSON;
  }
  const start = parsed.start ? { x: parsed.start.x + ox, y: parsed.start.y + oy } : { x: 2, y: 14 };
  return { w, h, cells, authors, provenance: {}, entities, entityAuthors, start };
}

/**
 * Render a rect as fixture/chunk rows (inverse of parseAscii for the glyphs
 * above). An entity on a cell wins over the (empty) tile.
 */
export function renderAscii(g: GridLike, entities: readonly EntityLike[], r: Rect = fullRect(g)): string[] {
  const rr = clipRect(g, r);
  const ents = new Map<string, string>();
  for (const e of entities) ents.set(`${e.x},${e.y}`, ENTITY_GLYPH[e.kind] ?? "?");
  const out: string[] = [];
  for (let y = rr.y; y < rr.y + rr.h; y++) {
    let line = "";
    for (let x = rr.x; x < rr.x + rr.w; x++) {
      const t = tileAt(g, x, y);
      const ent = ents.get(`${x},${y}`);
      if (t === TILE.EMPTY && ent) line += ent;
      else line += TILE_GLYPH[t] ?? "#";
    }
    out.push(line);
  }
  return out;
}

/** Copy of a rect's tiles as a standalone grid (origin at the rect's corner). */
export function cropGrid(g: GridLike, r: Rect): GridLike & { cells: number[] } {
  const rr = clipRect(g, r);
  const cells = new Array<number>(rr.w * rr.h);
  for (let y = 0; y < rr.h; y++)
    for (let x = 0; x < rr.w; x++) cells[y * rr.w + x] = tileAt(g, rr.x + x, rr.y + y);
  return { w: rr.w, h: rr.h, cells };
}
