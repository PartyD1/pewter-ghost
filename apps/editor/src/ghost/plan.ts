/**
 * What the ghost layer draws, as plain data (no Phaser), so it can be unit
 * tested: faint tiles for adds, faint sprites for entities, crossed-out boxes
 * for removals, and a dashed outline around the union of the added cells.
 *
 * Coordinates are tiles unless a name says px.
 */
import { TILE_PX, type EntityKind, type Point, type Suggestion } from "../contracts";
import { cellKey, suggestionBox, type Box, type GhostCell } from "../suggest/geometry";

/** Look of the ghost (G-11). Numbers, not opinions: change them here. */
export const GHOST_STYLE = {
  /** Opacity of ghost tiles and sprites. */
  alpha: 0.35,
  /** Fade-in on show (ms). The ghost never blinks or pulses. */
  fadeInMs: 120,
  /** Fade-out when dismissed / replaced (ms). */
  fadeOutMs: 120,
  /** On accept the outline goes over this many ms while the real tiles take over. */
  acceptMs: 150,
  /** The canvas caption fades after this long (ms). */
  captionMs: 2000,
  /** Route shown on accept (ms). */
  routeMs: 2000,
  /** Dash and gap lengths in SCREEN px (scaled by zoom when drawn). */
  dashPx: 4,
  gapPx: 3,
  /** Outline: light dashes on a dark, half-transparent rim so it reads on sky, grass and dirt. */
  dashColor: 0xffffff,
  rimColor: 0x101820,
  rimAlpha: 0.55,
  /** Removals: dimmed tile + red cross on a dark rim, dashed red box. */
  removeDim: 0x101820,
  removeDimAlpha: 0.4,
  removeColor: 0xff4d5a,
  /** Route overlay. */
  routeColor: 0xffd23f,
  routeRim: 0x101820,
} as const;

/** One straight outline run along tile edges, in tile coordinates. */
export interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface GhostPlan {
  adds: { x: number; y: number; tile: number }[];
  removes: Point[];
  entities: { x: number; y: number; kind: EntityKind }[];
  /** Perimeter of the union of add + entity cells, merged into straight runs. */
  outline: Edge[];
  /** Bounding box of every touched cell (adds, removes, entities). */
  box: Box;
}

const ghostCellId = (c: GhostCell): string => `${c.type}:${c.x},${c.y}`;

/**
 * The drawing plan for a suggestion. `remaining`, when given, limits the
 * plan to those cells (cells the person already painted by hand disappear).
 */
export function planGhost(s: Suggestion, remaining?: readonly GhostCell[]): GhostPlan {
  const keep = remaining ? new Set(remaining.map(ghostCellId)) : null;
  const ok = (c: GhostCell) => !keep || keep.has(ghostCellId(c));
  const adds = s.adds.filter((a) => ok({ type: "add", ...a })).map((a) => ({ ...a }));
  const removes = s.removes.filter((r) => ok({ type: "remove", ...r })).map((r) => ({ x: r.x, y: r.y }));
  const entities = s.entities.filter((e) => ok({ type: "entity", ...e })).map((e) => ({ ...e }));
  const outlined: Point[] = [...adds, ...entities];
  return { adds, removes, entities, outline: outlineEdges(outlined), box: suggestionBox(s) };
}

/**
 * Perimeter edges of a set of cells, merged into maximal straight runs.
 * An edge is on the perimeter when exactly one of its two cells is in the set.
 */
export function outlineEdges(cells: readonly Point[]): Edge[] {
  const set = new Set(cells.map((c) => cellKey(c.x, c.y)));
  const has = (x: number, y: number) => set.has(cellKey(x, y));
  // Unit edges keyed by line: horizontal edges at y (between rows y-1 and y), vertical at x.
  const hRuns = new Map<number, number[]>();
  const vRuns = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, k: number, v: number) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  for (const k of set) {
    const [x, y] = k.split(",").map(Number);
    if (!has(x, y - 1)) push(hRuns, y, x);
    if (!has(x, y + 1)) push(hRuns, y + 1, x);
    if (!has(x - 1, y)) push(vRuns, x, y);
    if (!has(x + 1, y)) push(vRuns, x + 1, y);
  }
  const out: Edge[] = [];
  // Merge runs. A horizontal edge at line y between cell above and below may come
  // from either side; the same unit edge never appears twice because only one
  // side is in the set.
  for (const [y, xs] of [...hRuns].sort((a, b) => a[0] - b[0])) {
    for (const [a, b] of runs(xs)) out.push({ x0: a, y0: y, x1: b + 1, y1: y });
  }
  for (const [x, ys] of [...vRuns].sort((a, b) => a[0] - b[0])) {
    for (const [a, b] of runs(ys)) out.push({ x0: x, y0: a, x1: x, y1: b + 1 });
  }
  return out;
}

/** Contiguous runs [first, last] of a list of integers. */
function runs(values: number[]): [number, number][] {
  const v = [...new Set(values)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let start = v[0];
  let prev = v[0];
  for (let i = 1; i <= v.length; i++) {
    const cur = v[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    if (start !== undefined) out.push([start, prev]);
    start = cur;
    prev = cur;
  }
  return out;
}

/**
 * Dash segments along a straight line in WORLD px. `dash` and `gap` are world
 * lengths (screen px / zoom). The last dash is clipped at the line's end.
 */
export function dashSegments(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dash: number,
  gap: number,
): [number, number, number, number][] {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len <= 0 || dash <= 0) return [];
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const step = dash + Math.max(0, gap);
  const out: [number, number, number, number][] = [];
  for (let d = 0; d < len; d += step) {
    const e = Math.min(len, d + dash);
    out.push([x0 + ux * d, y0 + uy * d, x0 + ux * e, y0 + uy * e]);
  }
  return out;
}

/** An outline edge in world px. */
export const edgePx = (e: Edge): [number, number, number, number] => [e.x0 * TILE_PX, e.y0 * TILE_PX, e.x1 * TILE_PX, e.y1 * TILE_PX];

/** Fade progress 0..1 for an animation that started at `t0` and lasts `ms` (0 ms = done). */
export function fadeProgress(now: number, t0: number, ms: number): number {
  if (ms <= 0) return 1;
  return Math.max(0, Math.min(1, (now - t0) / ms));
}

/** Total number of cells a plan still draws. */
export const planSize = (p: GhostPlan): number => p.adds.length + p.removes.length + p.entities.length;
