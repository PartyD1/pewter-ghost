/**
 * LevelModel (G-02): the one truth for a level.
 *
 * - One grid: `Uint8Array` tile ids, `Uint8Array` authors (0 none, 1 person,
 *   2 accepted ghost) and a provenance map (cell index -> suggestion id).
 * - One ordered entity list with a per-entity author. Invariants kept by every
 *   command: at most one entity per cell, and entities never sit inside a
 *   solid tile (painting a tile removes the entity there; placing an entity
 *   clears the tile). Enemy patrol spans are derived from the floor and kept
 *   up to date after every change.
 * - Start and optional goal.
 * - A command log with do / undo / redo. Paint and erase calls made between
 *   beginStroke() and endStroke() merge into one undo step; applySuggestion is
 *   always exactly one undo step (so Tab is one Ctrl+Z).
 *
 * The model emits a LevelChange after every command, undo, redo and load, and
 * a PlacementEvent per changed cell for person paint / erase / entity edits.
 * No Phaser imports: it runs in Node tests and in Web Workers.
 */
import {
  AUTHOR,
  LEVEL_H,
  LEVEL_W,
  SOLID_TILES,
  type Author,
  type Entity,
  type EntityKind,
  type LevelChange,
  type LevelSnapshot,
  type PlacementEvent,
  type Point,
  type Suggestion,
  type TileId,
} from "../contracts";
import {
  commandWhat,
  deltaIsEmpty,
  emptyDelta,
  mergeDelta,
  sameCellState,
  type CellState,
  type Command,
  type CommandKind,
  type Delta,
  type EntityOp,
} from "./commands";
import { cloneEntity, computePatrol, idCounterOf, isEnemyKind, isEntityKind, samePatrol } from "./entities";
import { defaultClock, Emitter } from "./events";
import { checkSnapshot, emptySnapshot } from "./snapshot";

/** Start used for a fresh level: standing on the default map's ground (row 15). */
export const DEFAULT_START: Point = { x: 2, y: 14 };

/** Value returned by window accessors for cells outside the level. */
export const OUT_OF_BOUNDS = 255;

export const DEFAULT_MAX_HISTORY = 500;

export interface LevelModelOptions {
  w?: number;
  h?: number;
  start?: Point;
  /** Session clock in ms (default performance.now). Used for event times. */
  clock?: () => number;
  /** Maximum number of undo steps kept (default 500). */
  maxHistory?: number;
  /** Prefix for generated entity ids (default "e"). */
  idPrefix?: string;
  /** Receives exceptions thrown by subscribers (default console.error). */
  onListenerError?: (err: unknown) => void;
}

export interface CellInput {
  x: number;
  y: number;
  tile: TileId;
}

/**
 * What subscribers receive: the contract's LevelChange plus fields the
 * renderer needs that the v1 contract has no room for (all optional except
 * revision, so it is assignable to LevelChange).
 */
export interface LevelChangeEx extends LevelChange {
  /** Existing enemies whose derived patrol span changed. */
  entitiesUpdated?: Entity[];
  /** New start, when this change moved it. */
  start?: Point;
  /** New goal when this change touched it; null = goal cleared. */
  goal?: Point | null;
  /** Monotonic model revision after this change. */
  revision: number;
}

export type LevelChangeInfo = Omit<LevelChangeEx, "revision">;

export interface UndoResult {
  kind: CommandKind;
  what: "own" | "ghost" | "mixed";
  suggestionId?: string;
  change: LevelChangeInfo;
}

export interface AuthorCounts {
  /** Non-empty cells by author. */
  cells: { none: number; person: number; ghost: number };
  entities: { none: number; person: number; ghost: number };
}

/** Rectangular read-only view of the level; coordinates are window-relative. */
export interface LevelWindow {
  origin: Point;
  w: number;
  h: number;
  /** Row-major tile ids; OUT_OF_BOUNDS for cells outside the level. */
  cells: Uint8Array;
  /** Row-major authors; OUT_OF_BOUNDS outside the level. */
  authors: Uint8Array;
  /** Entities inside the window, LEVEL coordinates (copies). */
  entities: Entity[];
  tileAt(wx: number, wy: number): number;
  authorAt(wx: number, wy: number): number;
  inLevel(wx: number, wy: number): boolean;
}

export interface PlaceEntityOptions {
  author?: Author;
  id?: string;
  text?: string;
}

export interface ApplySuggestionResult {
  cellsChanged: number;
  entityIds: string[];
}

/** One open transaction: applies changes immediately and records the delta. */
interface Tx {
  delta: Delta;
  /** Placement events to emit (person edits only). */
  placements: PlacementEvent[];
}

