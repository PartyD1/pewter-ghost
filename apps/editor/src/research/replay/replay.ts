/**
 * Session replay core (pure; no Phaser, no DOM).
 *
 *   const r = Replay.fromJsonl(text);          // or new Replay(events)
 *   const f = r.stateAt(12_340);               // everything on screen at 12.34 s
 *   r.tracks();                                // timeline segments + markers
 *
 * The model is never called: a replay is rebuilt from the log alone.
 *  - Level: nearest earlier `snapshot`, then every `delta` after it.
 *  - Ghost: the `ghost.show` .. `ghost.end` interval containing t.
 *  - Pointer: `pointer.path` samples (canvas pixels), `pointer.btn`, `pointer.edge`.
 *  - Camera / tool / focus / play: the last event before t.
 *
 * `stateAt` returns live arrays for the level (valid until the next call), so
 * playback at 60 fps does not copy a 4000-cell grid per frame.
 */
import { TILE_PX, type Entity, type EntityKind, type LogEvent, type Point } from "../../contracts";
import { unpackSnapshot } from "../rle";
import { validateEvent } from "../schema";
import { buildTracks, type Tracks } from "./tracks";

export interface ReplayLevel {
  w: number;
  h: number;
  cells: number[];
  authors: number[];
  entities: Entity[];
  start: Point;
  goal?: Point;
}

export interface ReplayGhost {
  id: string;
  kind: string;
  label: string;
  confidence: number;
  shownBecause: string;
  startT: number;
  /** End of the ghost (ghost.end, or the end of the session). */
  endT: number;
  outcome: string | null;
  adds: [number, number, number][];
  removes: [number, number][];
  entities: [EntityKind, number, number][];
}

export interface ReplayPointer {
  /** Canvas pixels. */
  x: number;
  y: number;
  /** Tile under the pointer (needs a camera event). */
  tile: Point | null;
  down: boolean;
  inside: boolean;
}

export interface ReplayCamera {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

export interface ReplayFrame {
  t: number;
  level: ReplayLevel | null;
  ghost: ReplayGhost | null;
  pointer: ReplayPointer | null;
  /** Recent pointer positions, oldest first (canvas pixels). */
  trail: { t: number; x: number; y: number }[];
  camera: ReplayCamera | null;
  tool: { mode: string; brush: string } | null;
  focused: boolean;
  playing: boolean;
  keys: string[];
}

export interface ReplayGhostSummary extends ReplayGhost {
  /** ms from the ghost appearing to the first pointer movement after it (null: never moved). */
  firstMoveMs: number | null;
  /** ms from appearing to the decision (accept, dismiss, replaced, ...). */
  decisionMs: number;
  /** Time spent unfocused during the ghost's life (excluded from "attended" time). */
  awayMs: number;
}

const TRAIL_MS = 1500;

export class Replay {
  readonly events: LogEvent[];
  readonly duration: number;
  readonly sessionId: string;
  /** The log's own clock value (ms) of replay time 0, for matching a replay moment to the raw log. */
  readonly originMs: number;
  /** Events that failed validation when loading (kept out of the replay). */
  readonly skipped: { line: number; error: string }[];

  private readonly times: number[];
  private readonly snapIdx: number[];
  private readonly ghosts: ReplayGhost[];
  private readonly ptT: number[] = [];
  private readonly ptX: number[] = [];
  private readonly ptY: number[] = [];
  private readonly btn: { t: number; down: boolean }[] = [];
  private readonly edge: { t: number; inside: boolean }[] = [];
  private readonly cams: { t: number; v: ReplayCamera }[] = [];
  private readonly tools: { t: number; v: { mode: string; brush: string } }[] = [];
  private readonly focus: { t: number; v: boolean }[] = [];
  private readonly play: { start: number; end: number }[] = [];
  private readonly keyEv: { t: number; code: string; down: boolean }[] = [];
  private readonly cursor: LevelCursor;
  private trackCache: Tracks | null = null;

