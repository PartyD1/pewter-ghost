/**
 * G-12 — Placement event stream, pauses and the frontier.
 *
 * A small state object fed with the person's PlacementEvents (LevelModel.onPlacement).
 * It keeps a rolling window of the last `recentCount` placements with the time
 * since the previous one, tells whether the person has paused (pauseMs /
 * longPauseMs, read from an injected clock), tracks the frontier (the rightmost
 * authored column near the last stroke, or the topmost authored row when the
 * drawing is going up), and flags placements that start a new structure (far
 * from every recent placement).
 *
 * Pure logic: no Phaser, no timers. Pause transitions are reported from
 * `poll()`, which the caller ticks (a scene update or a setInterval).
 */
import {
  AUTHOR,
  NAME_BY_TILE,
  type EntityKind,
  type PlacementEvent,
  type Point,
  type RecentPlacement,
} from "../contracts";
import { config as liveConfig } from "../suggest/config";

/** Minimal read access the frontier needs; LevelModel satisfies it. */
export interface FrontierGrid {
  readonly w: number;
  readonly h: number;
  tileAt(x: number, y: number): number;
  authorAt(x: number, y: number): number;
}

export type PauseState = "drawing" | "pause" | "longPause";
export type DrawDirection = "horizontal" | "vertical";

export interface Frontier extends Point {
  /** ms since the last placement (0 when there is none yet). */
  idleMs: number;
  direction: DrawDirection;
}

export interface StreamOptions {
  /** Session clock in ms, same base as PlacementEvent.t (default performance.now). */
  clock?: () => number;
  /** Placements kept in the rolling window (default config.recentCount). */
  recentCount?: number;
  /** Idle ms that counts as a pause (default config.pauseMs). */
  pauseMs?: number;
  /** Idle ms that counts as a long pause (default config.longPauseMs). */
  longPauseMs?: number;
  /** A placement farther than this (Chebyshev tiles) from every recent one starts a new structure (default config.newStructureTiles). */
  newStructureTiles?: number;
  /** Frontier search: largest run of empty columns (rows when vertical) still treated as the same structure (default 4). */
  frontierGap?: number;
  /** Frontier search: rows (columns when vertical) around the last stroke that count as "near" (default 5). */
  frontierBand?: number;
  /** Frontier search: furthest the frontier may lie from the last stroke, tiles (default 24). */
  frontierReach?: number;
}

export interface PushResult {
  /** This placement is far from every recent one (or is the first). */
  newStructure: boolean;
  /** Counter of structures seen so far (increments on each newStructure). */
  structure: number;
  /** dt recorded for this placement. */
  dt: number;
}

export type PauseListener = (state: PauseState, idleMs: number) => void;

const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Model-facing name of what a placement put down. */
export function placementTileName(e: Pick<PlacementEvent, "tile" | "tool">): string {
  if (e.tool === "erase" || e.tile === 0) return "erase";
  if (typeof e.tile === "string") return e.tile.startsWith("entity:") ? e.tile.slice(7) : e.tile;
  return NAME_BY_TILE[e.tile] ?? `tile${e.tile}`;
}

/** Entity kind of an entity placement, or undefined for terrain / erase. */
export function placementEntityKind(e: Pick<PlacementEvent, "tile">): EntityKind | undefined {
  return typeof e.tile === "string" && e.tile.startsWith("entity:") ? (e.tile.slice(7) as EntityKind) : undefined;
}

interface Entry {
  event: PlacementEvent;
  dt: number;
  structure: number;
}

export class PlacementStream {
  private readonly clock: () => number;
  private readonly opts: StreamOptions;
  private entries: Entry[] = [];
  private lastT: number | undefined;
  private structureCount = 0;
  private lastPollState: PauseState = "drawing";
  private readonly pauseListeners = new Set<PauseListener>();
  private grid: FrontierGrid | undefined;

  constructor(opts: StreamOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? defaultClock;
  }

  // --- tunables (read live so config overrides apply) ------------------------

  get recentCount(): number {
    return Math.max(1, Math.floor(this.opts.recentCount ?? liveConfig.recentCount));
  }
  get pauseMs(): number {
    return this.opts.pauseMs ?? liveConfig.pauseMs;
  }
  get longPauseMs(): number {
    return this.opts.longPauseMs ?? liveConfig.longPauseMs;
  }
  get newStructureTiles(): number {
    return this.opts.newStructureTiles ?? liveConfig.newStructureTiles;
  }

  // --- feeding --------------------------------------------------------------

