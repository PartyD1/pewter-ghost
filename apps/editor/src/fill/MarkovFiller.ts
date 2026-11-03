/**
 * MarkovFiller ("markov"): a constrained multi-dimensional Markov chain
 * (Snodgrass & Ontañón, "Experiments in Map Generation using Markov Chains",
 * FDG 2014; constrained sampling, IJCAI 2013 / AIIDE 2017). The third
 * autofill condition, beside the LLM and the chunk-grammar AlgoFiller: it
 * learns the person's own style from what they have drawn and continues it.
 * Same Filler interface, validator, verifier and ghost layer; no model calls.
 *
 *  - The chain: P(tile | left, below, below-left) per level row, backing off
 *    to the row's height band (the 20 rows in 4 bands, so ground is not
 *    proposed near the top), then (left, below), (below) and the band's tile
 *    frequencies when a context is rare. Terrain only; no entities.
 *  - Training: the reference sections bundled with the prompt
 *    (prompts/reference, weight 1) plus every column of the request window up
 *    to the extend anchor (the person's drawing, weight `personWeight`), so their
 *    palette, step heights and gap widths win over the reference.
 *  - Extend: the columns right of the anchor (the person's rightmost recent
 *    paint in the window, else the frontier) are sampled left to right,
 *    each bottom to top, so every cell's context is already known. Cells that
 *    hold a tile, an entity or the start are fixed and never change.
 *  - Material (a second layer, SkinTable): once the shape is sampled, each new
 *    solid cell takes the tile the training data puts at (solid above?, solid
 *    below?, left tile): grass on top, dirt under it, in the person's palette.
 *  - Playability (constrained sampling, "violation location resampling"):
 *    the rule check (@physsim checkRules, the knight's jump tables) runs from
 *    the anchor to the last new column; on failure only the columns after
 *    the furthest reachable cell are resampled, a few times, before the
 *    candidate is dropped. The verifier still plays the answer on the level.
 *  - The first candidate that passes is offered: a true sample of the
 *    person's style (taking the likeliest of several always picks the mode, a
 *    flat run, and drops the gaps and steps they draw). Later candidates are
 *    fallbacks. Confidence is its likelihood mapped into the prompt's extend
 *    range (0.2..0.6): the geometric-mean probability of the cells near structure.
 *  - Patrol and tidy (fixes), and finish: not handled; returns a decline.
 *
 * Deterministic for a request (and its send-back attempt), so the offline
 * suite and tests replay it exactly.
 */
import { parseAscii } from "@measure";
import { checkRules, type SolidGrid } from "@physsim";
import { REFERENCE_SECTIONS } from "../../../../prompts/bundle";
import {
  LEVEL_H,
  NAME_BY_TILE,
  SOLID_TILES,
  type Filler,
  type FillerName,
  type FillRequest,
  type ModelAnswer,
  type Suggestion,
  type TileName,
} from "../contracts";
import { config as liveConfig, type GhostConfig } from "../suggest/config";
import { parseWindowGrid, type WindowGrid } from "./AlgoFiller";
import { modelAnswerToSuggestion } from "./answer";
import { throwIfAborted } from "./Filler";
import { requestHash, requestHashSync } from "./hash";

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** Context symbol for a cell outside the grid (left of column 0, below the last row). */
export const OUT = 255;
export const BANDS = 4;

/** Height band of a level row (0 = top). */
export const bandOf = (levelY: number): number => Math.min(BANDS - 1, Math.max(0, Math.floor((levelY * BANDS) / LEVEL_H)));

type Counts = Map<number, number>;

/** A context needs this much weight before its own distribution is trusted. */
const MIN_CONTEXT = 3;
/**
 * Share of the band's tile frequencies mixed into every distribution
 * (smoothing). Kept small: a rare tile sampled once is copied along by the
 * next column's left context, so smoothing shows up as stray rows.
 */
const BACKOFF_MIX = 0.01;

export interface GridLike {
  w: number;
  h: number;
  cells: ArrayLike<number>;
}