  constructor(events: readonly LogEvent[], skipped: { line: number; error: string }[] = []) {
    // Replay time 0 is the first event (the editor's clock counts from page load).
    // Stable by time: equal times keep log order.
    this.originMs = events.reduce((m, e) => Math.min(m, e.t), Infinity);
    if (!Number.isFinite(this.originMs)) this.originMs = 0;
    const origin = this.originMs;
    this.events = events
      .map((e, i) => ({ e: origin === 0 ? e : ({ ...e, t: e.t - origin } as LogEvent), i }))
      .sort((a, b) => a.e.t - b.e.t || a.i - b.i)
      .map((x) => x.e);
    this.skipped = skipped;
    this.times = this.events.map((e) => e.t);
    this.duration = this.computeDuration();
    this.sessionId = (this.events.find((e) => e.type === "session") as Extract<LogEvent, { type: "session" }> | undefined)?.sessionId ?? "";
    this.snapIdx = [];
    const shows = new Map<string, ReplayGhost>();
    const ghosts: ReplayGhost[] = [];
    let playStart: number | null = null;
    this.events.forEach((e, i) => {
      switch (e.type) {
        case "snapshot":
          this.snapIdx.push(i);
          break;
        case "pointer.path":
          for (let k = 0; k < e.x.length; k++) {
            this.ptT.push(e.t + (e.dt[k] ?? 0));
            this.ptX.push(e.x[k]);
            this.ptY.push(e.y[k]);
          }
          break;
        case "pointer.btn":
          if (e.button === 0) this.btn.push({ t: e.t, down: e.down });
          break;
        case "pointer.edge":
          this.edge.push({ t: e.t, inside: e.inside });
          break;
        case "camera":
          this.cams.push({ t: e.t, v: { x: e.x, y: e.y, w: e.w, h: e.h, zoom: e.zoom } });
          break;
        case "tool":
          this.tools.push({ t: e.t, v: { mode: e.mode, brush: e.brush } });
          break;
        case "focus":
          this.focus.push({ t: e.t, v: e.focused });
          break;
        case "key":
          this.keyEv.push({ t: e.t, code: e.code, down: e.down });
          break;
        case "play.start":
          playStart = e.t;
          break;
        case "play.end":
          if (playStart !== null) this.play.push({ start: playStart, end: e.t });
          playStart = null;
          break;
        case "ghost.show": {
          const g: ReplayGhost = {
            id: e.suggestionId,
            kind: e.kind,
            label: e.label,
            confidence: e.confidence,
            shownBecause: e.shownBecause,
            startT: e.t,
            endT: this.duration,
            outcome: null,
            adds: e.adds ?? [],
            removes: e.removes ?? [],
            entities: e.entities ?? [],
          };
          shows.set(g.id, g);
          ghosts.push(g);
          break;
        }
        case "ghost.end": {
          const g = shows.get(e.suggestionId);
          if (g && g.outcome === null) {
            g.endT = e.t;
            g.outcome = e.outcome;
          }
          break;
        }
        default:
          break;
      }
    });
    if (playStart !== null) this.play.push({ start: playStart, end: this.duration });
    this.ghosts = ghosts;
    this.cursor = new LevelCursor(this.events, this.snapIdx);
  }

  // ------------------------------------------------------------------ loading

