/**
 * G-13 — Window builder: LevelModel + PlacementStream -> FillRequest.
 *
 * A pure function (given an injected clock reading) that cuts a
 * config.windowCols x config.windowRows window out of the level around the
 * last stroke, biased toward the frontier and clamped to the level, and draws
 * it as ASCII in the format the audit's grid-context prototype tested: a
 * header with the window's place in the level, a legend line, two column
 * rulers (tens and units, every column), row numbers, then one line per row.
 * Every coordinate the model sees is WINDOW-RELATIVE (0..w-1, 0..h-1); the
 * answer converter (answer.ts) maps them back with `windowToLevel`.
 *
 * Glyphs: terrain drawn by the person (or pre-existing) is an UPPER-case
 * letter for its tile, terrain accepted from a Ghost suggestion is the same
 * letter in lower case. Entities and markers are symbols so they never
 * collide with terrain letters.
 */
import {
  AUTHOR,
  ENEMY_KINDS,
  COLLECTABLE_KINDS,
  TILE,
  type Entity,
  type EntityKind,
  type FillMode,
  type FillRequest,
  type GhostHistoryItem,
  type KnightLimits,
  type MeasuredNumbers,
  type Point,
  type VerdictStage,
} from "../contracts";
import { knightLimits } from "@jump-tables";
import { config as liveConfig } from "../suggest/config";
import type { LevelModel } from "../level/LevelModel";
import { OUT_OF_BOUNDS } from "../level/LevelModel";
import type { Frontier, PlacementStream } from "./stream";

export { requestHash, requestHashSync } from "./hash";

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/** Terrain glyph for cells placed by the person (or loaded / pre-existing). */
export const PERSON_GLYPH: Record<number, string> = {
  [TILE.GRASS]: "G",
  [TILE.DIRT]: "D",
  [TILE.BLOCK]: "B",
  [TILE.GRASS_HALF]: "H",
  [TILE.QUESTION]: "Q",
};
/** Terrain glyph for accepted-ghost cells (author GHOST). */
export const GHOST_GLYPH: Record<number, string> = {
  [TILE.GRASS]: "g",
  [TILE.DIRT]: "d",
  [TILE.BLOCK]: "b",
  [TILE.GRASS_HALF]: "h",
  [TILE.QUESTION]: "q",
};
export const ENTITY_GLYPH: Record<EntityKind, string> = {
  coin: "o",
  fruit: "*",
  slime: "S",
  ultraslime: "U",
  flag: "F",
  sign: "!",
};
export const EMPTY_GLYPH = ".";
export const PATROL_GLYPH = "~";
export const START_GLYPH = "@";
/** Unknown terrain id (should not happen with valid levels). */
export const UNKNOWN_PERSON_GLYPH = "X";
export const UNKNOWN_GHOST_GLYPH = "x";
/** Outside the level (only when the level is smaller than the window). */
export const OUTSIDE_GLYPH = "/";

export const LEGEND =
  "Legend: . empty | G grass D dirt B block H half-block Q ?-block (person's) | g d b h q same tiles accepted from Ghost | " +
  "o coin * fruit S slime U ultraslime ~ enemy patrol F flag ! sign @ knight start";

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

type OriginLike = Point | { origin: Point };
const originOf = (o: OriginLike): Point => ("origin" in o ? o.origin : o);

/** Window-relative -> level coordinates. */
export function windowToLevel(p: Point, origin: OriginLike): Point {
  const o = originOf(origin);
  return { x: p.x + o.x, y: p.y + o.y };
}

/** Level -> window-relative coordinates. */
export function levelToWindow(p: Point, origin: OriginLike): Point {
  const o = originOf(origin);
  return { x: p.x - o.x, y: p.y - o.y };
}

/** Is a window-relative point inside the window of `req`? */
export function inWindow(p: Point, req: Pick<FillRequest, "size">): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < req.size.w && p.y < req.size.h;
}