export class MarkovChain {
  private readonly levels: Map<string, Counts>[] = [new Map(), new Map(), new Map(), new Map(), new Map()];
  private readonly tiles = new Set<number>([0]);
  /** Total observed weight. */
  weight = 0;

  private add(level: number, key: string, t: number, w: number): void {
    const m = this.levels[level];
    let c = m.get(key);
    if (!c) m.set(key, (c = new Map()));
    c.set(t, (c.get(t) ?? 0) + w);
  }

  /**
   * Contexts from most to least specific: the exact level row first (as in
   * Snodgrass's row-split chains: a gap in the person's ground row closes
   * after the widths they draw, where the band-level context "empty left and
   * below" is dominated by open sky and never closes it), then the band with
   * the full neighbourhood, (left, below), (below), and the band alone.
   */
  private static keys(levelY: number, left: number, below: number, diag: number): string[] {
    const b = bandOf(levelY);
    return [`r${levelY}|${left}|${below}|${diag}`, `b${b}|${left}|${below}|${diag}`, `b${b}|${left}|${below}`, `b${b}|${below}`, `b${b}`];
  }

  observe(levelY: number, left: number, below: number, diag: number, t: number, w = 1): void {
    const ks = MarkovChain.keys(levelY, left, below, diag);
    ks.forEach((k, i) => this.add(i, k, t, w));
    this.tiles.add(t);
    this.weight += w;
  }

  /**
   * Learn from a grid whose row 0 is level row `originY`. Only columns in
   * [x0, x1] are observed (their left neighbours are read as context).
   */
  train(g: GridLike, originY: number, w = 1, x0 = 0, x1 = g.w - 1): void {
    const at = (x: number, y: number) => (x < 0 || y >= g.h ? OUT : g.cells[y * g.w + x]);
    for (let x = Math.max(0, x0); x <= Math.min(g.w - 1, x1); x++)
      for (let y = 0; y < g.h; y++) this.observe(originY + y, at(x - 1, y), at(x, y + 1), at(x - 1, y + 1), g.cells[y * g.w + x], w);
  }

  /** P(tile | context) as parallel arrays (tiles ascending), never empty, summing to 1. */
  dist(levelY: number, left: number, below: number, diag: number): { tiles: number[]; p: number[] } {
    const ks = MarkovChain.keys(levelY, left, below, diag);
    const last = ks.length - 1;
    let chosen: Counts | undefined;
    for (let i = 0; i < ks.length; i++) {
      const c = this.levels[i].get(ks[i]);
      if (c && total(c) >= MIN_CONTEXT) {
        chosen = c;
        break;
      }
    }
    const base = this.levels[last].get(ks[last]);
    const tiles = [...this.tiles].sort((a, b) => a - b);
    const ct = chosen ? total(chosen) : 0;
    const bt = base ? total(base) : 0;
    const raw = tiles.map((t) => {
      const pc = ct ? (chosen!.get(t) ?? 0) / ct : 0;
      const pb = bt ? (base!.get(t) ?? 0) / bt : t === 0 ? 1 : 0;
      return chosen ? (1 - BACKOFF_MIX) * pc + BACKOFF_MIX * pb : pb;
    });
    // A whisker of mass everywhere, so a likelihood is never -Infinity.
    const s = raw.reduce((a, b) => a + b, 0) + tiles.length * 1e-6;
    return { tiles, p: raw.map((v) => (v + 1e-6) / s) };
  }

  /** P(t | context). */
  prob(levelY: number, left: number, below: number, diag: number, t: number): number {
    const d = this.dist(levelY, left, below, diag);
    const i = d.tiles.indexOf(t);
    return i < 0 ? 1e-6 : d.p[i];
  }
}

/**
 * The material layer (Snodgrass's multi-layer idea): once the geometry is
 * sampled, each solid cell's tile is re-picked from what the training data
 * puts at (solid above?, solid below?, left tile), so tops get the surface
 * tile and buried cells the fill tile. The shape chain alone cannot tell a
 * pit edge's top from the cell under it (same left, below and below-left).
 */
export class SkinTable {
  private readonly full = new Map<string, Counts>();
  private readonly coarse = new Map<string, Counts>();

