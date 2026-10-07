/**
 * G-34 — AlgoFiller: the "with algo" comparison condition. Same Filler
 * interface, same validator, verifier and ghost layer as the LLM filler; no
 * model calls.
 *
 *  - Finish: local detectors (@chunks detectFinish) over the request's recent
 *    placements and window: constant-offset repeats (staircase, row, column,
 *    pillars, platforms, coin arcs) and open structures (platform end cap,
 *    pit floor).
 *  - Extend: chunkgen-style chunks (@chunks generateChunk) laid out from the
 *    frontier, parameterised by a style profile measured from the window
 *    (request.measured), each rule-checked on the window with the chunk in
 *    place; of the candidates that pass, the one least like the recent
 *    ghosts is offered.
 *  - Patrol (Fix): not handled; returns null.
 *  - Confidence: a timing rule instead of a model's say-so. A repeat seen 3+
 *    times -> 0.85; an open structure -> 0.7; a 2-repeat -> 0.55; Extend at a
 *    pause near the frontier -> 0.5, otherwise 0.3. Proposals that do not
 *    continue the very last placement are scaled down.
 *
 * Everything is read from the FillRequest (the ASCII window is parsed back
 * into tiles), so the filler works wherever the LLM filler does: live, in
 * the offline suite and in pure generation (generate.ts).
 */
import { checkRules, type SolidGrid } from "@physsim";
import type { Tier } from "@jump-tables";
import {
  capsFor,
  chunkTags,
  detectFinish,
  generateChunk,
  profileFromMeasured,
  type DetectGrid,
  type DetectOptions,
  type FinishProposal,
  type GeneratedChunk,
} from "@chunks";
import {
  NAME_BY_TILE,
  TILE_BY_NAME,
  type EntityKind,
  type Filler,
  type FillerName,
  type FillRequest,
  type GhostHistoryItem,
  type ModelAnswer,
  type Suggestion,
  type TileName,
} from "../contracts";
import { config as liveConfig, type GhostConfig } from "../suggest/config";
import { modelAnswerToSuggestion } from "./answer";
import { throwIfAborted } from "./Filler";
import { requestHash, requestHashSync } from "./hash";
import {
  EMPTY_GLYPH,
  ENTITY_GLYPH,
  GHOST_GLYPH,
  gridRows,
  OUTSIDE_GLYPH,
  PATROL_GLYPH,
  PERSON_GLYPH,
  START_GLYPH,
} from "./window";

// ---------------------------------------------------------------------------
// Timing rule
// ---------------------------------------------------------------------------

export interface AlgoTiming {
  /** Finish of a repeat seen 3+ times ("repeat of 3"). */
  repeatConfidence: number;
  /** Finish of an open structure (end cap, pit floor). */
  openConfidence: number;
  /** Finish of a repeat seen twice. */
  weakRepeatConfidence: number;
  /** Multiplier when the Finish does not continue the very last placement. */
  staleFactor: number;
  /** Extend when the person has paused near the frontier ("pause at frontier"). */
  pauseConfidence: number;
  /** Extend while still drawing or away from the frontier. */
  busyConfidence: number;
  /** "Near the frontier": the last placement within this many columns of it. */
  frontierNear: number;
}

export const ALGO_TIMING: AlgoTiming = {
  repeatConfidence: 0.85,
  openConfidence: 0.7,
  weakRepeatConfidence: 0.55,
  staleFactor: 0.6,
  pauseConfidence: 0.5,
  busyConfidence: 0.3,
  frontierNear: 3,
};

/** Confidence-like number for a Finish proposal. */
export function finishConfidence(p: Pick<FinishProposal, "repeats" | "open" | "touchesLast">, t: AlgoTiming = ALGO_TIMING): number {
  const base = p.open ? t.openConfidence : p.repeats >= 3 ? t.repeatConfidence : t.weakRepeatConfidence;
  return round2(p.touchesLast ? base : base * t.staleFactor);
}

