/**
 * Selection tool (Select mode): drag a box over a stretch of level, then
 * delete it, move it (Alt-drag copies), or copy / cut / paste it.
 *
 * Pure logic, no Phaser. pointer.ts decides WHEN a gesture starts, moves and
 * ends; this module decides WHAT it does to the model. Every edit is one
 * model stroke, so one Ctrl+Z undoes a whole move, delete or paste.
 *
 * - Empty cells in a moved / pasted block are transparent: they never wipe
 *   what is underneath, only the block's tiles and entities land.
 * - The Start pennant is not part of a selection (it has its own drag).
 * - The goal flag moves with a moved block but is never copied (a level has
 *   exactly one).
 */
import { SOLID_TILES, type EntityKind, type Point, type TileId } from "../contracts";
import type { LevelModel } from "../level/LevelModel";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What Select needs from the level (LevelModel satisfies it). */
export type SelectTarget = Pick<
  LevelModel,
  | "w"
  | "h"
  | "inBounds"
  | "tileAt"
  | "entitiesInRect"
  | "beginStroke"
  | "endStroke"
  | "paint"
  | "erase"
  | "placeEntity"
  | "removeEntity"
>;

/** A block of level copied off, positions relative to its top-left corner. */
export interface Clip {
  w: number;
  h: number;
  tiles: { dx: number; dy: number; tile: TileId }[];
  entities: { dx: number; dy: number; kind: EntityKind; text?: string }[];
}

export const rectContains = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/** The rectangle spanning two corner cells, in either order. */
export function rectFromCorners(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}

type Drag =
  | { kind: "marquee"; anchor: Point; now: Point }
  | { kind: "move"; grab: Point; delta: Point };

export type ReleaseResult = "selected" | "clicked" | "moved" | "copied" | "none";

export class SelectionController {
  /** The selected block, if any. */
  rect: Rect | null = null;
  /** What Ctrl+C / Ctrl+X last took. */
  clip: Clip | null = null;
  private drag: Drag | null = null;

  constructor(private readonly model: SelectTarget) {}

  get dragging(): boolean {
    return this.drag !== null;
  }

  get isMoving(): boolean {
    return this.drag?.kind === "move";
  }

  /** The box to draw while a gesture is in progress: the marquee, or where a move would land. */
  previewRect(): Rect | null {
    const d = this.drag;
    if (!d) return null;
    if (d.kind === "marquee") return rectFromCorners(d.anchor, d.now);
    return this.rect ? this.shifted(this.rect, d.delta) : null;
  }

  /** Pointer pressed on `cell`. Pressing inside the selection grabs it to move; elsewhere starts a new box. */
  press(cell: Point): void {
    if (!this.model.inBounds(cell.x, cell.y)) return;
    if (this.rect && rectContains(this.rect, cell)) this.drag = { kind: "move", grab: { ...cell }, delta: { x: 0, y: 0 } };
    else this.drag = { kind: "marquee", anchor: { ...cell }, now: { ...cell } };
  }

  /** Pointer moved with the button held. */
  dragTo(cell: Point): void {
    const d = this.drag;
    if (!d) return;
    const c = this.clampCell(cell);
    if (d.kind === "marquee") d.now = c;
    else if (this.rect) d.delta = this.clampDelta(this.rect, { x: cell.x - d.grab.x, y: cell.y - d.grab.y });
  }

  /** Pointer released. `copy` (Alt held) leaves the original in place. */
  release(cell: Point, copy = false): ReleaseResult {
    const d = this.drag;
    this.drag = null;
    if (!d) return "none";
    if (d.kind === "marquee") {
      const end = this.clampCell(cell);
      const click = d.anchor.x === end.x && d.anchor.y === end.y;
      this.rect = rectFromCorners(d.anchor, end);
      return click ? "clicked" : "selected";
    }
    const rect = this.rect;
    if (!rect) return "none";
    const delta = this.clampDelta(rect, { x: cell.x - d.grab.x, y: cell.y - d.grab.y });
    if (delta.x === 0 && delta.y === 0) return "none";
    this.move(rect, delta, copy);
    this.rect = this.shifted(rect, delta);
    return copy ? "copied" : "moved";
  }

  /** Abandon a gesture in progress (mode change, window blur) without editing anything. */
  cancel(): void {
    this.drag = null;
  }

  clear(): void {
    this.drag = null;
    this.rect = null;
  }