export class LevelModel {
  readonly w: number;
  readonly h: number;

  private readonly cells: Uint8Array;
  private readonly authors: Uint8Array;
  private readonly provenance = new Map<number, string>();
  private entityList: Entity[] = [];
  private readonly entityAuthorMap = new Map<string, Author>();
  /** cell index -> entity id (one entity per cell). */
  private readonly entityAtCell = new Map<number, string>();
  private startPoint: Point;
  private goalPoint: Point | undefined;

  /** Session time of the last do-placement per cell (NaN = never). */
  private readonly lastPlacedAt: Float64Array;
  private readonly lastPlacedBy: Uint8Array;

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private seq = 0;
  private rev = 0;
  private idCounter = 0;
  private strokeCounter = 0;
  private openStroke: { id: string; command: Command | undefined } | undefined;

  private readonly clock: () => number;
  private readonly maxHistory: number;
  private readonly idPrefix: string;
  private readonly changes: Emitter<LevelChangeEx>;
  private readonly placements: Emitter<PlacementEvent>;

  constructor(opts: LevelModelOptions = {}) {
    this.w = opts.w ?? LEVEL_W;
    this.h = opts.h ?? LEVEL_H;
    if (!Number.isInteger(this.w) || !Number.isInteger(this.h) || this.w < 1 || this.h < 1)
      throw new RangeError(`bad level size ${this.w}x${this.h}`);
    const n = this.w * this.h;
    this.cells = new Uint8Array(n);
    this.authors = new Uint8Array(n);
    this.lastPlacedAt = new Float64Array(n).fill(Number.NaN);
    this.lastPlacedBy = new Uint8Array(n);
    this.startPoint = { ...(opts.start ?? clampPoint(DEFAULT_START, this.w, this.h)) };
    this.clock = opts.clock ?? defaultClock;
    this.maxHistory = Math.max(1, opts.maxHistory ?? DEFAULT_MAX_HISTORY);
    this.idPrefix = opts.idPrefix ?? "e";
    this.changes = new Emitter(opts.onListenerError);
    this.placements = new Emitter(opts.onListenerError);
  }