/** Confidence-like number for an Extend at this request's frontier. */
export function extendConfidence(
  req: Pick<FillRequest, "frontier" | "recent" | "mode">,
  pauseMs: number,
  t: AlgoTiming = ALGO_TIMING,
): number {
  const last = [...req.recent].reverse().find((r) => r.tool === "paint") ?? req.recent[req.recent.length - 1];
  const near = !last || Math.abs(last.x - req.frontier.x) <= t.frontierNear;
  const paused = req.frontier.idleMs >= pauseMs;
  const c = paused && near ? t.pauseConfidence : t.busyConfidence;
  return req.mode === "requested" ? Math.max(c, t.pauseConfidence) : c;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Window parsing
// ---------------------------------------------------------------------------

const TILE_BY_GLYPH = new Map<string, number>();
for (const [t, g] of Object.entries(PERSON_GLYPH)) TILE_BY_GLYPH.set(g, Number(t));
for (const [t, g] of Object.entries(GHOST_GLYPH)) TILE_BY_GLYPH.set(g, Number(t));
const ENTITY_BY_GLYPH = new Map<string, EntityKind>();
for (const [k, g] of Object.entries(ENTITY_GLYPH)) ENTITY_BY_GLYPH.set(g, k as EntityKind);

/** The request's window as tiles, a solid mask and entities (window-relative). */
export interface WindowGrid extends DetectGrid {
  tiles: Uint8Array;
  blocked: Uint8Array;
  solid: Uint8Array;
  entities: { kind: EntityKind; x: number; y: number }[];
}

/** Parse request.grid back into tiles. Null when the grid does not match request.size. */
export function parseWindowGrid(req: Pick<FillRequest, "grid" | "size">): WindowGrid | null {
  const rows = gridRows(req.grid);
  const { w, h } = req.size;
  if (rows.length !== h || rows.some((r) => r.length !== w)) return null;
  const tiles = new Uint8Array(w * h);
  const blocked = new Uint8Array(w * h);
  const solid = new Uint8Array(w * h);
  const entities: WindowGrid["entities"] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const g = row[x];
      const i = y * w + x;
      if (g === EMPTY_GLYPH || g === PATROL_GLYPH) continue;
      const t = TILE_BY_GLYPH.get(g) ?? (g === "X" || g === "x" ? 1 : undefined);
      if (t !== undefined) {
        tiles[i] = t;
        solid[i] = 1;
        continue;
      }
      if (g === OUTSIDE_GLYPH || g === START_GLYPH) {
        blocked[i] = 1;
        continue;
      }
      const kind = ENTITY_BY_GLYPH.get(g);
      if (kind) {
        entities.push({ kind, x, y });
        if (kind === "flag") blocked[i] = 1;
      }
    }
  });
  return { w, h, tiles, blocked, solid, entities };
}

// ---------------------------------------------------------------------------
// The filler
// ---------------------------------------------------------------------------

export interface AlgoFillerOptions {
  /** Base seed for Extend candidates (default 0; the request is mixed in). */
  seed?: number;
  /** Extend candidates generated per call (default 8). */
  candidates?: number;
  /** Extend width bounds in columns (default 6..14). */
  minWidth?: number;
  maxWidth?: number;
  /** Jump tier for the generator caps and the rule check (default NORMAL). */
  tier?: Tier;
  timing?: Partial<AlgoTiming>;
  /** Kinds enabled and the pause length (default the live config). */
  config?: Pick<GhostConfig, "kinds" | "pauseMs">;
  detect?: DetectOptions;
  clock?: () => number;
}

export interface AlgoProposal {
  answer: ModelAnswer;
  source: "finish" | "extend" | "none";
  finish?: FinishProposal;
  chunk?: GeneratedChunk;
  /** Extend: candidates generated and how many passed the rule check. */
  candidates?: number;
  valid?: number;
  /** Times this same request (ignoring previousFailure) has been answered, 0 = first. */
  attempt: number;
  ms: number;
}

const decline = (label: string): ModelAnswer => ({
  act: false,
  kind: "extend",
  adds: [],
  removes: [],
  entities: [],
  confidence: 0,
  label,
});

const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const isTileName = (t: string): t is TileName => Object.prototype.hasOwnProperty.call(TILE_BY_NAME, t);

export class AlgoFiller implements Filler {
  readonly name: FillerName = "algo";
  private readonly opts: AlgoFillerOptions;
  private readonly timing: AlgoTiming;
  private readonly clock: () => number;
  /** request key -> times answered (send-backs and repeats move to the next proposal). */
  private readonly attempts = new Map<string, number>();
  lastProposal: AlgoProposal | null = null;

  constructor(opts: AlgoFillerOptions = {}) {
    this.opts = opts;
    this.timing = { ...ALGO_TIMING, ...opts.timing };
    this.clock = opts.clock ?? defaultClock;
  }

  private get cfg(): Pick<GhostConfig, "kinds" | "pauseMs"> {
    return this.opts.config ?? liveConfig;
  }

