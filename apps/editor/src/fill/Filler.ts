/**
 * G-10 — The Filler interface, a registry that makes the active filler a
 * config value, and StubFiller (a deterministic staircase continuation used
 * for development, e2e tests and the "stub" study condition).
 *
 * Nothing outside fill/ should know which filler is active: callers hold a
 * FillerRegistry and call registry.fill(request, signal).
 */
import {
  TILE_BY_NAME,
  type Filler,
  type FillerName,
  type FillRequest,
  type ModelAnswer,
  type Point,
  type RecentPlacement,
  type Suggestion,
  type TileName,
} from "../contracts";
import { config as liveConfig, type GhostConfig } from "../suggest/config";
import { modelAnswerToSuggestion, type AnswerMeta } from "./answer";
import { requestHash } from "./hash";
import type { PlacementStream } from "./stream";
import { EMPTY_GLYPH, gridRows, PATROL_GLYPH } from "./window";

export type { Filler, FillerName } from "../contracts";

export const FILLER_NAMES: readonly FillerName[] = ["llm", "algo", "stub", "jev"];
export const isFillerName = (v: unknown): v is FillerName =>
  typeof v === "string" && (FILLER_NAMES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Abort helpers (shared by fillers)
// ---------------------------------------------------------------------------

/** The error a filler rejects with when its signal aborts (name "AbortError"). */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error(typeof reason === "string" ? reason : "fill aborted");
  err.name = "AbortError";
  return err;
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** setTimeout as a promise that rejects with AbortError when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type ActiveFiller = FillerName | "none";

/** Holds the available fillers and which one is active ("none" = human-only editing). */
export class FillerRegistry {
  private readonly fillers = new Map<FillerName, Filler>();
  private current: ActiveFiller = "none";

  constructor(fillers: readonly Filler[] = [], active?: ActiveFiller) {
    for (const f of fillers) this.register(f);
    if (active) this.setActive(active);
  }

  /** Add or replace the filler with this name. Returns this. */
  register(filler: Filler): this {
    if (!isFillerName(filler.name)) throw new TypeError(`unknown filler name ${String(filler.name)}`);
    this.fillers.set(filler.name, filler);
    return this;
  }

  /** Remove a filler; if it was active, the registry falls back to "none". */
  unregister(name: FillerName): boolean {
    const had = this.fillers.delete(name);
    if (had && this.current === name) this.current = "none";
    return had;
  }

  has(name: FillerName): boolean {
    return this.fillers.has(name);
  }

  get(name: FillerName): Filler | undefined {
    return this.fillers.get(name);
  }

  names(): FillerName[] {
    return [...this.fillers.keys()];
  }

  get activeName(): ActiveFiller {
    return this.current;
  }

  get active(): Filler | undefined {
    return this.current === "none" ? undefined : this.fillers.get(this.current);
  }

  /** Switch the active filler. Throws if `name` is not registered. */
  setActive(name: ActiveFiller): void {
    if (name !== "none" && !this.fillers.has(name)) throw new Error(`filler "${name}" is not registered`);
    this.current = name;
  }

  /**
   * Follow config.filler. An unregistered name falls back to "none" (and is
   * returned so the caller can log it). Returns the name now active.
   */
  useConfig(cfg: Pick<GhostConfig, "filler"> = liveConfig): ActiveFiller {
    const want = cfg.filler;
    this.current = want !== "none" && this.fillers.has(want) ? want : "none";
    return this.current;
  }

  /** Ask the active filler; null when none is active. */
  fill(request: FillRequest, signal?: AbortSignal): Promise<Suggestion | null> {
    const f = this.active;
    if (!f) return Promise.resolve(null);
    return f.fill(request, signal);
  }
}

// ---------------------------------------------------------------------------
// StubFiller
// ---------------------------------------------------------------------------

export interface StubFillerOptions {
  /** Steps to add (default 3). */
  steps?: number;
  /** Confidence stated on every suggestion (default 0.8). */
  confidence?: number;
  /** Artificial latency, ms (default 0). Honours the abort signal. */
  delayMs?: number;
  /** Put a coin above the last step when there is room (default true). */
  coin?: boolean;
  /** Read placements from this stream instead of request.recent. */
  stream?: PlacementStream;
  /** Clock for latencyMs (default performance.now / Date.now). */
  clock?: () => number;
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * The stub's answer for a request, window-relative (exported for tests and
 * for the offline suite's baseline). Continues the last painted terrain cell
 * diagonally: same horizontal direction as the last two distinct paints
 * (default right), same vertical direction (default up; a flat run turns into
 * steps up). Steps stop at the window edge or at a non-empty cell; if nothing
 * fits it tries the other vertical, then the other horizontal direction.
 */
export function stubStaircase(
  request: Pick<FillRequest, "grid" | "size" | "frontier" | "recent">,
  opts: { steps?: number; confidence?: number; coin?: boolean; recent?: RecentPlacement[] } = {},
): ModelAnswer {
  const steps = Math.max(1, Math.floor(opts.steps ?? 3));
  const rows = gridRows(request.grid);
  const known = rows.length === request.size.h;
  const inWin = (x: number, y: number) => x >= 0 && y >= 0 && x < request.size.w && y < request.size.h;
  const empty = (x: number, y: number) => {
    if (!inWin(x, y)) return false;
    if (!known) return true;
    const g = rows[y][x];
    return g === EMPTY_GLYPH || g === PATROL_GLYPH;
  };

  const recent = opts.recent ?? request.recent;
  const paints = recent.filter(
    (r) => r.tool === "paint" && Object.prototype.hasOwnProperty.call(TILE_BY_NAME, r.tile),
  );
  let base: Point;
  let tile: TileName = "grass";
  let dx = 1;
  let dy = -1;
  if (paints.length) {
    const last = paints[paints.length - 1];
    base = { x: last.x, y: last.y };
    tile = last.tile as TileName;
    for (let i = paints.length - 2; i >= 0; i--) {
      const p = paints[i];
      if (p.x === last.x && p.y === last.y) continue;
      dx = sign(last.x - p.x) || 1;
      dy = sign(last.y - p.y) || -1;
      break;
    }
  } else {
    base = { x: request.frontier.x, y: request.frontier.y };
  }

  const tryDir = (sx: number, sy: number) => {
    const out: Point[] = [];
    for (let k = 1; k <= steps; k++) {
      const p = { x: base.x + k * sx, y: base.y + k * sy };
      // Need the cell itself and the cell above it (headroom) free.
      if (!empty(p.x, p.y) || (inWin(p.x, p.y - 1) && !empty(p.x, p.y - 1))) break;
      out.push(p);
    }
    return out;
  };
  let cells: Point[] = [];
  for (const [sx, sy] of [
    [dx, dy],
    [dx, -dy],
    [-dx, dy],
    [-dx, -dy],
  ]) {
    cells = tryDir(sx, sy);
    if (cells.length) break;
  }

  if (!cells.length) {
    return { act: false, kind: "extend", adds: [], removes: [], entities: [], confidence: 0, label: "no room for steps" };
  }
  const entities: ModelAnswer["entities"] = [];
  const top = cells[cells.length - 1];
  if (opts.coin !== false && empty(top.x, top.y - 1)) entities.push({ kind: "coin", x: top.x, y: top.y - 1 });
  return {
    act: true,
    kind: "extend",
    adds: cells.map((p) => ({ x: p.x, y: p.y, tile })),
    removes: [],
    entities,
    confidence: opts.confidence ?? 0.8,
    label: `staircase, ${cells.length} more step${cells.length === 1 ? "" : "s"}`,
    levelGuess: "stub",
  };
}

const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class StubFiller implements Filler {
  readonly name: FillerName = "stub";
  private readonly opts: StubFillerOptions;
  private readonly clock: () => number;

  constructor(opts: StubFillerOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? defaultClock;
  }

  async fill(request: FillRequest, signal?: AbortSignal): Promise<Suggestion | null> {
    const t0 = this.clock();
    throwIfAborted(signal);
    if (this.opts.delayMs && this.opts.delayMs > 0) await sleep(this.opts.delayMs, signal);
    const recent = this.opts.stream
      ? this.opts.stream.recent(liveConfig.recentCount, request.origin)
      : undefined;
    const answer = stubStaircase(request, { ...this.opts, recent });
    const hash = await requestHash(request);
    throwIfAborted(signal);
    const meta: AnswerMeta = { filler: this.name, requestHash: hash, latencyMs: this.clock() - t0 };
    return modelAnswerToSuggestion(answer, request, meta);
  }
}