  /**
   * Subscribe to a model's placements; the model also becomes the grid used
   * for the frontier. Returns an unsubscribe function.
   */
  attach(model: FrontierGrid & { onPlacement(fn: (e: PlacementEvent) => void): () => void }): () => void {
    this.grid = model;
    const off = model.onPlacement((e) => this.push(e));
    return () => {
      off();
      if (this.grid === model) this.grid = undefined;
    };
  }

  /** Grid used by frontier() when none is passed. */
  setGrid(grid: FrontierGrid | undefined): void {
    this.grid = grid;
  }

  /** Record one placement. */
  push(event: PlacementEvent): PushResult {
    const dt = this.lastT === undefined ? 0 : Math.max(0, event.t - this.lastT);
    this.lastT = event.t;
    const newStructure = this.isNewStructure(event);
    if (newStructure) this.structureCount++;
    this.entries.push({ event: { ...event }, dt, structure: this.structureCount });
    const keep = this.recentCount;
    if (this.entries.length > keep) this.entries.splice(0, this.entries.length - keep);
    this.lastPollState = "drawing";
    return { newStructure, structure: this.structureCount, dt };
  }

  /** Forget everything (new level loaded). */
  reset(): void {
    this.entries = [];
    this.lastT = undefined;
    this.structureCount = 0;
    this.lastPollState = "drawing";
  }

  // --- queries --------------------------------------------------------------

  /** Number of placements currently held. */
  get size(): number {
    return this.entries.length;
  }

  /** Placements held, oldest first (copies). */
  get events(): PlacementEvent[] {
    return this.entries.map((e) => ({ ...e.event }));
  }

  get last(): PlacementEvent | undefined {
    const e = this.entries[this.entries.length - 1];
    return e ? { ...e.event } : undefined;
  }

  /** Structure counter of the latest placement (0 before any). */
  get structure(): number {
    return this.structureCount;
  }