  async fill(request: FillRequest, signal?: AbortSignal): Promise<Suggestion | null> {
    const t0 = this.clock();
    throwIfAborted(signal);
    const p = this.propose(request);
    const hash = await requestHash(request);
    throwIfAborted(signal);
    return modelAnswerToSuggestion(p.answer, request, { filler: this.name, requestHash: hash, latencyMs: this.clock() - t0 });
  }

  /** The answer for a request (window-relative), with what produced it. Synchronous and pure apart from the attempt counter. */
  propose(req: FillRequest): AlgoProposal {
    const t0 = this.clock();
    const { previousFailure: _pf, ...base } = req;
    const key = requestHashSync(base);
    const attempt = this.attempts.get(key) ?? 0;
    this.attempts.set(key, attempt + 1);
    if (this.attempts.size > 256) this.attempts.delete(this.attempts.keys().next().value as string);

    const done = (p: Omit<AlgoProposal, "attempt" | "ms">): AlgoProposal => {
      const out = { ...p, attempt, ms: this.clock() - t0 };
      this.lastProposal = out;
      return out;
    };
    if (req.mode === "patrol") return done({ answer: decline("the algorithm filler does not propose fixes"), source: "none" });
    const grid = parseWindowGrid(req);
    if (!grid) return done({ answer: decline("unreadable window"), source: "none" });

    const kinds = this.cfg.kinds;
    if (kinds.finish) {
      const proposals = detectFinish(
        grid,
        req.recent.map((r) => ({ x: r.x, y: r.y, tile: r.tile, tool: r.tool })),
        this.opts.detect,
      );
      // A send-back (or the same request again) moves on to the next proposal.
      const f = proposals[attempt];
      if (f) return done({ answer: this.finishAnswer(f), source: "finish", finish: f });
    }
    if (kinds.extend) {
      const e = this.extend(req, grid, attempt);
      if (e) return done(e);
    }
    return done({ answer: decline("nothing to finish and no room to extend"), source: "none" });
  }

  private finishAnswer(f: FinishProposal): ModelAnswer {
    return {
      act: true,
      kind: "finish",
      adds: f.adds.map((a) => ({ x: a.x, y: a.y, tile: isTileName(a.tile) ? a.tile : "grass" })),
      removes: [],
      entities: f.entities.map((e) => ({ kind: e.kind as EntityKind, x: e.x, y: e.y })),
      confidence: finishConfidence(f, this.timing),
      label: f.label,
      levelGuess: "algo",
    };
  }