// ---------------------------------------------------------------------------
// Window placement
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlaceWindowInput {
  levelW: number;
  levelH: number;
  cols: number;
  rows: number;
  /** Cells of the last stroke (level coords). */
  stroke: readonly Point[];
  frontier?: Pick<Frontier, "x" | "y" | "direction">;
  /** Centre on this instead (patrol blockedAt). */
  focus?: Point;
  /** Used when there is no stroke, frontier or focus. */
  fallback?: Point;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where the window goes. Centred on the last stroke, shifted toward the
 * frontier by half the distance (at most a quarter of the window), with the
 * stroke's centre kept at least 2 columns / 1 row inside. Vertical drawing:
 * the frontier sits ~40% from the top (room above to keep climbing). A focus
 * point (patrol blockedAt) sits ~40% from the left, centred vertically. Always clamped to the level.
 */
export function placeWindow(inp: PlaceWindowInput): Rect {
  const w = Math.max(1, Math.min(inp.cols, inp.levelW));
  const h = Math.max(1, Math.min(inp.rows, inp.levelH));
  const fit = (x0: number, y0: number): Rect => ({
    x: clamp(x0, 0, inp.levelW - w),
    y: clamp(y0, 0, inp.levelH - h),
    w,
    h,
  });

  // Patrol: the blocking point ~40% from the left, so the far side of the obstacle shows.
  if (inp.focus) return fit(inp.focus.x - Math.floor(w * 0.4), inp.focus.y - Math.floor(h / 2));

  const f = inp.frontier;
  let sx0: number, sx1: number, sy0: number, sy1: number;
  if (inp.stroke.length > 0) {
    sx0 = Math.min(...inp.stroke.map((p) => p.x));
    sx1 = Math.max(...inp.stroke.map((p) => p.x));
    sy0 = Math.min(...inp.stroke.map((p) => p.y));
    sy1 = Math.max(...inp.stroke.map((p) => p.y));
  } else {
    const p = f ?? inp.fallback ?? { x: 0, y: inp.levelH - 1 };
    sx0 = sx1 = p.x;
    sy0 = sy1 = p.y;
  }
  const cx = Math.round((sx0 + sx1) / 2);
  const cy = Math.round((sy0 + sy1) / 2);
  // Keep the stroke's centre inside with a margin (when the window is big enough).
  const keepX = (x0: number) => (w >= 5 ? Math.min(Math.max(x0, cx - w + 3), cx - 2) : x0);
  const keepY = (y0: number) => (h >= 3 ? Math.min(Math.max(y0, cy - h + 2), cy - 1) : y0);

  // Shift the centre toward the frontier by half the distance, at most a quarter window.
  const bias = (from: number, to: number, size: number) => {
    const lim = Math.floor(size / 4);
    return clamp(Math.round((to - from) / 2), -lim, lim);
  };
  const bx = f ? bias(cx, f.x, w) : 0;
  if (f && f.direction === "vertical") {
    // Frontier ~40% from the top: room above to keep climbing.
    const y0 = keepY(f.y - Math.floor(h * 0.4));
    return fit(keepX(cx + bx - Math.floor(w / 2)), y0);
  }
  const by = f ? bias(cy, f.y, h) : 0;
  return fit(keepX(cx + bx - Math.floor(w / 2)), keepY(cy + by - Math.floor(h / 2)));
}

// ---------------------------------------------------------------------------
// ASCII grid
// ---------------------------------------------------------------------------

/** What the grid renderer reads; LevelModel satisfies it. */
export interface GridSource {
  readonly w: number;
  readonly h: number;
  tileAt(x: number, y: number): number;
  authorAt(x: number, y: number): number;
  readonly entities: Entity[];
  readonly start: Point;
  readonly goal: Point | undefined;
}

function terrainGlyph(tile: number, author: number): string {
  if (tile === OUT_OF_BOUNDS) return OUTSIDE_GLYPH;
  if (tile === 0) return EMPTY_GLYPH;
  if (author === AUTHOR.GHOST) return GHOST_GLYPH[tile] ?? UNKNOWN_GHOST_GLYPH;
  return PERSON_GLYPH[tile] ?? UNKNOWN_PERSON_GLYPH;
}

/** The window's cells as rows of glyphs (no rulers). */
export function renderCells(level: GridSource, rect: Rect): string[] {
  const inLevel = (x: number, y: number) => x >= 0 && y >= 0 && x < level.w && y < level.h;
  const rows: string[][] = [];
  for (let wy = 0; wy < rect.h; wy++) {
    const row: string[] = [];
    for (let wx = 0; wx < rect.w; wx++) {
      const x = rect.x + wx;
      const y = rect.y + wy;
      row.push(inLevel(x, y) ? terrainGlyph(level.tileAt(x, y), level.authorAt(x, y)) : OUTSIDE_GLYPH);
    }
    rows.push(row);
  }
  const put = (x: number, y: number, g: string, onlyOver?: string[]) => {
    const wx = x - rect.x;
    const wy = y - rect.y;
    if (wx < 0 || wy < 0 || wx >= rect.w || wy >= rect.h) return;
    if (onlyOver && !onlyOver.includes(rows[wy][wx])) return;
    rows[wy][wx] = g;
  };
  const entities = level.entities;
  // Patrol spans first so entity glyphs draw over them.
  for (const e of entities) {
    if (!ENEMY_KINDS.has(e.kind) || !e.patrol) continue;
    for (let x = e.patrol[0]; x <= e.patrol[1]; x++) put(x, e.y, PATROL_GLYPH, [EMPTY_GLYPH]);
  }
  const s = level.start;
  put(s.x, s.y, START_GLYPH, [EMPTY_GLYPH, PATROL_GLYPH]);
  for (const e of entities) put(e.x, e.y, ENTITY_GLYPH[e.kind] ?? "?");
  const g = level.goal;
  if (g && !entities.some((e) => e.kind === "flag" && e.x === g.x && e.y === g.y))
    put(g.x, g.y, ENTITY_GLYPH.flag, [EMPTY_GLYPH, PATROL_GLYPH]);
  return rows.map((r) => r.join(""));
}

const pad = (n: number, width: number) => String(n).padStart(width, " ");

/**
 * Full grid text: header, legend, rulers, numbered rows and (when enemies are
 * in view) one line of enemy patrol spans. All window-relative.
 */
export function renderGrid(level: GridSource, rect: Rect): string {
  const rows = renderCells(level, rect);
  const lw = String(Math.max(0, rect.h - 1)).length;
  const lead = " ".repeat(lw + 1);
  let tens = "";
  let units = "";
  for (let x = 0; x < rect.w; x++) {
    tens += String(Math.floor(x / 10) % 10);
    units += String(x % 10);
  }
  const lines: string[] = [];
  lines.push(
    `Window ${rect.w}x${rect.h} = level x ${rect.x}..${rect.x + rect.w - 1}, y ${rect.y}..${rect.y + rect.h - 1}. ` +
      `All coordinates are window-relative: x 0..${rect.w - 1} right, y 0..${rect.h - 1} down.`,
  );
  lines.push(LEGEND);
  if (rect.w > 10) lines.push(lead + tens);
  lines.push(lead + units);
  rows.forEach((r, y) => lines.push(`${pad(y, lw)} ${r}`));

  const enemies = level.entities
    .filter((e) => ENEMY_KINDS.has(e.kind) && e.x >= rect.x && e.x < rect.x + rect.w && e.y >= rect.y && e.y < rect.y + rect.h)
    .map((e) => {
      const at = `${e.kind} (${e.x - rect.x},${e.y - rect.y})`;
      return e.patrol ? `${at} patrols x ${e.patrol[0] - rect.x}..${e.patrol[1] - rect.x}` : `${at} no floor`;
    });
  if (enemies.length) lines.push(`Enemies: ${enemies.join("; ")}.`);
  return lines.join("\n");
}

/**
 * Read the glyph rows back out of a grid built by renderGrid (for tests and
 * the stub filler). Returns rows top to bottom.
 */
export function gridRows(grid: string): string[] {
  const out: string[] = [];
  for (const line of grid.split("\n")) {
    const m = /^ *(\d+) (\S+)$/.exec(line);
    if (m && Number(m[1]) === out.length) out.push(m[2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary of the level outside the window
// ---------------------------------------------------------------------------

interface Tally {
  tiles: number;
  ghost: number;
  rewards: number;
  enemies: number;
}

function tallyText(t: Tally): string {
  if (!t.tiles && !t.rewards && !t.enemies) return "empty";
  const parts = [`${t.tiles} tiles${t.ghost ? ` (${t.ghost} Ghost)` : ""}`];
  if (t.rewards) parts.push(`${t.rewards} coins/fruit`);
  if (t.enemies) parts.push(`${t.enemies} enemies`);
  return parts.join(", ");
}

/** One line describing the level outside `rect` (level coordinates). */
export function levelSummary(level: GridSource, rect: Rect): string {
  const left: Tally = { tiles: 0, ghost: 0, rewards: 0, enemies: 0 };
  const right: Tally = { ...left };
  const vert: Tally = { ...left };
  let lastCol = -1;
  const bucket = (x: number, y: number): Tally | undefined => {
    if (x < rect.x) return left;
    if (x >= rect.x + rect.w) return right;
    if (y < rect.y || y >= rect.y + rect.h) return vert;
    return undefined;
  };
  for (let y = 0; y < level.h; y++)
    for (let x = 0; x < level.w; x++) {
      const t = level.tileAt(x, y);
      if (t === 0) continue;
      if (x > lastCol) lastCol = x;
      const b = bucket(x, y);
      if (!b) continue;
      b.tiles++;
      if (level.authorAt(x, y) === AUTHOR.GHOST) b.ghost++;
    }
  let flag: Point | undefined = level.goal;
  for (const e of level.entities) {
    if (e.kind === "flag" && !flag) flag = { x: e.x, y: e.y };
    const b = bucket(e.x, e.y);
    if (!b) continue;
    if (COLLECTABLE_KINDS.has(e.kind)) b.rewards++;
    else if (ENEMY_KINDS.has(e.kind)) b.enemies++;
  }
  const where = (p: Point) =>
    p.x < rect.x ? `${rect.x - p.x} cols left of window`
    : p.x >= rect.x + rect.w ? `${p.x - (rect.x + rect.w - 1)} cols right of window`
    : p.y < rect.y ? "above window"
    : p.y >= rect.y + rect.h ? "below window"
    : "in window";
  const parts = [
    `Level ${level.w}x${level.h}, drawn up to x ${lastCol < 0 ? "-" : lastCol - rect.x} (window-relative)`,
    `left of window: ${tallyText(left)}`,
    `right: ${tallyText(right)}`,
  ];
  if (vert.tiles || vert.rewards || vert.enemies) parts.push(`above/below: ${tallyText(vert)}`);
  parts.push(`start ${where(level.start)}`);
  parts.push(flag ? `flag ${where(flag)}` : "no flag yet");
  return parts.join("; ") + ".";
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export type MeasureFn = (level: LevelModel, rect: Rect) => MeasuredNumbers;

/** Measured numbers before packages/measure is wired in: all zeros. */
export const zeroMeasure: MeasureFn = () => ({
  density: 0,
  gapHist: [0, 0, 0, 0, 0],
  verticality: 0,
  rewardSpacing: 0,
  pressure: 0,
});

/** One-paragraph stand-in until fill/brief.ts (G-21) supplies the real brief. */
export const PLACEHOLDER_BRIEF =
  "Continue what the person is drawing: finish an obvious pattern (a staircase, a run of gaps, a coin arc) or extend the section " +
  "rightward in the same style. Keep every jump inside the knight's limits, leave rests between hard stretches, put coins on the arc " +
  "the knight would take, give enemies at least 4 tiles of floor and never place them on a landing. Do not repeat a recently dismissed idea.";
export const PLACEHOLDER_BRIEF_VERSION = "placeholder-0";

export interface BuildFillRequestOptions {
  mode?: FillMode;
  brief?: string;
  briefVersion?: string;
  lastGhosts?: GhostHistoryItem[];
  previousFailure?: { reason: string; stage: VerdictStage };
  /** Patrol: where the agent got stuck, LEVEL coordinates (the window centres on it). */
  blockedAt?: Point;
  /** Measured numbers for the window rect; default all zeros. */
  measure?: MeasureFn;
  /** Clock reading for idle time (default the stream's clock). */
  now?: number;
  /** Window size (default config.windowCols x windowRows). */
  cols?: number;
  rows?: number;
  /** Placements in `recent` (default config.recentCount). */
  recentCount?: number;
  /** Past ghosts in `lastGhosts` (default config.historyCount). */
  historyCount?: number;
  /** Knight limits (default @jump-tables knightLimits()). */
  knight?: KnightLimits;
  /** Include the one-line summary of the level outside the window (default true). */
  summary?: boolean;
}

/**
 * Build the request the model sees. Pure apart from reading the stream's
 * clock when `now` is omitted. `origin` and `size` are the only level-coordinate
 * fields; recent, frontier and blockedAt are window-relative.
 */
export function buildFillRequest(
  model: LevelModel,
  stream: PlacementStream,
  opts: BuildFillRequestOptions = {},
): FillRequest {
  const cols = opts.cols ?? liveConfig.windowCols;
  const rows = opts.rows ?? liveConfig.windowRows;
  const now = opts.now;
  const frontier = stream.frontier(model, now);
  const stroke = stream.lastStroke().map((e) => ({ x: e.x, y: e.y }));
  const rect = placeWindow({
    levelW: model.w,
    levelH: model.h,
    cols,
    rows,
    stroke,
    frontier,
    focus: opts.blockedAt,
    fallback: model.start,
  });
  const origin = { x: rect.x, y: rect.y };
  const f = frontier ?? { ...model.start, idleMs: stream.idleMs(now) };

  const req: FillRequest = {
    grid: renderGrid(model, rect),
    origin,
    size: { w: rect.w, h: rect.h },
    recent: stream.recent(opts.recentCount ?? liveConfig.recentCount, origin),
    frontier: { x: f.x - origin.x, y: f.y - origin.y, idleMs: Math.round(f.idleMs) },
    knight: opts.knight ?? knightLimits(),
    measured: (opts.measure ?? zeroMeasure)(model, rect),
    brief: opts.brief ?? PLACEHOLDER_BRIEF,
    briefVersion: opts.briefVersion ?? (opts.brief === undefined ? PLACEHOLDER_BRIEF_VERSION : "custom"),
    lastGhosts: lastN(opts.lastGhosts ?? [], opts.historyCount ?? liveConfig.historyCount).map((g) => ({ ...g })),
    mode: opts.mode ?? "auto",
  };
  if (opts.previousFailure) req.previousFailure = { ...opts.previousFailure };
  if (opts.blockedAt) req.blockedAt = levelToWindow(opts.blockedAt, origin);
  if (opts.summary !== false) req.summary = levelSummary(model, rect);
  return req;
}

function lastN<T>(xs: readonly T[], n: number): T[] {
  const k = Math.max(0, Math.floor(n));
  return k === 0 ? [] : xs.slice(-k);
}

/** Rough token estimate used by the size budget (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
