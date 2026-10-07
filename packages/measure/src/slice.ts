/**
 * G-31: slice a level at rests into small chunks, each tagged with its
 * patterns and measured numbers, for "sections others have drawn here"
 * reference examples in the brief.
 *
 * A rest is flat, enemy-free ground at least MEASURE.restMinWidth (4) wide
 * with headroom (the "rest" pattern). A short rest is cut through its middle
 * column; a long rest is cut `margin` (3) columns in from each end, so the
 * chunks on either side keep a little run-up and the flat middle becomes a
 * plain chunk (dropped unless `keepPlain`). Neighbouring chunks share the
 * cut column. Chunks narrower than `minWidth` are merged into their narrower
 * neighbour; chunks wider than `maxWidth` (a long stretch with no rest) are
 * split evenly. Rows are trimmed to the content: one empty row of headroom
 * above the highest tile or entity, down to the lowest solid tile.
 */
import type { EntityKind, LevelSnapshot, MeasuredNumbers } from "../../../apps/editor/src/contracts";
import { MEASURE, type PatternTag } from "./constants";
import { contentBounds, fullRect, isSolid, renderAscii, type EntityLike, type GridLike, type Rect } from "./grid";
import { analyzeWindow, measuresOf, toMeasuredNumbers, type MeasureOptions, type WindowMeasures } from "./measures";

export interface SliceOptions extends MeasureOptions {
  /** Name of the source level, used in chunk ids. Default "level". */
  source?: string;
  /** Narrowest chunk (columns, inclusive of both cut columns). Default 8. */
  minWidth?: number;
  /** Widest chunk before it is split. Default 32. */
  maxWidth?: number;
  /** Columns of a long rest each neighbouring chunk keeps. Default MEASURE.sliceRestMargin (3). */
  margin?: number;
  /** Keep chunks with no transition and no entity (plain flat ground). Default false. */
  keepPlain?: boolean;
}

export interface Chunk {
  /** `${source}:${x0}-${x1}` */
  id: string;
  source: string;
  /** Level rectangle the chunk covers. */
  rect: Rect;
  /** ASCII rows (grid.ts legend), top to bottom. */
  rows: string[];
  /** Entities relative to the chunk's top-left. */
  entities: { kind: EntityKind; x: number; y: number }[];
  tags: PatternTag[];
  numbers: MeasuredNumbers;
  measures: WindowMeasures;
  /** True when the left / right edge is a cut through a rest. */
  startsAtRest: boolean;
  endsAtRest: boolean;
}

interface Segment {
  x0: number;
  x1: number;
  restL: boolean;
  restR: boolean;
}

export interface RestRun {
  x0: number;
  x1: number;
  /** Standing row. */
  y: number;
}

/** Every rest in the level (inclusive column runs), in x order. */
export function findRests(g: GridLike, entities: readonly EntityLike[], opts: MeasureOptions = {}): RestRun[] {
  const a = analyzeWindow(g, entities, fullRect(g), opts);
  return a.hits
    .filter((h) => h.tag === "rest")
    .map((h) => ({ x0: h.x0, x1: h.x1, y: h.y0 }))
    .sort((p, q) => p.x0 - q.x0 || p.y - q.y);
}

/**
 * Cut columns from rests (sorted, unique). A short rest is cut through its
 * middle column; one wider than 2 * margin + 1 is cut `margin` columns in
 * from each end.
 */
export function restCuts(
  g: GridLike,
  entities: readonly EntityLike[],
  opts: MeasureOptions & { margin?: number } = {},
): number[] {
  const margin = Math.max(1, Math.floor(opts.margin ?? MEASURE.sliceRestMargin));
  const cuts = new Set<number>();
  for (const r of findRests(g, entities, opts)) {
    const w = r.x1 - r.x0 + 1;
    if (w > 2 * margin + 1) {
      cuts.add(r.x0 + margin - 1);
      cuts.add(r.x1 - margin + 1);
    } else cuts.add(Math.floor((r.x0 + r.x1) / 2));
  }
  return [...cuts].sort((p, q) => p - q);
}