  /** Build a model from a snapshot. Throws on an invalid snapshot. */
  static fromSnapshot(snapshot: LevelSnapshot, opts: Omit<LevelModelOptions, "w" | "h"> = {}): LevelModel {
    const checked = checkSnapshot(snapshot);
    if (!checked.ok) throw new Error(`invalid level snapshot: ${checked.error}`);
    const m = new LevelModel({ ...opts, w: checked.snapshot.w, h: checked.snapshot.h });
    m.replaceState(checked.snapshot);
    return m;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /** Subscribe to LevelChange (every do, undo, redo and load). Returns unsubscribe. */
  subscribe(listener: (change: LevelChangeEx) => void): () => void {
    return this.changes.on(listener);
  }

  /** Subscribe to PlacementEvents (person paint / erase / entity edits). */
  onPlacement(listener: (event: PlacementEvent) => void): () => void {
    return this.placements.on(listener);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  get revision(): number {
    return this.rev;
  }

  inBounds(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  index(x: number, y: number): number {
    return y * this.w + x;
  }

  /** Tile id at (x, y); 0 outside the level. */
  tileAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.cells[y * this.w + x] : 0;
  }

  /** Author of the tile at (x, y); 0 outside the level or on empty cells. */
  authorAt(x: number, y: number): Author {
    return (this.inBounds(x, y) ? this.authors[y * this.w + x] : 0) as Author;
  }

  /** Suggestion id that placed the (accepted ghost) tile at (x, y). */
  provenanceAt(x: number, y: number): string | undefined {
    return this.inBounds(x, y) ? this.provenance.get(y * this.w + x) : undefined;
  }

  /** Solid terrain at (x, y). Outside the level is never solid. */
  isSolid(x: number, y: number): boolean {
    return this.inBounds(x, y) && SOLID_TILES.has(this.cells[y * this.w + x]);
  }

  get start(): Point {
    return { ...this.startPoint };
  }

  get goal(): Point | undefined {
    return this.goalPoint ? { ...this.goalPoint } : undefined;
  }

  /** All entities in list order (copies). */
  get entities(): Entity[] {
    return this.entityList.map(cloneEntity);
  }

  get entityCount(): number {
    return this.entityList.length;
  }

  getEntity(id: string): Entity | undefined {
    const e = this.entityList.find((x) => x.id === id);
    return e ? cloneEntity(e) : undefined;
  }

  entityAuthor(id: string): Author | undefined {
    return this.entityAuthorMap.get(id);
  }

  /** Entities on cell (x, y) (zero or one, as a list for convenience). */
  entitiesAt(x: number, y: number): Entity[] {
    if (!this.inBounds(x, y)) return [];
    const id = this.entityAtCell.get(this.index(x, y));
    const e = id ? this.entityList.find((x2) => x2.id === id) : undefined;
    return e ? [cloneEntity(e)] : [];
  }

  /** Entities with x0 <= x < x0+w and y0 <= y < y0+h (copies, list order). */
  entitiesInRect(x0: number, y0: number, w: number, h: number): Entity[] {
    return this.entityList
      .filter((e) => e.x >= x0 && e.x < x0 + w && e.y >= y0 && e.y < y0 + h)
      .map(cloneEntity);
  }

  /** Read-only rectangular view; parts outside the level read OUT_OF_BOUNDS. */
  window(x0: number, y0: number, w: number, h: number): LevelWindow {
    if (!Number.isInteger(x0) || !Number.isInteger(y0) || !Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0)
      throw new RangeError("window needs integer origin and non-negative size");
    const cells = new Uint8Array(w * h).fill(OUT_OF_BOUNDS);
    const authors = new Uint8Array(w * h).fill(OUT_OF_BOUNDS);
    for (let wy = 0; wy < h; wy++) {
      const y = y0 + wy;
      if (y < 0 || y >= this.h) continue;
      for (let wx = 0; wx < w; wx++) {
        const x = x0 + wx;
        if (x < 0 || x >= this.w) continue;
        cells[wy * w + wx] = this.cells[y * this.w + x];
        authors[wy * w + wx] = this.authors[y * this.w + x];
      }
    }
    const inWin = (wx: number, wy: number) => wx >= 0 && wy >= 0 && wx < w && wy < h;
    return {
      origin: { x: x0, y: y0 },
      w,
      h,
      cells,
      authors,
      entities: this.entitiesInRect(x0, y0, w, h),
      tileAt: (wx, wy) => (inWin(wx, wy) ? cells[wy * w + wx] : OUT_OF_BOUNDS),
      authorAt: (wx, wy) => (inWin(wx, wy) ? authors[wy * w + wx] : OUT_OF_BOUNDS),
      inLevel: (wx, wy) => this.inBounds(x0 + wx, y0 + wy),
    };
  }

  /** Counts of non-empty cells and entities by author. */
  authoredBy(): AuthorCounts {
    const out: AuthorCounts = {
      cells: { none: 0, person: 0, ghost: 0 },
      entities: { none: 0, person: 0, ghost: 0 },
    };
    const key = (a: number) => (a === AUTHOR.PERSON ? "person" : a === AUTHOR.GHOST ? "ghost" : "none");
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] !== 0) out.cells[key(this.authors[i])]++;
    for (const e of this.entityList) out.entities[key(this.entityAuthorMap.get(e.id) ?? 0)]++;
    return out;
  }

  /** Cell indices of all accepted-ghost cells carrying `suggestionId`. */
  cellsFromSuggestion(suggestionId: string): Point[] {
    const out: Point[] = [];
    for (const [i, id] of this.provenance) if (id === suggestionId) out.push({ x: i % this.w, y: Math.floor(i / this.w) });
    return out;
  }

  /**
   * Session time of the last placement (paint, erase or entity edit done by a
   * command, not by undo/redo) on (x, y), or undefined if never.
   */
  lastPlacementAt(x: number, y: number): { t: number; author: Author } | undefined {
    if (!this.inBounds(x, y)) return undefined;
    const i = this.index(x, y);
    const t = this.lastPlacedAt[i];
    return Number.isNaN(t) ? undefined : { t, author: this.lastPlacedBy[i] as Author };
  }

  /**
   * Cells placed at or after session time `t` (fix grace: never fix what the
   * person placed in the last few seconds). Filters by author (default
   * person); pass `null` for any author.
   */
  cellsPlacedSince(t: number, author: Author | null = AUTHOR.PERSON): Point[] {
    const out: Point[] = [];
    for (let i = 0; i < this.lastPlacedAt.length; i++) {
      const pt = this.lastPlacedAt[i];
      if (!(pt >= t)) continue;
      if (author !== null && this.lastPlacedBy[i] !== author) continue;
      out.push({ x: i % this.w, y: Math.floor(i / this.w) });
    }
    return out;
  }