  private static put(m: Map<string, Counts>, k: string, t: number, w: number): void {
    let c = m.get(k);
    if (!c) m.set(k, (c = new Map()));
    c.set(t, (c.get(t) ?? 0) + w);
  }

  train(g: GridLike, w = 1, x0 = 0, x1 = g.w - 1): void {
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= g.w || y >= g.h ? OUT : g.cells[y * g.w + x]);
    for (let x = Math.max(0, x0); x <= Math.min(g.w - 1, x1); x++)
      for (let y = 0; y < g.h; y++) {
        const t = g.cells[y * g.w + x];
        if (!SOLID_TILES.has(t)) continue;
        const ab = SOLID_TILES.has(at(x, y - 1)) ? 1 : 0;
        const be = SOLID_TILES.has(at(x, y + 1)) ? 1 : 0;
        SkinTable.put(this.full, `${ab}|${be}|${at(x - 1, y)}`, t, w);
        SkinTable.put(this.coarse, `${ab}|${be}`, t, w);
      }
  }

  /** The likeliest tile for a solid cell, or `fallback` when nothing was seen. */
  pick(above: boolean, below: boolean, left: number, fallback: number): number {
    const k = `${above ? 1 : 0}|${below ? 1 : 0}`;
    const c = this.full.get(`${k}|${left}`) ?? this.coarse.get(k);
    if (!c) return fallback;
    let best = fallback;
    let bw = -1;
    for (const [t, v] of [...c].sort((a, b) => a[0] - b[0])) if (v > bw) [best, bw] = [t, v];
    return best;
  }
}

function total(c: Counts): number {
  let s = 0;
  for (const v of c.values()) s += v;
  return s;
}

let referenceCache: { grid: GridLike; originY: number }[] | null = null;

/** The reference sections as training grids, bottom-aligned in a 20-row level (parsed once). */
export function referenceGrids(): readonly { grid: GridLike; originY: number }[] {
  referenceCache ??= REFERENCE_SECTIONS.map((s) => {
    const rows = s.text.replace(/\r\n/g, "\n").split("\n").filter((r) => r.length > 0);
    const { grid } = parseAscii(rows);
    return { grid, originY: LEVEL_H - grid.h };
  });
  return referenceCache;
}

/** Reference prior plus the person's window up to the frontier, weighted. */
export function chainFor(g: WindowGrid, originY: number, frontierX: number, personWeight: number): MarkovChain {
  const c = new MarkovChain();
  for (const r of referenceGrids()) c.train(r.grid, r.originY);
  if (frontierX >= 0) c.train({ w: g.w, h: g.h, cells: g.tiles }, originY, personWeight, 0, Math.min(g.w - 1, frontierX));
  return c;
}