function segments(bx0: number, bx1: number, cuts: number[], minWidth: number, maxWidth: number): Segment[] {
  const inner = cuts.filter((c) => c > bx0 && c < bx1);
  const bounds = [bx0, ...inner, bx1];
  let segs: Segment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++)
    segs.push({
      x0: bounds[i],
      x1: bounds[i + 1],
      restL: i > 0 || cuts.includes(bx0),
      restR: i + 2 < bounds.length || cuts.includes(bx1),
    });
  if (segs.length === 0) segs.push({ x0: bx0, x1: bx1, restL: false, restR: false });

  // Merge any segment narrower than minWidth into its narrower neighbour.
  const width = (s: Segment) => s.x1 - s.x0 + 1;
  while (segs.length > 1) {
    const i = segs.findIndex((s) => width(s) < minWidth);
    if (i < 0) break;
    const left = i > 0 ? segs[i - 1] : null;
    const right = i + 1 < segs.length ? segs[i + 1] : null;
    const j = !right || (left && width(left) <= width(right)) ? i - 1 : i + 1;
    const lo = Math.min(i, j);
    const merged: Segment = {
      x0: segs[lo].x0,
      x1: segs[lo + 1].x1,
      restL: segs[lo].restL,
      restR: segs[lo + 1].restR,
    };
    segs = [...segs.slice(0, lo), merged, ...segs.slice(lo + 2)];
  }

  // Split stretches without a rest that are wider than maxWidth.
  const out: Segment[] = [];
  for (const s of segs) {
    const w = width(s);
    if (w <= maxWidth) {
      out.push(s);
      continue;
    }
    const k = Math.ceil(w / maxWidth);
    const step = w / k;
    for (let i = 0; i < k; i++) {
      const x0 = s.x0 + Math.round(i * step);
      const x1 = i === k - 1 ? s.x1 : s.x0 + Math.round((i + 1) * step) - 1;
      out.push({ x0, x1, restL: i === 0 ? s.restL : false, restR: i === k - 1 ? s.restR : false });
    }
  }
  return out;
}

function rowsFor(g: GridLike, entities: readonly EntityLike[], x0: number, x1: number): { y0: number; y1: number } | null {
  let top = Infinity,
    bottom = -Infinity;
  for (let x = x0; x <= x1; x++)
    for (let y = 0; y < g.h; y++)
      if (isSolid(g, x, y)) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  for (const e of entities)
    if (e.x >= x0 && e.x <= x1 && e.y >= 0 && e.y < g.h) {
      top = Math.min(top, e.y);
      bottom = Math.max(bottom, e.y);
    }
  if (top === Infinity) return null;
  return { y0: Math.max(0, top - 1), y1: bottom };
}

