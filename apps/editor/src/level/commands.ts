/**
 * Command records for the level model's undo log.
 *
 * Every command is stored as a reversible delta: per-cell before/after states,
 * an ordered list of entity add/remove operations (with list positions, so undo
 * restores the exact entity order), and optional start/goal changes. "Do",
 * "undo" and "redo" are all the same generic delta application, which is what
 * makes "any command sequence then undo-all = identity" hold by construction.
 */
import type { Author, Entity, Point } from "../contracts";

export interface CellState {
  tile: number;
  author: number;
  /** Suggestion id for accepted ghost cells. */
  prov: string | undefined;
}

export interface CellChange {
  i: number;
  before: CellState;
  after: CellState;
}

export interface EntityOp {
  op: "add" | "remove";
  /** Immutable copy of the entity at the time of the operation. */
  entity: Entity;
  author: Author;
  /** Position in the entity list where it was inserted / removed from. */
  index: number;
}

export interface Delta {
  cells: Map<number, CellChange>;
  entityOps: EntityOp[];
  start?: { before: Point; after: Point };
  goal?: { before: Point | undefined; after: Point | undefined };
}

export type CommandKind =
  | "paint"
  | "erase"
  | "placeEntity"
  | "removeEntity"
  | "applySuggestion"
  | "setStart"
  | "setGoal"
  | "stroke";

export interface Command {
  /** Monotonic per model. */
  seq: number;
  kind: CommandKind;
  /** Who issued the command (PERSON for edits, GHOST for applySuggestion). */
  author: Author;
  /** Stroke id when the command came from (or is) a paint/erase stroke. */
  stroke?: string;
  /** For applySuggestion. */
  suggestionId?: string;
  /** Session clock time when the command was first done. */
  t: number;
  delta: Delta;
}

export const emptyDelta = (): Delta => ({ cells: new Map(), entityOps: [] });

export const sameCellState = (a: CellState, b: CellState): boolean =>
  a.tile === b.tile && a.author === b.author && a.prov === b.prov;

export function deltaIsEmpty(d: Delta): boolean {
  if (d.entityOps.length || d.start || d.goal) return false;
  for (const c of d.cells.values()) if (!sameCellState(c.before, c.after)) return false;
  return true;
}

/**
 * Merge `next` into `into` (used when a stroke spans several paint calls).
 * Cell changes keep the earliest `before` and the latest `after`.
 */
export function mergeDelta(into: Delta, next: Delta): void {
  for (const [i, c] of next.cells) {
    const prev = into.cells.get(i);
    if (prev) prev.after = c.after;
    else into.cells.set(i, { i, before: c.before, after: c.after });
  }
  into.entityOps.push(...next.entityOps);
  if (next.start) into.start = into.start ? { before: into.start.before, after: next.start.after } : next.start;
  if (next.goal) into.goal = into.goal ? { before: into.goal.before, after: next.goal.after } : next.goal;
}

/** Who authored the content a command touched: used for undo/redo log events. */
export function commandWhat(cmd: Command): "own" | "ghost" | "mixed" {
  if (cmd.kind === "applySuggestion") return "ghost";
  let person = false;
  let ghost = false;
  const mark = (a: number) => {
    if (a === 1) person = true;
    else if (a === 2) ghost = true;
  };
  mark(cmd.author);
  for (const c of cmd.delta.cells.values()) {
    mark(c.before.author);
    mark(c.after.author);
  }
  for (const op of cmd.delta.entityOps) mark(op.author);
  if (ghost && person) return "mixed";
  return ghost ? "ghost" : "own";
}