  selectAll(): void {
    this.drag = null;
    this.rect = { x: 0, y: 0, w: this.model.w, h: this.model.h };
  }

  /** Erase everything in the selection. Returns cells changed. */
  deleteSelection(): number {
    const r = this.rect;
    if (!r) return 0;
    return this.inStroke(() => this.model.erase(this.cellsOf(r)));
  }

  /** Take a copy of the selection. Returns false when nothing is selected. */
  copy(): boolean {
    if (!this.rect) return false;
    this.clip = this.read(this.rect, false);
    return true;
  }

  /** Copy then delete. */
  cut(): boolean {
    if (!this.copy()) return false;
    this.deleteSelection();
    return true;
  }

  /**
   * Put the copied block down with its top-left corner at `at` (kept inside
   * the level), and select it so it can be dragged further.
   */
  paste(at: Point): boolean {
    const clip = this.clip;
    if (!clip) return false;
    const x = Math.max(0, Math.min(this.model.w - clip.w, at.x));
    const y = Math.max(0, Math.min(this.model.h - clip.h, at.y));
    const dest: Rect = { x, y, w: clip.w, h: clip.h };
    this.inStroke(() => this.write(clip, dest.x, dest.y));
    this.rect = dest;
    return true;
  }

  // ---------------------------------------------------------------------------

  private move(rect: Rect, delta: Point, copy: boolean): void {
    const clip = this.read(rect, !copy);
    this.inStroke(() => {
      if (!copy) this.model.erase(this.cellsOf(rect));
      return this.write(clip, rect.x + delta.x, rect.y + delta.y);
    });
  }

  /** Read a block; `withFlag` lets the goal flag come along (moves only). */
  private read(r: Rect, withFlag: boolean): Clip {
    const tiles: Clip["tiles"] = [];
    for (let dy = 0; dy < r.h; dy++)
      for (let dx = 0; dx < r.w; dx++) {
        const tile = this.model.tileAt(r.x + dx, r.y + dy);
        if (SOLID_TILES.has(tile)) tiles.push({ dx, dy, tile: tile as TileId });
      }
    const entities: Clip["entities"] = [];
    for (const e of this.model.entitiesInRect(r.x, r.y, r.w, r.h)) {
      if (e.kind === "flag" && !withFlag) continue;
      const item: Clip["entities"][number] = { dx: e.x - r.x, dy: e.y - r.y, kind: e.kind };
      if (e.text !== undefined) item.text = e.text;
      entities.push(item);
    }
    return { w: r.w, h: r.h, tiles, entities };
  }

  /** Put a clip down at (x, y): tiles first, then entities. Call inside a stroke. */
  private write(clip: Clip, x: number, y: number): number {
    let n = 0;
    const cells = clip.tiles.map((t) => ({ x: x + t.dx, y: y + t.dy, tile: t.tile }));
    if (cells.length) n += this.model.paint(cells);
    for (const e of clip.entities) {
      const ex = x + e.dx;
      const ey = y + e.dy;
      if (e.kind === "flag") for (const old of this.model.entitiesInRect(0, 0, this.model.w, this.model.h)) if (old.kind === "flag") this.model.removeEntity(old.id);
      if (this.model.placeEntity(e.kind, ex, ey, e.text !== undefined ? { text: e.text } : {})) n++;
    }
    return n;
  }

  private inStroke<T>(fn: () => T): T {
    this.model.beginStroke();
    try {
      return fn();
    } finally {
      this.model.endStroke();
    }
  }

  private cellsOf(r: Rect): Point[] {
    const out: Point[] = [];
    for (let dy = 0; dy < r.h; dy++) for (let dx = 0; dx < r.w; dx++) out.push({ x: r.x + dx, y: r.y + dy });
    return out;
  }

  private shifted(r: Rect, d: Point): Rect {
    return { x: r.x + d.x, y: r.y + d.y, w: r.w, h: r.h };
  }

  private clampCell(c: Point): Point {
    return { x: Math.max(0, Math.min(this.model.w - 1, c.x)), y: Math.max(0, Math.min(this.model.h - 1, c.y)) };
  }

  /** Keep the moved block fully inside the level. */
  private clampDelta(r: Rect, d: Point): Point {
    return {
      x: Math.max(-r.x, Math.min(this.model.w - r.w - r.x, d.x)),
      y: Math.max(-r.y, Math.min(this.model.h - r.h - r.y, d.y)),
    };
  }
}
