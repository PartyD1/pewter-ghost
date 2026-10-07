/**
 * Cell-level geometry of a suggestion: which cells it touches, what it wants
 * in each, its bounding box, and how a placement relates to it.
 */
import type { EntityKind, PlacementEvent, Point, Suggestion } from "../contracts";

export type GhostCell =
  | { x: number; y: number; type: "add"; tile: number }
  | { x: number; y: number; type: "remove" }
  | { x: number; y: number; type: "entity"; kind: EntityKind };

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const cellKey = (x: number, y: number): string => `${x},${y}`;

/** Every cell a suggestion touches: adds, removes and entity positions. */
export function ghostCells(s: Suggestion): GhostCell[] {
  const out: GhostCell[] = [];
  for (const a of s.adds) out.push({ x: a.x, y: a.y, type: "add", tile: a.tile });
  for (const r of s.removes) out.push({ x: r.x, y: r.y, type: "remove" });
  for (const e of s.entities) out.push({ x: e.x, y: e.y, type: "entity", kind: e.kind });
  return out;
}

/** Ghost cells grouped by cell key (a cell may hold e.g. a remove and an entity). */
export function ghostCellMap(s: Suggestion): Map<string, GhostCell[]> {
  const m = new Map<string, GhostCell[]>();
  for (const c of ghostCells(s)) {
    const k = cellKey(c.x, c.y);
    const list = m.get(k);
    if (list) list.push(c);
    else m.set(k, [c]);
  }
  return m;
}

/** Distinct touched cell keys. */
export function touchedKeys(s: Suggestion): Set<string> {
  return new Set(ghostCellMap(s).keys());
}

/** Bounding box of the touched cells; the anchor when the suggestion is empty. */
export function suggestionBox(s: Suggestion): Box {
  const cells = ghostCells(s);
  if (cells.length === 0) {
    return { x0: s.anchor.x, y0: s.anchor.y, x1: s.anchor.x, y1: s.anchor.y };
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cells) {
    if (c.x < x0) x0 = c.x;
    if (c.y < y0) y0 = c.y;
    if (c.x > x1) x1 = c.x;
    if (c.y > y1) y1 = c.y;
  }
  return { x0, y0, x1, y1 };
}

/** Do two boxes overlap once `a` is grown by `margin` tiles on each side? */
export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return (
    a.x0 - margin <= b.x1 &&
    b.x0 <= a.x1 + margin &&
    a.y0 - margin <= b.y1 &&
    b.y0 <= a.y1 + margin
  );
}

/** Chebyshev distance in tiles from a point to a box (0 inside). */
export function distanceToBox(p: Point, b: Box): number {
  const dx = p.x < b.x0 ? b.x0 - p.x : p.x > b.x1 ? p.x - b.x1 : 0;
  const dy = p.y < b.y0 ? b.y0 - p.y : p.y > b.y1 ? p.y - b.y1 : 0;
  return Math.max(dx, dy);
}

/**
 * How a placement relates to a ghost:
 *  - "outside": the placement is not on any ghost cell;
 *  - "match": it puts exactly what the ghost proposes there (same tile, erase
 *    on a removal, or the same entity kind) — a one-cell partial accept;
 *  - "conflict": it is on a ghost cell but puts something else — drawn over.
 */
export type PlacementRelation = "outside" | "match" | "conflict";

export function relatePlacement(
  cells: Map<string, GhostCell[]>,
  ev: Pick<PlacementEvent, "x" | "y" | "tile" | "tool">,
): { relation: PlacementRelation; cell?: GhostCell } {
  const list = cells.get(cellKey(ev.x, ev.y));
  if (!list || list.length === 0) return { relation: "outside" };
  const isErase = ev.tool === "erase" || ev.tile === 0;
  for (const c of list) {
    if (c.type === "remove" && isErase) return { relation: "match", cell: c };
    if (!isErase && c.type === "add" && typeof ev.tile === "number" && ev.tile === c.tile) {
      return { relation: "match", cell: c };
    }
    if (
      !isErase &&
      c.type === "entity" &&
      typeof ev.tile === "string" &&
      ev.tile === `entity:${c.kind}`
    ) {
      return { relation: "match", cell: c };
    }
  }
  return { relation: "conflict", cell: list[0] };
}

/** Stable signature of what a suggestion would change (for de-duplication). */
export function cellSignature(s: Suggestion): string {
  return ghostCells(s)
    .map((c) =>
      c.type === "add"
        ? `a${c.x},${c.y}=${c.tile}`
        : c.type === "remove"
          ? `r${c.x},${c.y}`
          : `e${c.x},${c.y}=${c.kind}`,
    )
    .sort()
    .join(";");
}

/**
 * The key a Fix is rate-limited and muted by: its label (normalised) plus its
 * anchor cell. Two fixes with the same caption at the same place are the same
 * problem.
 */
export function problemKey(s: Pick<Suggestion, "label" | "anchor">): string {
  const label = s.label.trim().toLowerCase().replace(/\s+/g, " ");
  return `${label}@${s.anchor.x},${s.anchor.y}`;
}
