/**
 * Ghost input (G-11): keys and drawing → SuggestionManager.
 *
 *  - Tab / Esc / Ctrl+Space / R (Play) through DOM listeners (see keys.ts).
 *    The keydown listener runs in the capture phase so Tab never reaches the
 *    browser's focus navigation while a ghost is shown.
 *  - Person placements (LevelModel.onPlacement: paint, erase, entity edits)
 *    go to manager.onPlacement. The manager decides: the exact proposed thing
 *    on a ghost cell accepts that cell (partial); anything else on a ghost
 *    cell, or drawing elsewhere, dismisses ("drawn-over").
 *  - Undo / redo change cells without placements: manager.onCellsChanged.
 *    Cells applied by accepting a ghost (source "ghost") are NOT reported.
 *  - A level load resets the manager (a shown ghost ends "pending").
 */
import type { Entity, LevelChange, PlacementEvent, Point } from "../contracts";
import { isTypingTarget } from "../editor/keys";
import type { LevelChangeEx, LevelModel } from "../level/LevelModel";
import { ghostKeyAction, type GhostKeyAction, type GhostKeyLike } from "./keys";

export interface ManagerInputs {
  readonly shown: unknown;
  readonly requestPending: boolean;
  onPlacement(ev: PlacementEvent): void;
  onCellsChanged(cells: Point[], t?: number, stroke?: string): void;
  reset(): void;
}

export interface GhostInputDeps {
  model: Pick<LevelModel, "onPlacement" | "subscribe" | "entities">;
  manager: ManagerInputs;
  isPlaying(): boolean;
  isStrokeActive(): boolean;
  dialogOpen(): boolean;
  /** Tab. */
  accept(): void;
  /** Esc. */
  dismiss(): void;
  /** Ctrl+Space. */
  request(): void;
  /** R in Play mode. */
  route(): void;
  /** After a level load reset the manager. */
  onLoad?(): void;
  /** Session clock (ms); default performance.now. */
  clock?: () => number;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/**
 * Cells a non-placement change touched: changed tiles plus the cells of
 * entities added, removed or updated. `entityPos` remembers where entities
 * were (a removal only carries the id); it is updated in place.
 */
export function changedCells(change: LevelChange & Partial<Pick<LevelChangeEx, "entitiesUpdated">>, entityPos: Map<string, Point>): Point[] {
  const out = new Map<string, Point>();
  const add = (p: Point) => out.set(`${p.x},${p.y}`, { x: p.x, y: p.y });
  for (const c of change.cells) add(c);
  for (const id of change.entitiesRemoved) {
    const p = entityPos.get(id);
    if (p) add(p);
    entityPos.delete(id);
  }
  const touch = (e: Entity) => {
    add(e);
    entityPos.set(e.id, { x: e.x, y: e.y });
  };
  for (const e of change.entitiesAdded) touch(e);
  for (const e of change.entitiesUpdated ?? []) entityPos.set(e.id, { x: e.x, y: e.y });
  return [...out.values()];
}

/** Wire keys and model events to the manager. Returns an unbind function. */
export function bindGhostInput(d: GhostInputDeps): () => void {
  const clock = d.clock ?? (() => performance.now());
  const target = d.target ?? window;
  const entityPos = new Map<string, Point>();
  for (const e of d.model.entities) entityPos.set(e.id, { x: e.x, y: e.y });

  const onKey = (e: KeyboardEvent) => {
    const action = keyActionFor(e, d);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    switch (action) {
      case "accept":
        // Never apply under an active brush; the key is still swallowed.
        if (!d.isStrokeActive()) d.accept();
        break;
      case "dismiss":
        d.dismiss();
        break;
      case "request":
        d.request();
        break;
      case "route":
        d.route();
        break;
    }
  };
  target.addEventListener("keydown", onKey as EventListener, { capture: true });

  const offPlace = d.model.onPlacement((ev) => d.manager.onPlacement(ev));
  const offChange = d.model.subscribe((ch) => {
    if (ch.source === "load") {
      entityPos.clear();
      for (const e of d.model.entities) entityPos.set(e.id, { x: e.x, y: e.y });
      d.manager.reset();
      d.onLoad?.();
      return;
    }
    const cells = changedCells(ch, entityPos);
    if (ch.source === "undo" || ch.source === "redo") {
      if (cells.length) d.manager.onCellsChanged(cells, clock(), `${ch.source}@${ch.revision}`);
    }
  });

  return () => {
    target.removeEventListener("keydown", onKey as EventListener, { capture: true });
    offPlace();
    offChange();
  };
}

function keyActionFor(e: KeyboardEvent | GhostKeyLike, d: GhostInputDeps): GhostKeyAction | null {
  return ghostKeyAction(e, {
    showing: !!d.manager.shown,
    requestPending: d.manager.requestPending,
    playing: d.isPlaying(),
    typing: isTypingTarget((e as KeyboardEvent).target ?? null),
    dialogOpen: d.dialogOpen(),
  });
}