  /** Serialisable deep copy of the current state. */
  snapshot(): LevelSnapshot {
    const provenance: Record<number, string> = {};
    for (const [i, id] of [...this.provenance].sort((a, b) => a[0] - b[0])) provenance[i] = id;
    const entityAuthors: Record<string, Author> = {};
    for (const e of this.entityList) entityAuthors[e.id] = this.entityAuthorMap.get(e.id) ?? AUTHOR.PERSON;
    const snap: LevelSnapshot = {
      w: this.w,
      h: this.h,
      cells: Array.from(this.cells),
      authors: Array.from(this.authors),
      provenance,
      entities: this.entityList.map(cloneEntity),
      entityAuthors,
      start: { ...this.startPoint },
    };
    if (this.goalPoint) snap.goal = { ...this.goalPoint };
    return snap;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** The command an undo() would revert, without reverting it. */
  peekUndo(): { kind: CommandKind; what: "own" | "ghost" | "mixed"; suggestionId?: string } | undefined {
    const c = this.undoStack[this.undoStack.length - 1];
    return c ? { kind: c.kind, what: commandWhat(c), suggestionId: c.suggestionId } : undefined;
  }

  undo(): UndoResult | undefined {
    this.closeStroke();
    const cmd = this.undoStack.pop();
    if (!cmd) return undefined;
    // Move the command first: applyDelta notifies subscribers, and they must
    // see the new canUndo / canRedo (the toolbar's Redo button read it stale).
    this.redoStack.push(cmd);
    const change = this.applyDelta(cmd.delta, "undo");
    return { kind: cmd.kind, what: commandWhat(cmd), suggestionId: cmd.suggestionId, change };
  }

  redo(): UndoResult | undefined {
    this.closeStroke();
    const cmd = this.redoStack.pop();
    if (!cmd) return undefined;
    this.undoStack.push(cmd); // before applyDelta, see undo()
    const change = this.applyDelta(cmd.delta, "redo");
    return { kind: cmd.kind, what: commandWhat(cmd), suggestionId: cmd.suggestionId, change };
  }

  clearHistory(): void {
    this.closeStroke();
    this.undoStack = [];
    this.redoStack = [];
  }

  // -------------------------------------------------------------------------
  // Strokes
  // -------------------------------------------------------------------------

  /**
   * Open a stroke: until endStroke(), paint / erase / entity edits by the
   * person merge into one undo step and carry this stroke id in their
   * PlacementEvents. Opening a stroke closes any open one.
   */
  beginStroke(): string {
    this.closeStroke();
    const id = `s${++this.strokeCounter}`;
    this.openStroke = { id, command: undefined };
    return id;
  }

  endStroke(): void {
    this.closeStroke();
  }

  get currentStroke(): string | undefined {
    return this.openStroke?.id;
  }

  private closeStroke(): void {
    this.openStroke = undefined;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Paint tiles. Out-of-bounds cells are ignored. Removes entities on painted cells. */
  paint(cells: readonly CellInput[], author: Author = AUTHOR.PERSON): number {
    for (const c of cells)
      if (!SOLID_TILES.has(c.tile)) throw new RangeError(`paint: ${String(c.tile)} is not a terrain tile`);
    return this.run("paint", author, (tx, stroke) => {
      let changed = 0;
      for (const c of cells) {
        if (!this.inBounds(c.x, c.y)) continue;
        const i = this.index(c.x, c.y);
        const removed = this.txRemoveEntityAtCell(tx, i);
        const did = this.txSetCell(tx, i, { tile: c.tile, author, prov: undefined });
        if (did || removed) {
          changed++;
          this.notePlacement(tx, i, author, c.tile, "paint", stroke);
        }
      }
      return changed;
    });
  }

  /** Convenience: paint one tile. */
  paintTile(x: number, y: number, tile: TileId, author: Author = AUTHOR.PERSON): number {
    return this.paint([{ x, y, tile }], author);
  }

  /**
   * Erase cells: tiles, and (unless `entities: false`) entities on them.
   * Returns the number of cells that changed.
   */
  erase(cells: readonly Point[], opts: { author?: Author; entities?: boolean } = {}): number {
    const author = opts.author ?? AUTHOR.PERSON;
    const withEntities = opts.entities ?? true;
    return this.run("erase", author, (tx, stroke) => {
      let changed = 0;
      for (const c of cells) {
        if (!this.inBounds(c.x, c.y)) continue;
        const i = this.index(c.x, c.y);
        const did = this.txSetCell(tx, i, { tile: 0, author: AUTHOR.NONE, prov: undefined });
        const removed = withEntities ? this.txRemoveEntityAtCell(tx, i) : false;
        if (did || removed) {
          changed++;
          this.notePlacement(tx, i, author, 0, "erase", stroke);
        }
      }
      return changed;
    });
  }

  /**
   * Place an entity. Replaces any entity on that cell and clears a solid tile
   * there. Returns the new entity (with patrol for enemies) or undefined when
   * the cell is outside the level.
   */
  placeEntity(kind: EntityKind, x: number, y: number, opts: PlaceEntityOptions = {}): Entity | undefined {
    if (!isEntityKind(kind)) throw new RangeError(`placeEntity: unknown kind ${String(kind)}`);
    if (!this.inBounds(x, y)) return undefined;
    if (opts.id !== undefined && this.entityAuthorMap.has(opts.id))
      throw new Error(`placeEntity: id ${opts.id} already exists`);
    const author = opts.author ?? AUTHOR.PERSON;
    let placedId = "";
    this.run("placeEntity", author, (tx, stroke) => {
      const i = this.index(x, y);
      this.txRemoveEntityAtCell(tx, i);
      if (SOLID_TILES.has(this.cells[i])) this.txSetCell(tx, i, { tile: 0, author: AUTHOR.NONE, prov: undefined });
      const e: Entity = { id: opts.id ?? this.nextEntityId(), kind, x, y };
      if (opts.text !== undefined) e.text = opts.text;
      this.txAddEntity(tx, e, author);
      placedId = e.id;
      this.notePlacement(tx, i, author, `entity:${kind}`, "paint", stroke);
      return 1;
    });
    return this.getEntity(placedId);
  }

  /** Remove an entity by id. Returns true when it existed. */
  removeEntity(id: string, author: Author = AUTHOR.PERSON): boolean {
    const e = this.entityList.find((x) => x.id === id);
    if (!e) return false;
    this.run("removeEntity", author, (tx, stroke) => {
      this.txRemoveEntity(tx, id);
      this.notePlacement(tx, this.index(e.x, e.y), author, 0, "erase", stroke);
      return 1;
    });
    return true;
  }

  /**
   * Apply a suggestion as ONE undoable command: removes first, then adds
   * (author GHOST, provenance = suggestion.id), then entities (author GHOST).
   * Cells outside the level are ignored.
   */
  applySuggestion(s: Pick<Suggestion, "id" | "adds" | "removes" | "entities">): ApplySuggestionResult {
    for (const a of s.adds)
      if (!SOLID_TILES.has(a.tile)) throw new RangeError(`applySuggestion: ${String(a.tile)} is not a terrain tile`);
    for (const e of s.entities)
      if (!isEntityKind(e.kind)) throw new RangeError(`applySuggestion: unknown entity kind ${String(e.kind)}`);
    this.closeStroke();
    const entityIds: string[] = [];
    let cellsChanged = 0;
    const cmd = this.runRaw("applySuggestion", AUTHOR.GHOST, (tx) => {
      const touched = new Set<number>();
      for (const r of s.removes) {
        if (!this.inBounds(r.x, r.y)) continue;
        const i = this.index(r.x, r.y);
        const a = this.txSetCell(tx, i, { tile: 0, author: AUTHOR.NONE, prov: undefined });
        const b = this.txRemoveEntityAtCell(tx, i);
        if (a || b) touched.add(i);
      }
      for (const a of s.adds) {
        if (!this.inBounds(a.x, a.y)) continue;
        const i = this.index(a.x, a.y);
        const r = this.txRemoveEntityAtCell(tx, i);
        const d = this.txSetCell(tx, i, { tile: a.tile, author: AUTHOR.GHOST, prov: s.id });
        if (r || d) touched.add(i);
      }
      for (const en of s.entities) {
        if (!this.inBounds(en.x, en.y)) continue;
        const i = this.index(en.x, en.y);
        this.txRemoveEntityAtCell(tx, i);
        if (SOLID_TILES.has(this.cells[i])) this.txSetCell(tx, i, { tile: 0, author: AUTHOR.NONE, prov: undefined });
        const e: Entity = { id: this.nextEntityId(), kind: en.kind, x: en.x, y: en.y };
        this.txAddEntity(tx, e, AUTHOR.GHOST);
        entityIds.push(e.id);
        touched.add(i);
      }
      const t = this.clock();
      for (const i of touched) {
        this.lastPlacedAt[i] = t;
        this.lastPlacedBy[i] = AUTHOR.GHOST;
      }
      cellsChanged = touched.size;
    });
    if (cmd) cmd.suggestionId = s.id;
    return { cellsChanged, entityIds };
  }

  setStart(p: Point): boolean {
    if (!this.inBounds(p.x, p.y)) throw new RangeError("setStart: point is outside the level");
    if (p.x === this.startPoint.x && p.y === this.startPoint.y) return false;
    this.runRaw("setStart", AUTHOR.PERSON, (tx) => {
      tx.delta.start = { before: { ...this.startPoint }, after: { x: p.x, y: p.y } };
      this.startPoint = { x: p.x, y: p.y };
    });
    return true;
  }

  /** Set or clear (undefined) the goal. */
  setGoal(p: Point | undefined): boolean {
    if (p && !this.inBounds(p.x, p.y)) throw new RangeError("setGoal: point is outside the level");
    const cur = this.goalPoint;
    if (!p && !cur) return false;
    if (p && cur && p.x === cur.x && p.y === cur.y) return false;
    this.runRaw("setGoal", AUTHOR.PERSON, (tx) => {
      tx.delta.goal = { before: cur ? { ...cur } : undefined, after: p ? { x: p.x, y: p.y } : undefined };
      this.goalPoint = p ? { x: p.x, y: p.y } : undefined;
    });
    return true;
  }

  /**
   * Replace the whole level (file load, share code). Validates first and
   * throws without touching the model on a bad snapshot. Clears history.
   * Returns warnings from normalisation.
   */
  load(snapshot: LevelSnapshot): string[] {
    const checked = checkSnapshot(snapshot);
    if (!checked.ok) throw new Error(`invalid level snapshot: ${checked.error}`);
    if (checked.snapshot.w !== this.w || checked.snapshot.h !== this.h)
      throw new Error(`level is ${checked.snapshot.w}x${checked.snapshot.h}; this model is ${this.w}x${this.h}`);
    const removed = this.entityList.map((e) => e.id);
    this.closeStroke();
    this.replaceState(checked.snapshot);
    this.undoStack = [];
    this.redoStack = [];
    this.lastPlacedAt.fill(Number.NaN);
    this.lastPlacedBy.fill(0);
    const cells: LevelChange["cells"] = [];
    for (let i = 0; i < this.cells.length; i++)
      cells.push({ x: i % this.w, y: Math.floor(i / this.w), tile: this.cells[i], author: this.authors[i] as Author });
    this.rev++;
    this.changes.emit({
      cells,
      entitiesAdded: this.entityList.map(cloneEntity),
      entitiesRemoved: removed,
      source: "load",
      start: { ...this.startPoint },
      goal: this.goalPoint ? { ...this.goalPoint } : null,
      revision: this.rev,
    });
    return checked.warnings;
  }

  /** Reset to an empty level (keeps size), clearing history. */
  clear(): void {
    this.load(emptySnapshot(this.w, this.h, clampPoint(DEFAULT_START, this.w, this.h)));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private replaceState(s: LevelSnapshot): void {
    this.cells.set(s.cells);
    this.authors.set(s.authors);
    this.provenance.clear();
    for (const [k, v] of Object.entries(s.provenance)) this.provenance.set(Number(k), v);
    this.entityList = [];
    this.entityAuthorMap.clear();
    this.entityAtCell.clear();
    let maxId = this.idCounter;
    for (const e of s.entities) {
      const c = cloneEntity(e);
      this.entityList.push(c);
      this.entityAuthorMap.set(c.id, s.entityAuthors[c.id] ?? AUTHOR.PERSON);
      this.entityAtCell.set(this.index(c.x, c.y), c.id);
      maxId = Math.max(maxId, idCounterOf(c.id, this.idPrefix));
    }
    this.idCounter = maxId;
    this.startPoint = { ...s.start };
    this.goalPoint = s.goal ? { ...s.goal } : undefined;
    this.refreshPatrols();
  }

  private nextEntityId(): string {
    let id: string;
    do id = `${this.idPrefix}${++this.idCounter}`;
    while (this.entityAuthorMap.has(id));
    return id;
  }

  private cellState(i: number): CellState {
    return { tile: this.cells[i], author: this.authors[i], prov: this.provenance.get(i) };
  }

  private writeCell(i: number, s: CellState): void {
    this.cells[i] = s.tile;
    this.authors[i] = s.author;
    if (s.prov === undefined) this.provenance.delete(i);
    else this.provenance.set(i, s.prov);
  }

  /** Set a cell inside a transaction. Returns true if it changed. */
  private txSetCell(tx: Tx, i: number, after: CellState): boolean {
    const before = this.cellState(i);
    if (sameCellState(before, after)) return false;
    const prev = tx.delta.cells.get(i);
    if (prev) prev.after = after;
    else tx.delta.cells.set(i, { i, before, after });
    this.writeCell(i, after);
    return true;
  }

  private txAddEntity(tx: Tx, e: Entity, author: Author): void {
    const index = this.entityList.length;
    this.entityList.push(cloneEntity(e));
    this.entityAuthorMap.set(e.id, author);
    this.entityAtCell.set(this.index(e.x, e.y), e.id);
    tx.delta.entityOps.push({ op: "add", entity: cloneEntity(e), author, index });
  }

  private txRemoveEntity(tx: Tx, id: string): boolean {
    const index = this.entityList.findIndex((x) => x.id === id);
    if (index < 0) return false;
    const [e] = this.entityList.splice(index, 1);
    const author = this.entityAuthorMap.get(id) ?? AUTHOR.PERSON;
    this.entityAuthorMap.delete(id);
    const ci = this.index(e.x, e.y);
    if (this.entityAtCell.get(ci) === id) this.entityAtCell.delete(ci);
    const stored = cloneEntity(e);
    delete stored.patrol;
    tx.delta.entityOps.push({ op: "remove", entity: stored, author, index });
    return true;
  }

  private txRemoveEntityAtCell(tx: Tx, i: number): boolean {
    const id = this.entityAtCell.get(i);
    return id ? this.txRemoveEntity(tx, id) : false;
  }

  private notePlacement(
    tx: Tx,
    i: number,
    author: Author,
    tile: PlacementEvent["tile"],
    tool: "paint" | "erase",
    stroke: string,
  ): void {
    const t = this.clock();
    this.lastPlacedAt[i] = t;
    this.lastPlacedBy[i] = author;
    if (author !== AUTHOR.PERSON) return;
    tx.placements.push({ t, x: i % this.w, y: Math.floor(i / this.w), tile, author, stroke, tool });
  }

  /**
   * Run a stroke-capable command (paint / erase / entity edits). Inside an
   * open stroke the delta merges into the stroke's command.
   */
  private run(kind: CommandKind, author: Author, body: (tx: Tx, stroke: string) => number): number {
    const stroke = this.openStroke?.id ?? `s${++this.strokeCounter}`;
    const tx: Tx = { delta: emptyDelta(), placements: [] };
    const before = this.captureForChange();
    const result = body(tx, stroke);
    if (deltaIsEmpty(tx.delta)) return result;
    this.commit(kind, author, tx, before, stroke);
    return result;
  }

  /** Run a command that is never merged into a stroke. */
  private runRaw(kind: CommandKind, author: Author, body: (tx: Tx) => void): Command | undefined {
    this.closeStroke();
    const tx: Tx = { delta: emptyDelta(), placements: [] };
    const before = this.captureForChange();
    body(tx);
    if (deltaIsEmpty(tx.delta)) return undefined;
    return this.commit(kind, author, tx, before, undefined);
  }

  private captureForChange(): Map<string, [number, number] | undefined> {
    const m = new Map<string, [number, number] | undefined>();
    for (const e of this.entityList) if (isEnemyKind(e.kind)) m.set(e.id, e.patrol);
    return m;
  }

  private commit(
    kind: CommandKind,
    author: Author,
    tx: Tx,
    patrolsBefore: Map<string, [number, number] | undefined>,
    stroke: string | undefined,
  ): Command {
    this.redoStack = [];
    let cmd: Command;
    const open = this.openStroke;
    const top = this.undoStack[this.undoStack.length - 1];
    if (open && stroke === open.id && open.command && open.command === top) {
      mergeDelta(open.command.delta, tx.delta);
      if (open.command.kind !== kind) open.command.kind = "stroke";
      cmd = open.command;
    } else {
      cmd = { seq: ++this.seq, kind, author, stroke, t: this.clock(), delta: tx.delta };
      this.undoStack.push(cmd);
      if (this.undoStack.length > this.maxHistory) this.undoStack.splice(0, this.undoStack.length - this.maxHistory);
      if (open && stroke === open.id) open.command = cmd;
    }
    this.refreshPatrols();
    const change = this.describe(tx.delta, "forward", source(author), patrolsBefore);
    this.rev++;
    this.changes.emit({ ...change, revision: this.rev });
    for (const p of tx.placements) this.placements.emit(p);
    return cmd;
  }

  /** Apply a stored delta backward (undo) or forward (redo) and emit. */
  private applyDelta(d: Delta, dir: "undo" | "redo"): LevelChangeInfo {
    const patrolsBefore = this.captureForChange();
    const fwd = dir === "redo";
    for (const c of d.cells.values()) this.writeCell(c.i, fwd ? c.after : c.before);
    const ops = fwd ? d.entityOps : [...d.entityOps].reverse();
    for (const op of ops) {
      const add = fwd ? op.op === "add" : op.op === "remove";
      if (add) {
        const e = cloneEntity(op.entity);
        this.entityList.splice(op.index, 0, e);
        this.entityAuthorMap.set(e.id, op.author);
        this.entityAtCell.set(this.index(e.x, e.y), e.id);
      } else {
        const idx = this.entityList.findIndex((x) => x.id === op.entity.id);
        if (idx >= 0) {
          const [e] = this.entityList.splice(idx, 1);
          this.entityAuthorMap.delete(e.id);
          const ci = this.index(e.x, e.y);
          if (this.entityAtCell.get(ci) === e.id) this.entityAtCell.delete(ci);
        }
      }
    }
    if (d.start) this.startPoint = { ...(fwd ? d.start.after : d.start.before) };
    if (d.goal) {
      const g = fwd ? d.goal.after : d.goal.before;
      this.goalPoint = g ? { ...g } : undefined;
    }
    this.refreshPatrols();
    const change = this.describe(d, fwd ? "forward" : "backward", dir, patrolsBefore);
    this.rev++;
    this.changes.emit({ ...change, revision: this.rev });
    return change;
  }

  /** Recompute every enemy's patrol from the current grid. */
  private refreshPatrols(): void {
    for (const e of this.entityList) {
      if (!isEnemyKind(e.kind)) {
        delete e.patrol;
        continue;
      }
      const p = computePatrol(this, e.x, e.y);
      if (p) e.patrol = p;
      else delete e.patrol;
    }
  }

  /** Build the LevelChange for a delta applied in `dir`. */
  private describe(
    d: Delta,
    dir: "forward" | "backward",
    src: LevelChange["source"],
    patrolsBefore: Map<string, [number, number] | undefined>,
  ): LevelChangeInfo {
    const cells: LevelChange["cells"] = [];
    for (const c of d.cells.values()) {
      const s = dir === "forward" ? c.after : c.before;
      const was = dir === "forward" ? c.before : c.after;
      if (sameCellState(s, was)) continue;
      cells.push({ x: c.i % this.w, y: Math.floor(c.i / this.w), tile: s.tile, author: s.author as Author });
    }
    // Net entity effect: first op tells whether it existed before, last op whether it exists after.
    const ops: EntityOp[] = dir === "forward" ? d.entityOps : [...d.entityOps].reverse();
    const first = new Map<string, boolean>();
    const last = new Map<string, boolean>();
    const touchedTwice = new Set<string>();
    for (const op of ops) {
      const adds = dir === "forward" ? op.op === "add" : op.op === "remove";
      const id = op.entity.id;
      if (!first.has(id)) first.set(id, !adds);
      else touchedTwice.add(id);
      last.set(id, adds);
    }
    const entitiesAdded: Entity[] = [];
    const entitiesRemoved: string[] = [];
    const addedIds = new Set<string>();
    for (const [id, existedBefore] of first) {
      const existsAfter = last.get(id)!;
      if (existedBefore) {
        if (!existsAfter) entitiesRemoved.push(id);
        else if (touchedTwice.has(id)) {
          entitiesRemoved.push(id);
          addedIds.add(id);
        }
      } else if (existsAfter) addedIds.add(id);
    }
    for (const e of this.entityList) if (addedIds.has(e.id)) entitiesAdded.push(cloneEntity(e));
    const entitiesUpdated: Entity[] = [];
    for (const e of this.entityList) {
      if (!isEnemyKind(e.kind) || addedIds.has(e.id) || !patrolsBefore.has(e.id)) continue;
      if (!samePatrol(patrolsBefore.get(e.id), e.patrol)) entitiesUpdated.push(cloneEntity(e));
    }
    const change: LevelChangeInfo = { cells, entitiesAdded, entitiesRemoved, source: src };
    if (entitiesUpdated.length) change.entitiesUpdated = entitiesUpdated;
    if (d.start) change.start = { ...this.startPoint };
    if (d.goal) change.goal = this.goalPoint ? { ...this.goalPoint } : null;
    return change;
  }
}

function source(author: Author): LevelChange["source"] {
  return author === AUTHOR.GHOST ? "ghost" : "person";
}

function clampPoint(p: Point, w: number, h: number): Point {
  return { x: Math.min(Math.max(0, p.x), w - 1), y: Math.min(Math.max(0, p.y), h - 1) };
}