/** The material layer, trained like the chain (the person's cells weigh more). */
export function skinFor(g: WindowGrid, frontierX: number, personWeight: number): SkinTable {
  const s = new SkinTable();
  for (const r of referenceGrids()) s.train(r.grid);
  if (frontierX >= 0) s.train({ w: g.w, h: g.h, cells: g.tiles }, personWeight, 0, Math.min(g.w - 1, frontierX));
  return s;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MarkovFillerOptions {
  /** Weight of each cell the person drew, against 1 for a reference cell (default 6). */
  personWeight?: number;
  /** Candidates tried per call, in order, until one passes the rule check (default 4). */
  candidates?: number;
  /** Resamples after a rule-check failure, per candidate (default 6). */
  resamples?: number;
  /** Columns of an extend (default 5..12, also bounded by the window). */
  minWidth?: number;
  maxWidth?: number;
  /** Cell cap of one ghost (default 40, the prompt's limit). */
  maxCells?: number;
  seed?: number;
  config?: Pick<GhostConfig, "kinds">;
  clock?: () => number;
}

export interface MarkovProposal {
  answer: ModelAnswer;
  /** Candidates sampled, how many passed the rule check, resamples spent. */
  candidates: number;
  valid: number;
  resamples: number;
  /** Mean log-probability per structure cell of the chosen candidate. */
  logp?: number;
  attempt: number;
  ms: number;
}

const decline = (label: string): ModelAnswer => ({ act: false, kind: "extend", adds: [], removes: [], entities: [], confidence: 0, label });
const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const round2 = (n: number) => Math.round(n * 100) / 100;

export class MarkovFiller implements Filler {
  readonly name: FillerName = "markov";
  private readonly attempts = new Map<string, number>();
  private readonly clock: () => number;
  lastProposal: MarkovProposal | null = null;

  constructor(private readonly opts: MarkovFillerOptions = {}) {
    this.clock = opts.clock ?? defaultClock;
  }

  async fill(request: FillRequest, signal?: AbortSignal): Promise<Suggestion | null> {
    const t0 = this.clock();
    throwIfAborted(signal);
    const p = this.propose(request);
    const hash = await requestHash(request);
    throwIfAborted(signal);
    return modelAnswerToSuggestion(p.answer, request, { filler: this.name, requestHash: hash, latencyMs: this.clock() - t0 });
  }

  /** The answer for a request (window-relative). Pure apart from the attempt counter. */
  propose(req: FillRequest): MarkovProposal {
    const t0 = this.clock();
    const { previousFailure: _pf, ...base } = req;
    const key = requestHashSync(base);
    const attempt = this.attempts.get(key) ?? 0;
    this.attempts.set(key, attempt + 1);
    if (this.attempts.size > 256) this.attempts.delete(this.attempts.keys().next().value as string);
    const done = (p: Omit<MarkovProposal, "attempt" | "ms">): MarkovProposal => {
      const out = { ...p, attempt, ms: this.clock() - t0 };
      this.lastProposal = out;
      return out;
    };
    const none = (label: string) => done({ answer: decline(label), candidates: 0, valid: 0, resamples: 0 });

    if (req.mode === "patrol" || req.mode === "tidy") return none("the markov filler does not propose fixes");
    if (!(this.opts.config ?? liveConfig).kinds.extend) return none("extend is off");
    const g = parseWindowGrid(req);
    if (!g) return none("unreadable window");
    const { w, h } = g;
    const anchor = extendAnchor(req, w, h);
    if (!anchor) return none("nothing drawn in the window to continue");
    const { x: fx, y: fy } = anchor;
    const solidAt = (s: ArrayLike<number>, x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && SOLID_TILES.has(s[y * w + x]);

    // The surface the knight stands on at the anchor column (as AlgoFiller).
    let sy = -1;
    for (let y = fy; y < h && sy < 0; y++) if (solidAt(g.tiles, fx, y) && !solidAt(g.tiles, fx, y - 1)) sy = y;
    for (let y = fy - 1; y >= 0 && sy < 0; y--) if (solidAt(g.tiles, fx, y) && !solidAt(g.tiles, fx, y - 1)) sy = y;
    if (sy < 1) return none("nothing to stand on where the drawing ends");

    const x0 = fx + 1;
    const width = Math.min(this.opts.maxWidth ?? 12, w - x0);
    const minWidth = this.opts.minWidth ?? 5;
    if (width < minWidth) return none("no room to extend");

    const chain = chainFor(g, req.origin.y, fx, this.opts.personWeight ?? 6);
    const entityAt = new Set(g.entities.map((e) => e.y * w + e.x));
    const fixed = (i: number) => g.tiles[i] !== 0 || g.blocked[i] === 1 || entityAt.has(i);
    const n = Math.max(1, this.opts.candidates ?? 4);
    const resamples = Math.max(0, this.opts.resamples ?? 6);
    const maxCells = this.opts.maxCells ?? 40;
    const seed0 = ((this.opts.seed ?? 0) * 7919 + (req.origin.x + fx) * 131 + (req.origin.y + sy) * 17 + attempt * 1009) >>> 0;

    type Cand = { cells: Uint8Array; end: number; logp: number };
    let best: Cand | null = null;
    let valid = 0;
    let spent = 0;
    for (let k = 0; k < n; k++) {
      const rand = rng(seed0 + k * 2654435761);
      const cells = Uint8Array.from(g.tiles);
      const sample = (from: number) => {
        for (let x = from; x < x0 + width; x++)
          for (let y = h - 1; y >= 0; y--) {
            const i = y * w + x;
            if (fixed(i)) continue;
            const left = x > 0 ? cells[i - 1] : OUT;
            const below = y + 1 < h ? cells[i + w] : OUT;
            const diag = x > 0 && y + 1 < h ? cells[i + w - 1] : OUT;
            const d = chain.dist(req.origin.y + y, left, below, diag);
            let r = rand();
            let t = d.tiles[d.tiles.length - 1];
            for (let j = 0; j < d.tiles.length; j++) {
              r -= d.p[j];
              if (r <= 0) {
                t = d.tiles[j];
                break;
              }
            }
            cells[i] = t;
          }
        // A lone sampled tile (no solid neighbour) is chain noise, not style: clear it.
        for (let x = from; x < x0 + width; x++)
          for (let y = 0; y < h; y++) {
            const i = y * w + x;
            if (fixed(i) || cells[i] === 0) continue;
            if (!solidAt(cells, x - 1, y) && !solidAt(cells, x + 1, y) && !solidAt(cells, x, y - 1) && !solidAt(cells, x, y + 1)) cells[i] = 0;
          }
      };
      sample(x0);
      let end = this.capColumns(cells, g, fixed, x0, width, maxCells);
      let ok = false;
      for (let tries = 0; tries <= resamples; tries++) {
        if (end - x0 + 1 >= Math.min(minWidth, width)) {
          const verdict = this.check(cells, w, h, fx, sy, end);
          if (verdict.ok) {
            ok = true;
            break;
          }
          if (tries === resamples) break;
          // Resample only past the furthest point the knight reached.
          const from = Math.max(x0, Math.min(x0 + width - 1, (verdict.blockedAt?.x ?? fx) + 1));
          sample(from);
        } else {
          if (tries === resamples) break;
          sample(x0);
        }
        spent++;
        end = this.capColumns(cells, g, fixed, x0, width, maxCells);
      }
      if (!ok) continue;
      // Clear anything sampled past the capped end.
      for (let x = end + 1; x < x0 + width; x++) for (let y = 0; y < h; y++) if (!fixed(y * w + x)) cells[y * w + x] = 0;
      let adds = 0;
      for (let x = x0; x <= end; x++) for (let y = 0; y < h; y++) if (!fixed(y * w + x) && cells[y * w + x] !== 0) adds++;
      if (adds === 0) continue;
      valid++;
      best = { cells, end, logp: structureLogp(chain, cells, g, fixed, x0, end, req.origin.y) };
      break;
    }
    if (!best) return done({ answer: decline("no playable continuation in this style"), candidates: n, valid: 0, resamples: spent });

    // Material pass: solidity is fixed now, so every cell knows what is above it.
    const skin = skinFor(g, fx, this.opts.personWeight ?? 6);
    for (let x = x0; x <= best.end; x++)
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (fixed(i) || !SOLID_TILES.has(best.cells[i])) continue;
        best.cells[i] = skin.pick(solidAt(best.cells, x, y - 1), solidAt(best.cells, x, y + 1), best.cells[i - 1], best.cells[i]);
      }

    const adds: ModelAnswer["adds"] = [];
    for (let x = x0; x <= best.end; x++)
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        const name = NAME_BY_TILE[best.cells[i]] as TileName | undefined;
        if (!fixed(i) && best.cells[i] !== 0 && name) adds.push({ x, y, tile: name });
      }
    const answer: ModelAnswer = {
      act: true,
      kind: "extend",
      adds,
      removes: [],
      entities: [],
      confidence: round2(0.2 + 0.4 * Math.exp(best.logp)),
      label: markovLabel(best.cells, w, h, fx, sy, x0, best.end, g.tiles),
    };
    return done({ answer, candidates: n, valid, resamples: spent, logp: best.logp });
  }

  /** Last column to keep so the new cells stay under the cap (whole columns). */
  private capColumns(cells: Uint8Array, g: WindowGrid, fixed: (i: number) => boolean, x0: number, width: number, maxCells: number): number {
    let count = 0;
    let end = x0 - 1;
    for (let x = x0; x < x0 + width; x++) {
      let col = 0;
      for (let y = 0; y < g.h; y++) if (!fixed(y * g.w + x) && cells[y * g.w + x] !== 0) col++;
      if (count + col > maxCells) break;
      count += col;
      end = x;
    }
    return end;
  }

  private check(cells: Uint8Array, w: number, h: number, fx: number, sy: number, end: number) {
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) solid[i] = SOLID_TILES.has(cells[i]) ? 1 : 0;
    const grid: SolidGrid = { w, h, solid };
    return checkRules(grid, { x: fx, y: sy - 1 }, { x0: end, x1: end }, { tier: "NORMAL", xRange: [Math.max(0, fx - 8), end] });
  }
}

