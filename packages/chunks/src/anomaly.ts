/**
 * Local detectors for cells that break an otherwise clear repeat (e.g. one extra
 * block on a staircase). Unlike detectFinish, proposals here REMOVE cells.
 *
 * Strategy: try removing each of the last few painted terrain cells; if
 * detectFinish then reads the strokes as continuing the last placement with a
 * stronger repeat score, offer that removal.
 */
import type { Point } from "../../../apps/editor/src/contracts";
import {
  DEFAULT_TERRAIN,
  detectFinish,
  type DetectGrid,
  type DetectOptions,
  type DetectPlacement,
  type FinishProposal,
} from "./detect";

export interface AnomalyProposal {
  pattern: FinishProposal["pattern"];
  removes: Point[];
  /** 0..1; callers map to model confidence guidance. */
  confidence: number;
  label: string;
  evidence: string;
}

export interface AnomalyOptions extends DetectOptions {
  /** Most recent painted terrain cells to try removing (default 3). */
  tryLast?: number;
  /** Minimum score gain vs the unmodified grid (default 2). */
  minGain?: number;
}

const key = (p: Point) => `${p.x},${p.y}`;

function score(p: FinishProposal | undefined): number {
  if (!p) return 0;
  return (
    (p.touchesLast ? 100 : 0) +
    (p.open ? 30 : 0) +
    Math.min(p.repeats, 6) * 10 +
    p.adds.length +
    p.entities.length
  );
}

function cloneGrid(g: DetectGrid, clear: Point): DetectGrid {
  const tiles = g.tiles instanceof Uint8Array ? Uint8Array.from(g.tiles as Uint8Array) : Uint8Array.from(g.tiles);
  for (const p of clear) {
    if (p.x >= 0 && p.y >= 0 && p.x < g.w && p.y < g.h) tiles[p.y * g.w + p.x] = 0;
  }
  return { w: g.w, h: g.h, tiles, blocked: g.blocked, entities: g.entities };
}

function liveTerrainKeys(recent: readonly DetectPlacement[], terrain: ReadonlySet<string>, g: DetectGrid): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const p = recent[i];
    if (p.tool !== "paint" || !terrain.has(p.tile)) continue;
    const k = key(p);
    if (seen.has(k)) continue;
    const i0 = p.y * g.w + p.x;
    if (i0 < 0 || i0 >= g.tiles.length || g.tiles[i0] === 0) continue;
    seen.add(k);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * At most one removal set (usually one cell). Null when nothing is clearly wrong.
 */
export function detectAnomalies(
  grid: DetectGrid,
  recent: readonly DetectPlacement[],
  opts: AnomalyOptions = {},
): AnomalyProposal | null {
  const terrain = opts.terrain ?? DEFAULT_TERRAIN;
  const k = Math.max(2, opts.k ?? 16);
  const window = recent.slice(-k);
  const lastPaint = [...window].reverse().find((p) => p.tool === "paint" && (opts.terrain ?? DEFAULT_TERRAIN).has(p.tile));
  const lastKey = lastPaint ? key(lastPaint) : "";
  const beforeList = detectFinish(grid, window, opts);
  const before = beforeList[0];
  const beforeScore = score(before);
  const minGain = opts.minGain ?? 2;

  const candidates = liveTerrainKeys(window, terrain, grid).slice(0, Math.max(1, opts.tryLast ?? 3));
  if (!candidates.length) return null;

  let best: { removes: Point[]; after: FinishProposal; gain: number } | null = null;

  const misread =
    before &&
    before.touchesLast &&
    (before.pattern === "row" || before.pattern === "column") &&
    before.repeats >= 2;

  for (const cand of candidates) {
    const sim = cloneGrid(grid, [cand]);
    const simRecent = window.filter((p) => !(p.tool === "paint" && p.x === cand.x && p.y === cand.y));
    const afterList = detectFinish(sim, simRecent, opts);
    const after = afterList[0];
    const afterScore = score(after);
    const gain = afterScore - beforeScore;
    const structuredFix =
      after?.touchesLast &&
      misread &&
      (after.pattern === "staircase" || after.pattern === "platforms" || after.pattern === "repeat" || after.open);
    if (!after?.touchesLast || (!structuredFix && gain < minGain)) continue;
    const recency = key(cand) === lastKey ? 20 : 0;
    const rank = gain + recency;
    const bestRank = best ? best.gain + (key(best.removes[0]) === lastKey ? 20 : 0) : -1;
    if (!best || rank > bestRank || (rank === bestRank && after.repeats > best.after.repeats)) {
      best = { removes: [cand], after, gain };
    }
  }

  if (!best) return null;
  if (lastKey && key(best.removes[0]) !== lastKey && best.gain < minGain + 12) return null;

  const { removes, after, gain } = best;
  const cell = removes[0];
  const conf = Math.min(0.92, 0.62 + gain * 0.04 + (after.repeats >= 3 ? 0.12 : 0));
  return {
    pattern: after.pattern,
    removes,
    confidence: Math.round(conf * 100) / 100,
    label: `${after.pattern} outlier · remove 1 at (${cell.x},${cell.y})`,
    evidence:
      `computed: removing (${cell.x},${cell.y}) lets the strokes read as "${after.label}" ` +
      `(repeat ${after.repeats}, score +${gain}). Prefer kind fix with that single remove unless the cell is intentional.`,
  };
}
