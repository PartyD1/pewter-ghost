/**
 * Painting (G-04): continuous strokes on the level model.
 *
 * Pure logic, no Phaser. The scene's pointer binding (pointer.ts) decides
 * WHEN a stroke begins, moves and ends (canvas pointer events only, stopped
 * when the pointer leaves the canvas or is over DOM UI); this module decides
 * WHAT each stroke does to the model:
 *
 * - One stroke = model.beginStroke() ... model.endStroke() = one undo step.
 * - Pointer samples are joined with a Bresenham line so a fast drag never
 *   leaves holes (the old editor's "move slowly or it skips" bug).
 * - Each cell is applied at most once per stroke; each pointer move is one
 *   model call (one change event) however many cells it covers.
 * - Paint mode puts down the current brush; Erase mode erases tiles and
 *   entities. There is no right-click eraser and no eyedropper.
 */
import type { EntityKind, Point, TileId } from "../contracts";
import { DEFAULT_START, type LevelModel } from "../level/LevelModel";
import type { Brush, Mode } from "./modes";

/** The part of LevelModel painting needs (LevelModel satisfies it). */
export type PaintTarget = Pick<
  LevelModel,
  | "beginStroke"
  | "endStroke"
  | "currentStroke"
  | "paint"
  | "erase"
  | "placeEntity"
  | "removeEntity"
  | "entitiesAt"
  | "tileAt"
  | "inBounds"
  | "setStart"
  | "entities"
  | "start"
>;

/** Entity kinds placed once per click rather than along a drag. */
export const SINGLE_SHOT_ENTITIES: ReadonlySet<EntityKind> = new Set(["slime", "ultraslime", "flag", "sign"]);

/** Every cell on the line from a to b, inclusive, in order (Bresenham). */
export function lineCells(a: Point, b: Point): Point[] {
  const out: Point[] = [];
  let x0 = Math.trunc(a.x);
  let y0 = Math.trunc(a.y);
  const x1 = Math.trunc(b.x);
  const y1 = Math.trunc(b.y);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

export interface StrokeInfo {
  id: string | undefined;
  mode: "paint" | "erase";
  brush: Brush;
  /** Cells this stroke changed (in order). */
  cells: Point[];
}

export interface StrokeListeners {
  onBegin?: (s: StrokeInfo) => void;
  onEnd?: (s: StrokeInfo) => void;
}

const key = (p: Point) => `${p.x},${p.y}`;

export class StrokePainter {
  private active = false;
  private singleShot = false;
  private last: Point | undefined;
  private visited = new Set<string>();
  private info: StrokeInfo | undefined;
  private readonly listeners: StrokeListeners;

  constructor(
    private readonly model: PaintTarget,
    listeners: StrokeListeners = {},
  ) {
    this.listeners = listeners;
  }

  /** True between begin() and end()/cancel(). */
  get isActive(): boolean {
    return this.active;
  }

  get current(): StrokeInfo | undefined {
    return this.info;
  }

  /**
   * Start a stroke at `cell`. Only Paint and Erase modes paint; Select and
   * Pan return false and leave the level alone.
   */
  begin(cell: Point, mode: Mode, brush: Brush): boolean {
    if (this.active) this.end();
    if (mode !== "paint" && mode !== "erase") return false;
    if (!this.model.inBounds(cell.x, cell.y)) return false;

    const strokeMode = mode;
    this.active = true;
    this.visited.clear();
    this.last = { x: cell.x, y: cell.y };
    this.singleShot =
      strokeMode === "paint" &&
      (brush.kind === "start" || (brush.kind === "entity" && SINGLE_SHOT_ENTITIES.has(brush.entity)));

    if (strokeMode === "paint" && brush.kind === "start") {
      // Moving the start is its own command; no stroke needed.
      this.info = { id: undefined, mode: "paint", brush, cells: [] };
      this.listeners.onBegin?.(this.info);
      if (this.model.setStart({ x: cell.x, y: cell.y })) this.info.cells.push({ x: cell.x, y: cell.y });
      return true;
    }

    const id = this.model.beginStroke();
    this.info = { id, mode: strokeMode, brush, cells: [] };
    this.listeners.onBegin?.(this.info);
    this.apply([cell]);
    return true;
  }

  /** Extend the stroke to `cell`, filling every cell on the way. */
  move(cell: Point): number {
    if (!this.active || !this.info || this.singleShot || !this.last) return 0;
    if (cell.x === this.last.x && cell.y === this.last.y) return 0;
    const cells = lineCells(this.last, cell).slice(1);
    this.last = { x: cell.x, y: cell.y };
    return this.apply(cells);
  }

  /** Finish the stroke (pointer up, pointer left the canvas, mode change). */
  end(): void {
    if (!this.active) return;
    this.active = false;
    this.singleShot = false;
    this.last = undefined;
    if (this.info?.id !== undefined) this.model.endStroke();
    const info = this.info;
    this.info = undefined;
    this.visited.clear();
    if (info) this.listeners.onEnd?.(info);
  }

  /** Same as end(): edits made so far stay, as one undo step. */
  cancel(): void {
    this.end();
  }

  private apply(cells: Point[]): number {
    const info = this.info;
    if (!info) return 0;
    const fresh: Point[] = [];
    for (const c of cells) {
      const k = key(c);
      if (this.visited.has(k) || !this.model.inBounds(c.x, c.y)) continue;
      this.visited.add(k);
      fresh.push(c);
    }
    if (fresh.length === 0) return 0;

    let changedCells: Point[] = [];
    if (info.mode === "erase") {
      const todo = fresh.filter((c) => this.model.tileAt(c.x, c.y) !== 0 || this.model.entitiesAt(c.x, c.y).length > 0);
      if (todo.length) {
        this.model.erase(todo);
        changedCells = todo;
      }
      // Erasing the Start pennant puts the knight back on the default start
      // (a level always has a start; the pennant only shows when it is moved).
      const st = this.model.start;
      const onStart = fresh.find((c) => c.x === st.x && c.y === st.y);
      if (onStart && (st.x !== DEFAULT_START.x || st.y !== DEFAULT_START.y) && this.model.setStart({ ...DEFAULT_START })) {
        if (!changedCells.some((c) => c.x === onStart.x && c.y === onStart.y)) changedCells = [...changedCells, onStart];
      }
    } else if (info.brush.kind === "tile") {
      const tile: TileId = info.brush.tile;
      const todo = fresh.filter((c) => this.model.tileAt(c.x, c.y) !== tile || this.model.entitiesAt(c.x, c.y).length > 0);
      if (todo.length) {
        this.model.paint(todo.map((c) => ({ x: c.x, y: c.y, tile })));
        changedCells = todo;
      }
    } else if (info.brush.kind === "entity") {
      const { entity, text } = info.brush;
      for (const c of fresh) {
        const here = this.model.entitiesAt(c.x, c.y);
        if (here.some((e) => e.kind === entity && (entity !== "sign" || (e.text ?? "") === (text ?? "")))) continue;
        if (entity === "flag") {
          // One goal flag per level: moving it is part of the same stroke (one undo step).
          for (const e of this.model.entities) if (e.kind === "flag") this.model.removeEntity(e.id);
        }
        const placed = this.model.placeEntity(entity, c.x, c.y, entity === "sign" ? { text: text ?? "" } : {});
        if (placed) changedCells.push(c);
      }
    }
    for (const c of changedCells) info.cells.push({ x: c.x, y: c.y });
    return changedCells.length;
  }
}