  /** Parse a JSONL log. Invalid lines are skipped and listed in `skipped`. */
  static fromJsonl(text: string): Replay {
    const events: LogEvent[] = [];
    const skipped: { line: number; error: string }[] = [];
    text.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        skipped.push({ line: i + 1, error: "not JSON" });
        return;
      }
      const v = validateEvent(obj);
      if (v.ok) events.push(v.event);
      else skipped.push({ line: i + 1, error: v.error });
    });
    return new Replay(events, skipped);
  }

  /** The level the session began with (first snapshot), or null for an old log. Cells only. */
  baseCells(): number[] | null {
    if (this.snapIdx.length === 0) return null;
    const ev = this.events[this.snapIdx[0]] as Extract<LogEvent, { type: "snapshot" }>;
    return unpackSnapshot(ev.level).cells;
  }

  /** True when the log has what a visual replay needs (a level snapshot). */
  get hasLevel(): boolean {
    return this.snapIdx.length > 0;
  }

  // -------------------------------------------------------------------- state

  stateAt(tIn: number): ReplayFrame {
    const t = Math.max(0, Math.min(this.duration, tIn));
    const idx = upperBound(this.times, t) - 1;
    const level = this.cursor.moveTo(idx);
    const ghost = this.ghostAt(t);
    return {
      t,
      level,
      ghost,
      ...this.pointerAt(t),
      camera: lastAt(this.cams, t)?.v ?? null,
      tool: lastAt(this.tools, t)?.v ?? null,
      focused: lastAt(this.focus, t)?.v ?? true,
      playing: this.play.some((p) => t >= p.start && t < p.end),
      keys: this.keysAt(t),
    };
  }

  /** Tile under canvas pixel (px, py) for a camera (the editor's view mapping). */
  static pixelToTile(cam: ReplayCamera, px: number, py: number): Point {
    const s = TILE_PX * cam.zoom;
    return { x: Math.floor(cam.x + px / s), y: Math.floor(cam.y + py / s) };
  }

  /** Canvas pixel of a tile's top-left corner for a camera. */
  static tileToPixel(cam: ReplayCamera, x: number, y: number): Point {
    const s = TILE_PX * cam.zoom;
    return { x: (x - cam.x) * s, y: (y - cam.y) * s };
  }

  /** Pointer samples with from <= t <= to, as {t, x, y}. */
  pointerPath(from: number, to: number): { t: number; x: number; y: number }[] {
    const out: { t: number; x: number; y: number }[] = [];
    for (let i = lowerBound(this.ptT, from); i < this.ptT.length && this.ptT[i] <= to; i++) {
      out.push({ t: this.ptT[i], x: this.ptX[i], y: this.ptY[i] });
    }
    return out;
  }

  // ------------------------------------------------------------ timeline data

  tracks(): Tracks {
    return (this.trackCache ??= buildTracks(this));
  }

  /** One summary per ghost: how fast the person reacted and what they decided. */
  ghostSummaries(): ReplayGhostSummary[] {
    return this.ghosts.map((g) => {
      const firstMove = this.firstMoveAfter(g.startT, g.endT);
      return {
        ...g,
        firstMoveMs: firstMove === null ? null : Math.round(firstMove - g.startT),
        decisionMs: Math.round(g.endT - g.startT),
        awayMs: Math.round(this.awayMs(g.startT, g.endT)),
      };
    });
  }

  /** Milliseconds with the window unfocused or the tab hidden inside [from, to]. */
  awayMs(from: number, to: number): number {
    let away = 0;
    let state = lastAt(this.focus, from)?.v ?? true;
    let since = from;
    for (const f of this.focus) {
      if (f.t <= from) continue;
      if (f.t >= to) break;
      if (!state) away += f.t - since;
      state = f.v;
      since = f.t;
    }
    if (!state) away += to - since;
    return away;
  }

  /** Raw access for the timeline builder. */
  get internals() {
    return { ghosts: this.ghosts, play: this.play, focus: this.focus, ptT: this.ptT };
  }

  // ---------------------------------------------------------------- internals

  private computeDuration(): number {
    let end = 0;
    for (const e of this.events) {
      let t = e.t;
      if (e.type === "pointer.path") t += e.dt[e.dt.length - 1] ?? 0;
      else if (e.type === "ghost.end") t = Math.max(t, e.t);
      end = Math.max(end, t);
    }
    return end;
  }

  private firstMoveAfter(from: number, to: number): number | null {
    // The pointer is always at some position; "moved" means a sample different from the one at `from`.
    const i0 = upperBound(this.ptT, from) - 1;
    const x0 = i0 >= 0 ? this.ptX[i0] : NaN;
    const y0 = i0 >= 0 ? this.ptY[i0] : NaN;
    for (let i = upperBound(this.ptT, from); i < this.ptT.length && this.ptT[i] <= to; i++) {
      if (this.ptX[i] !== x0 || this.ptY[i] !== y0) return this.ptT[i];
    }
    return null;
  }

  private ghostAt(t: number): ReplayGhost | null {
    let found: ReplayGhost | null = null;
    for (const g of this.ghosts) {
      if (g.startT > t) break;
      if (t < g.endT || (g.endT === g.startT && t === g.startT)) found = g;
    }
    return found;
  }

  private pointerAt(t: number): { pointer: ReplayPointer | null; trail: ReplayFrame["trail"] } {
    const i = upperBound(this.ptT, t) - 1;
    if (i < 0) return { pointer: null, trail: [] };
    const x = this.ptX[i];
    const y = this.ptY[i];
    const cam = lastAt(this.cams, t)?.v ?? null;
    const edge = lastAt(this.edge, t);
    const trail: ReplayFrame["trail"] = [];
    for (let k = lowerBound(this.ptT, t - TRAIL_MS); k <= i; k++) trail.push({ t: this.ptT[k], x: this.ptX[k], y: this.ptY[k] });
    return {
      pointer: {
        x,
        y,
        tile: cam ? Replay.pixelToTile(cam, x, y) : null,
        down: lastAt(this.btn, t)?.down ?? false,
        inside: edge ? edge.inside : true,
      },
      trail,
    };
  }

  private keysAt(t: number): string[] {
    const down = new Set<string>();
    for (const k of this.keyEv) {
      if (k.t > t) break;
      if (k.down) down.add(k.code);
      else down.delete(k.code);
    }
    return [...down];
  }
}