/**
 * Where an extend starts: the rightmost cell the person recently painted
 * inside the window (their own stroke, e.g. a platform drawn on a long
 * starter floor), else the frontier when it is in the window. The stream's
 * frontier follows contiguous ground and often lies past the window's edge.
 * Window-relative; null when neither is usable.
 */
export function extendAnchor(req: Pick<FillRequest, "recent" | "frontier">, w: number, h: number): { x: number; y: number } | null {
  const inside = (p: { x: number; y: number }) => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < w - 1 && p.y >= 0 && p.y < h;
  let best: { x: number; y: number } | null = null;
  for (const r of req.recent) if (r.tool === "paint" && inside(r) && (!best || r.x > best.x)) best = { x: r.x, y: r.y };
  if (best) return best;
  return inside(req.frontier) ? { x: req.frontier.x, y: req.frontier.y } : null;
}

/**
 * Mean log-probability of the sampled cells that touch structure (the cell
 * or a context neighbour is solid), so open sky does not flatter a sample.
 */
function structureLogp(
  chain: MarkovChain,
  cells: Uint8Array,
  g: WindowGrid,
  fixed: (i: number) => boolean,
  x0: number,
  end: number,
  originY: number,
): number {
  const { w, h } = g;
  let sum = 0;
  let n = 0;
  for (let x = x0; x <= end; x++)
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (fixed(i)) continue;
      const left = cells[i - 1];
      const below = y + 1 < h ? cells[i + w] : OUT;
      const diag = y + 1 < h ? cells[i + w - 1] : OUT;
      if (cells[i] === 0 && !SOLID_TILES.has(left) && !SOLID_TILES.has(below) && !SOLID_TILES.has(diag)) continue;
      sum += Math.log(chain.prob(originY + y, left, below, diag, cells[i]));
      n++;
    }
  return n ? sum / n : Math.log(0.5);
}