/** Slice a level (snapshot, or grid + entities) into tagged, measured chunks, left to right. */
export function sliceLevel(level: LevelSnapshot, opts?: SliceOptions): Chunk[];
export function sliceLevel(g: GridLike, entities: readonly EntityLike[], opts?: SliceOptions): Chunk[];
export function sliceLevel(
  g: GridLike | LevelSnapshot,
  a?: readonly EntityLike[] | SliceOptions,
  b?: SliceOptions,
): Chunk[] {
  const entities: readonly EntityLike[] = Array.isArray(a) ? a : ((g as LevelSnapshot).entities ?? []);
  const opts: SliceOptions = (Array.isArray(a) ? b : (a as SliceOptions | undefined)) ?? {};
  const source = opts.source ?? "level";
  const minWidth = Math.max(MEASURE.restMinWidth, Math.floor(opts.minWidth ?? 8));
  const maxWidth = Math.max(minWidth, Math.floor(opts.maxWidth ?? 32));

  const bounds = contentBounds(g, entities);
  if (!bounds) return [];
  const cuts = restCuts(g, entities, opts);
  const segs = segments(bounds.x, bounds.x + bounds.w - 1, cuts, minWidth, maxWidth);

  const chunks: Chunk[] = [];
  for (const s of segs) {
    const rows = rowsFor(g, entities, s.x0, s.x1);
    if (!rows) continue;
    const rect: Rect = { x: s.x0, y: rows.y0, w: s.x1 - s.x0 + 1, h: rows.y1 - rows.y0 + 1 };
    const measures = measuresOf(analyzeWindow(g, entities, rect, opts));
    const inside = entities.filter(
      (e) => e.x >= rect.x && e.x < rect.x + rect.w && e.y >= rect.y && e.y < rect.y + rect.h,
    );
    if (!opts.keepPlain && measures.counts.transitions === 0 && inside.length === 0) continue;
    chunks.push({
      id: `${source}:${s.x0}-${s.x1}`,
      source,
      rect,
      rows: renderAscii(g, inside, rect),
      entities: inside
        .map((e) => ({ kind: e.kind, x: e.x - rect.x, y: e.y - rect.y }))
        .sort((p, q) => p.x - q.x || p.y - q.y),
      tags: [...measures.patterns],
      numbers: toMeasuredNumbers(measures),
      measures,
      startsAtRest: s.restL,
      endsAtRest: s.restR,
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Similarity (for retrieval in fill/examples.ts)
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Reward spacing (tiles) at which the spacing term saturates. */
const SPACING_SCALE = 12;

/**
 * Distance in [0, 1] between two sets of measured numbers: mean of
 * |density|, |verticality|, |difficulty|, |pressure| (clamped), half the L1
 * of the gap histograms, spacing difference / 12 (clamped), and the Jaccard
 * distance of the pattern tags.
 */
export function measuredDistance(a: MeasuredNumbers, b: MeasuredNumbers): number {
  const terms: number[] = [];
  terms.push(Math.abs(a.density - b.density));
  terms.push(Math.abs(a.verticality - b.verticality));
  terms.push(Math.abs((a.difficulty ?? 0) - (b.difficulty ?? 0)));
  terms.push(Math.abs(clamp01(a.pressure) - clamp01(b.pressure)));
  let l1 = 0;
  for (let i = 0; i < Math.max(a.gapHist.length, b.gapHist.length); i++)
    l1 += Math.abs((a.gapHist[i] ?? 0) - (b.gapHist[i] ?? 0));
  terms.push(clamp01(l1 / 2));
  terms.push(clamp01(Math.abs(a.rewardSpacing - b.rewardSpacing) / SPACING_SCALE));
  const ta = new Set(a.patterns ?? []);
  const tb = new Set(b.patterns ?? []);
  const union = new Set([...ta, ...tb]);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  terms.push(union.size ? 1 - inter / union.size : 0);
  return clamp01(terms.reduce((s, v) => s + v, 0) / terms.length);
}

/** The `k` chunks closest to `target` (ties broken by id, so the order is stable). */
export function nearestChunks(chunks: readonly Chunk[], target: MeasuredNumbers, k = 3): Chunk[] {
  return chunks
    .map((c) => ({ c, d: measuredDistance(c.numbers, target) }))
    .sort((p, q) => p.d - q.d || (p.c.id < q.c.id ? -1 : p.c.id > q.c.id ? 1 : 0))
    .slice(0, Math.max(0, k))
    .map((p) => p.c);
}

/** A chunk as prompt text: one header line with tags and numbers, then the rows. */
export function formatChunk(c: Chunk): string {
  const n = c.numbers;
  const head =
    `[${c.tags.join(", ") || "plain"}] ${c.rect.w}x${c.rect.h}` +
    ` density ${n.density.toFixed(2)} difficulty ${(n.difficulty ?? 0).toFixed(2)}` +
    ` pressure ${n.pressure.toFixed(2)} coins-on-arcs ${c.measures.coinsOnArcShare.toFixed(2)}`;
  return [head, ...c.rows].join("\n");
}