  /** Placements of the most recent stroke, oldest first. */
  lastStroke(): PlacementEvent[] {
    const last = this.entries[this.entries.length - 1];
    if (!last) return [];
    const out: PlacementEvent[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].event.stroke !== last.event.stroke) break;
      out.push({ ...this.entries[i].event });
    }
    return out.reverse();
  }

  /**
   * The last `n` placements (default recentCount) as the request's
   * RecentPlacement list, in LEVEL coordinates, oldest first. Pass an origin
   * to make them window-relative.
   */
  recent(n = this.recentCount, origin: Point = { x: 0, y: 0 }): RecentPlacement[] {
    const slice = n <= 0 ? [] : this.entries.slice(-n);
    return slice.map(({ event, dt }) => ({
      dt: Math.round(dt),
      x: event.x - origin.x,
      y: event.y - origin.y,
      tile: placementTileName(event),
      tool: event.tool,
    }));
  }

  /** ms since the last placement (0 if none yet). */
  idleMs(now = this.clock()): number {
    return this.lastT === undefined ? 0 : Math.max(0, now - this.lastT);
  }

  pauseState(now = this.clock()): PauseState {
    if (this.lastT === undefined) return "drawing";
    const idle = this.idleMs(now);
    if (idle >= this.longPauseMs) return "longPause";
    if (idle >= this.pauseMs) return "pause";
    return "drawing";
  }

  isPaused(now = this.clock()): boolean {
    return this.pauseState(now) !== "drawing";
  }

  isLongPaused(now = this.clock()): boolean {
    return this.pauseState(now) === "longPause";
  }

  /** Called on every pause-state transition seen by poll(). Returns unsubscribe. */
  onPause(fn: PauseListener): () => void {
    this.pauseListeners.add(fn);
    return () => this.pauseListeners.delete(fn);
  }

  /**
   * Check the clock and report a transition to "pause" or "longPause" (each
   * once per idle spell; a jump straight to longPause reports only that).
   * Returns the current state.
   */
  poll(now = this.clock()): PauseState {
    const state = this.pauseState(now);
    if (state !== this.lastPollState) {
      const rank = (s: PauseState) => (s === "drawing" ? 0 : s === "pause" ? 1 : 2);
      const prev = this.lastPollState;
      this.lastPollState = state;
      if (rank(state) > rank(prev)) {
        const idle = this.idleMs(now);
        for (const fn of [...this.pauseListeners]) fn(state, idle);
      }
    }
    return state;
  }

  /**
   * Would a placement at (x, y) start a new structure? True when nothing is
   * held, or when it is farther than newStructureTiles (Chebyshev) from every
   * held placement.
   */
  isNewStructure(p: Point): boolean {
    if (this.entries.length === 0) return true;
    const lim = this.newStructureTiles;
    for (const { event } of this.entries) {
      if (Math.max(Math.abs(event.x - p.x), Math.abs(event.y - p.y)) <= lim) return false;
    }
    return true;
  }

  /**
   * Is the drawing going up rather than along? Looks at the placements of the
   * current structure: vertical when their row span is at least 3 and larger
   * than their column span.
   */
  direction(): DrawDirection {
    const cur = this.currentStructure();
    if (cur.length < 2) return "horizontal";
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const e of cur) {
      x0 = Math.min(x0, e.x);
      x1 = Math.max(x1, e.x);
      y0 = Math.min(y0, e.y);
      y1 = Math.max(y1, e.y);
    }
    const spanX = x1 - x0;
    const spanY = y1 - y0;
    return spanY >= 3 && spanY > spanX ? "vertical" : "horizontal";
  }

  /** Paint/erase placements belonging to the latest structure, oldest first. */
  currentStructure(): PlacementEvent[] {
    const last = this.entries[this.entries.length - 1];
    if (!last) return [];
    return this.entries.filter((e) => e.structure === last.structure).map((e) => ({ ...e.event }));
  }

  /**
   * The frontier near the last stroke. Horizontal: walk right from the last
   * stroke through authored columns (gaps up to frontierGap empty columns)
   * within frontierBand rows of the stroke; the frontier is the rightmost such
   * column, at its topmost authored cell. Vertical: the same walk upward over
   * rows near the stroke's columns; the frontier is the topmost authored row.
   * Without a grid (or with nothing authored nearby) the stroke's own extreme
   * placement is used. Undefined before any placement.
   */
  frontier(grid: FrontierGrid | undefined = this.grid, now = this.clock()): Frontier | undefined {
    const stroke = this.lastStroke().filter((e) => e.tool === "paint");
    const pts = stroke.length > 0 ? stroke : this.lastStroke();
    if (pts.length === 0) return undefined;
    const direction = this.direction();
    const idleMs = this.idleMs(now);
    const gapMax = this.opts.frontierGap ?? 4;
    const band = this.opts.frontierBand ?? 5;
    const reach = this.opts.frontierReach ?? 24;

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const e of pts) {
      x0 = Math.min(x0, e.x);
      x1 = Math.max(x1, e.x);
      y0 = Math.min(y0, e.y);
      y1 = Math.max(y1, e.y);
    }
    const authored = (x: number, y: number) =>
      !!grid && x >= 0 && y >= 0 && x < grid.w && y < grid.h && grid.tileAt(x, y) !== 0 && grid.authorAt(x, y) !== AUTHOR.NONE;

    if (direction === "horizontal") {
      // Fallback: the rightmost placement of the stroke, topmost on ties.
      const best = pts.reduce((a, b) => (b.x > a.x || (b.x === a.x && b.y < a.y) ? b : a));
      let fx = best.x;
      let fy = best.y;
      if (grid) {
        const ya = Math.max(0, y0 - band);
        const yb = Math.min(grid.h - 1, y1 + band);
        const colTop = (x: number) => {
          for (let y = ya; y <= yb; y++) if (authored(x, y)) return y;
          return -1;
        };
        let empty = 0;
        let lastX = -1;
        let lastY = -1;
        for (let x = Math.max(0, x0); x < grid.w && x <= x1 + reach; x++) {
          const top = colTop(x);
          if (top >= 0) {
            lastX = x;
            lastY = top;
            empty = 0;
          } else if (x > x1 && ++empty > gapMax) break;
        }
        if (lastX >= fx) {
          fx = lastX;
          fy = lastY;
        }
      }
      return { x: fx, y: fy, idleMs, direction };
    }

    // Vertical: topmost placement, then walk up.
    const best = pts.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x > a.x) ? b : a));
    let fx = best.x;
    let fy = best.y;
    if (grid) {
      const xa = Math.max(0, x0 - band);
      const xb = Math.min(grid.w - 1, x1 + band);
      const rowCell = (y: number) => {
        // Prefer the authored cell nearest the stroke's last placement column.
        const cx = pts[pts.length - 1].x;
        let bestX = -1;
        for (let x = xa; x <= xb; x++) {
          if (!authored(x, y)) continue;
          if (bestX < 0 || Math.abs(x - cx) < Math.abs(bestX - cx)) bestX = x;
        }
        return bestX;
      };
      let empty = 0;
      let topY = -1;
      let topX = -1;
      for (let y = Math.min(grid.h - 1, y1); y >= 0 && y >= y0 - reach; y--) {
        const x = rowCell(y);
        if (x >= 0) {
          topY = y;
          topX = x;
          empty = 0;
        } else if (y < y0 && ++empty > gapMax) break;
      }
      if (topY >= 0 && topY <= fy) {
        fx = topX;
        fy = topY;
      }
    }
    return { x: fx, y: fy, idleMs, direction };
  }
}