// ---------------------------------------------------------------------------
// Level reconstruction
// ---------------------------------------------------------------------------

class LevelCursor {
  private base = -1;
  private idx = -1;
  private level: ReplayLevel | null = null;
  private ents = new Map<string, Entity>();
  private entsDirty = false;

  constructor(
    private readonly events: LogEvent[],
    private readonly snapIdx: number[],
  ) {}

  /** The level after events[0..target] (target = index of the last applied event). */
  moveTo(target: number): ReplayLevel | null {
    if (this.snapIdx.length === 0) {
      this.base = -1;
      this.idx = -1;
      this.level = null;
      return null;
    }
    // Before the first snapshot, the level is the first snapshot (the state the session began with).
    const bi = Math.max(0, upperBound(this.snapIdx, target) - 1);
    target = Math.max(target, this.snapIdx[bi]);
    if (bi !== this.base || target < this.idx || !this.level) {
      const ev = this.events[this.snapIdx[bi]] as Extract<LogEvent, { type: "snapshot" }>;
      const snap = unpackSnapshot(ev.level);
      this.level = { w: snap.w, h: snap.h, cells: snap.cells, authors: snap.authors, entities: [], start: { ...snap.start }, goal: snap.goal ? { ...snap.goal } : undefined };
      this.ents = new Map(snap.entities.map((e) => [e.id, e]));
      this.entsDirty = true;
      this.base = bi;
      this.idx = this.snapIdx[bi];
    }
    let changedEntities = this.entsDirty;
    this.entsDirty = false;
    for (let i = this.idx + 1; i <= target; i++) {
      const e = this.events[i];
      if (e.type !== "delta") continue;
      const L = this.level;
      for (const [x, y, tile, author] of e.cells) {
        if (x < 0 || y < 0 || x >= L.w || y >= L.h) continue;
        L.cells[y * L.w + x] = tile;
        L.authors[y * L.w + x] = author;
      }
      for (const id of e.entitiesRemoved ?? []) changedEntities = this.ents.delete(id) || changedEntities;
      for (const en of e.entitiesAdded ?? []) {
        this.ents.set(en.id, en);
        changedEntities = true;
      }
      if (e.start) L.start = { ...e.start };
      if (e.goal !== undefined) L.goal = e.goal ? { ...e.goal } : undefined;
    }
    this.idx = Math.max(this.idx, target);
    if (changedEntities) this.level.entities = [...this.ents.values()];
    return this.level;
  }
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

/** First index whose value is > x (values sorted ascending). */
export function upperBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** First index whose value is >= x. */
export function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function lastAt<T extends { t: number }>(a: readonly T[], t: number): T | undefined {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m].t <= t) lo = m + 1;
    else hi = m;
  }
  return lo > 0 ? a[lo - 1] : undefined;
}