  private extend(req: FillRequest, g: WindowGrid, attempt: number): Omit<AlgoProposal, "attempt" | "ms"> | null {
    const { w, h } = g;
    const fx = req.frontier.x;
    const fy = req.frontier.y;
    if (!Number.isInteger(fx) || !Number.isInteger(fy) || fx < 0 || fx >= w || fy < 0 || fy >= h) return null;
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && g.solid[y * w + x] === 1;

    // The surface at the frontier column: the frontier cell, else the nearest solid below, else above.
    let sy = -1;
    for (let y = fy; y < h && sy < 0; y++) if (solid(fx, y) && !solid(fx, y - 1)) sy = y;
    for (let y = fy - 1; y >= 0 && sy < 0; y--) if (solid(fx, y) && !solid(fx, y - 1)) sy = y;
    if (sy < 1) return null;

    const x0 = fx + 1;
    const width = Math.min(this.opts.maxWidth ?? 14, w - x0);
    if (width < (this.opts.minWidth ?? 6)) return null;
    let depth = 0;
    while (depth < 3 && solid(fx, sy + depth)) depth++;
    const tileName = (x: number, y: number): TileName | undefined => NAME_BY_TILE[g.tiles[y * w + x]];
    const surfaceTile: TileName = tileName(fx, sy) ?? "grass";
    const fillTile: TileName = (solid(fx, sy + 1) ? tileName(fx, sy + 1) : undefined) ?? surfaceTile;

    const tier = this.opts.tier ?? "NORMAL";
    const caps = capsFor(tier);
    const profile = profileFromMeasured(req.measured, req.knight, { fillDepth: Math.max(1, depth) });
    const n = Math.max(1, this.opts.candidates ?? 8);
    const seedBase =
      ((this.opts.seed ?? 0) * 7919 + (req.origin.x + fx) * 131 + (req.origin.y + sy) * 17 + attempt * n) % 2147483647;
    const entityAt = new Set(g.entities.map((e) => `${e.x},${e.y}`));
    const free = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < w && y < h && !g.solid[y * w + x] && !g.blocked[y * w + x] && !entityAt.has(`${x},${y}`);

    type Cand = { chunk: GeneratedChunk; answer: ModelAnswer; score: number };
    let best: Cand | null = null;
    let valid = 0;
    for (let k = 0; k < n; k++) {
      const chunk = generateChunk({ w: width, h, ground: sy, seed: Math.abs(seedBase + k), profile, caps });
      const platform = new Set(chunk.platforms.map((p) => `${p.x},${p.y}`));
      const adds: ModelAnswer["adds"] = [];
      const merged = Uint8Array.from(g.solid);
      let clash = false;
      for (let cy = 0; cy < chunk.h && !clash; cy++)
        for (let cx = 0; cx < chunk.w; cx++) {
          if (!chunk.grid[cy * chunk.w + cx]) continue;
          const x = x0 + cx;
          if (solid(x, cy)) continue;
          if (!free(x, cy)) {
            clash = true;
            break;
          }
          const top = platform.has(`${cx},${cy}`) || chunk.heights[cx] === cy;
          adds.push({ x, y: cy, tile: top ? surfaceTile : fillTile });
          merged[cy * w + x] = 1;
        }
      if (clash || adds.length === 0) continue;
      const mGrid: SolidGrid = { w, h, solid: merged };
      const xEnd = x0 + width - 1;
      const verdict = checkRules(mGrid, { x: fx, y: sy - 1 }, { x0: xEnd, x1: xEnd }, { tier, xRange: [Math.max(0, fx - 8), xEnd] });
      if (!verdict.ok) continue;
      valid++;
      const isFree = (x: number, y: number) => free(x, y) && !merged[y * w + x];
      const entities: ModelAnswer["entities"] = [];
      for (const c of chunk.coins) {
        const x = x0 + c.x;
        if (c.y >= 0 && isFree(x, c.y)) entities.push({ kind: "coin", x, y: c.y });
      }
      for (const s of chunk.slimes) {
        const x = x0 + s.x;
        if (isFree(x, s.y) && slimeFloorOk(merged, w, h, x, s.y)) entities.push({ kind: "slime", x, y: s.y });
      }
      const tags = chunkTags(chunk);
      const answer: ModelAnswer = {
        act: true,
        kind: "extend",
        adds,
        removes: [],
        entities,
        confidence: extendConfidence(req, this.cfg.pauseMs, this.timing),
        label: extendLabel(chunk),
        levelGuess: "algo",
      };
      const score = similarityToHistory(tags, answer.label, req.lastGhosts);
      if (!best || score < best.score) best = { chunk, answer, score };
    }
    if (!best) return null;
    return { answer: best.answer, source: "extend", chunk: best.chunk, candidates: n, valid };
  }
}

/** A slime needs >= 4 tiles of floor and must not stand at the very edge of it (a landing). */
function slimeFloorOk(solid: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  if (y + 1 >= h) return false;
  const floor = (cx: number) => cx >= 0 && cx < w && solid[(y + 1) * w + cx] === 1 && solid[y * w + cx] === 0;
  if (!floor(x)) return false;
  let a = x;
  let b = x;
  while (floor(a - 1)) a--;
  while (floor(b + 1)) b++;
  return b - a + 1 >= 4 && x - a >= 1 && b - x >= 1;
}

/** "extend: pit 3, step up 1, coin arc 4" (flat runs left out unless that is all there is). */
export function extendLabel(chunk: Pick<GeneratedChunk, "desc">): string {
  const parts = chunk.desc.filter((d) => !d.startsWith("flat"));
  const shown = parts.slice(0, 3).join(", ") + (parts.length > 3 ? ", ..." : "");
  return `extend: ${shown || "a flat run"}`.slice(0, 80);
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z-]+/)
    .filter((w) => w.length > 2 && w !== "extend" && w !== "finish" && w !== "more" && w !== "wide");

/**
 * How much a candidate looks like the recent ghosts, 0 (nothing in common)
 * upward. Jaccard overlap of tags (+ label words) with each past ghost's
 * patterns (or label words), weighted toward the newest.
 */
export function similarityToHistory(tags: readonly string[], label: string, history: readonly GhostHistoryItem[]): number {
  if (!history.length) return 0;
  const mine = new Set([...tags, ...words(label)]);
  let score = 0;
  history.forEach((g, i) => {
    const theirs = new Set([...(g.patterns ?? []), ...words(g.label)]);
    if (!theirs.size || !mine.size) return;
    let inter = 0;
    for (const t of mine) if (theirs.has(t)) inter++;
    const jac = inter / (mine.size + theirs.size - inter);
    score += jac * (i + 1);
  });
  return score;
}