/**
 * "extend: gap 2, step up 1" from the surface of the new columns. With `base`
 * (the window before the ghost), only added cells count, so a gap over a
 * floor that was already there reads as a gap, not a drop to that floor.
 */
export function markovLabel(
  cells: ArrayLike<number>,
  w: number,
  h: number,
  fx: number,
  sy: number,
  x0: number,
  end: number,
  base?: ArrayLike<number>,
): string {
  const top = (x: number) => {
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (SOLID_TILES.has(cells[i]) && (x <= fx || !base || base[i] !== cells[i])) return y;
    }
    return -1;
  };
  const parts: string[] = [];
  let prev = top(fx) >= 0 ? top(fx) : sy;
  let gap = 0;
  for (let x = x0; x <= end; x++) {
    const t = top(x);
    if (t < 0) {
      gap++;
      continue;
    }
    if (gap) parts.push(`gap ${gap}`);
    gap = 0;
    if (t < prev) parts.push(`step up ${prev - t}`);
    else if (t > prev) parts.push(`drop ${t - prev}`);
    prev = t;
  }
  if (gap) parts.push(`gap ${gap}`);
  const shown = parts.slice(0, 3).join(", ") + (parts.length > 3 ? ", ..." : "");
  return `extend: ${shown || "a flat run"}`.slice(0, 80);
}
