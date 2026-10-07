/**
 * Extend ghosts and the viewport (G-11): which part of a ghost the camera
 * should bring into view, and where the edge arrow goes when a ghost reaches
 * past the screen. Pure; tile coordinates.
 */
import type { Point, Suggestion } from "../contracts";
import { ghostCells, suggestionBox, type Box } from "../suggest/geometry";

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The leading third of a ghost: the third of its cells (by distance from the
 * anchor along the ghost's long axis) nearest the anchor, as a box. For an
 * Extend ghost the anchor sits at the frontier, so this is the part the person
 * should see first. Never empty: at least one cell.
 */
export function leadingBox(s: Pick<Suggestion, "adds" | "removes" | "entities" | "anchor">): Box {
  const cells = ghostCells(s as Suggestion);
  if (cells.length === 0) return { x0: s.anchor.x, y0: s.anchor.y, x1: s.anchor.x, y1: s.anchor.y };
  const full = suggestionBox(s as Suggestion);
  const horizontal = full.x1 - full.x0 >= full.y1 - full.y0;
  const dist = (p: Point) => (horizontal ? Math.abs(p.x - s.anchor.x) : Math.abs(p.y - s.anchor.y));
  const sorted = [...cells].sort((a, b) => dist(a) - dist(b) || a.x - b.x || a.y - b.y);
  const n = Math.max(1, Math.ceil(sorted.length / 3));
  const lead = sorted.slice(0, n);
  // Include the whole cross-axis extent so the first third is not a sliver.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const c of lead) {
    x0 = Math.min(x0, c.x);
    x1 = Math.max(x1, c.x);
    y0 = Math.min(y0, c.y);
    y1 = Math.max(y1, c.y);
  }
  return horizontal ? { x0, x1, y0: full.y0, y1: full.y1 } : { x0: full.x0, x1: full.x1, y0, y1 };
}

/** Is any part of the box inside the view? Cells are 1x1 tiles. */
export function boxVisible(view: ViewRect, b: Box): boolean {
  return b.x1 + 1 > view.x && b.x0 < view.x + view.w && b.y1 + 1 > view.y && b.y0 < view.y + view.h;
}

/** Is the whole box inside the view? */
export function boxInside(view: ViewRect, b: Box): boolean {
  return b.x0 >= view.x && b.x1 + 1 <= view.x + view.w && b.y0 >= view.y && b.y1 + 1 <= view.y + view.h;
}

export type ArrowSide = "left" | "right" | "up" | "down";

export interface EdgeArrow {
  side: ArrowSide;
  /** Where the arrow sits, in tile coordinates on the view's edge (inset by `inset`). */
  at: Point;
  /** Tiles of the ghost beyond that edge. */
  beyond: number;
}

/**
 * The edge arrow for a ghost that reaches past the viewport, or null when
 * the whole ghost is on screen (less than `tolerance` tiles hidden). The arrow goes on the side where most of the
 * hidden part is, level with the ghost's centre (clamped to the edge).
 */
export function edgeArrow(view: ViewRect, b: Box, inset = 1, tolerance = 0.5): EdgeArrow | null {
  const right = b.x1 + 1 - (view.x + view.w);
  const left = view.x - b.x0;
  const down = b.y1 + 1 - (view.y + view.h);
  const up = view.y - b.y0;
  const options: [ArrowSide, number][] = [
    ["right", right],
    ["left", left],
    ["down", down],
    ["up", up],
  ];
  options.sort((a, c) => c[1] - a[1]);
  const [side, beyond] = options[0];
  if (beyond <= tolerance) return null; // a sliver past the edge is still "on screen"
  const cx = (b.x0 + b.x1 + 1) / 2;
  const cy = (b.y0 + b.y1 + 1) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const ix = Math.min(inset, view.w / 2);
  const iy = Math.min(inset, view.h / 2);
  const xIn = clamp(cx, view.x + ix, view.x + view.w - ix);
  const yIn = clamp(cy, view.y + iy, view.y + view.h - iy);
  let at: Point;
  switch (side) {
    case "right":
      at = { x: view.x + view.w - ix, y: yIn };
      break;
    case "left":
      at = { x: view.x + ix, y: yIn };
      break;
    case "down":
      at = { x: xIn, y: view.y + view.h - iy };
      break;
    default:
      at = { x: xIn, y: view.y + iy };
  }
  return { side, at, beyond: Math.ceil(beyond) };
}

/** Rotation (degrees) for a right-pointing glyph to face `side`. */
export const arrowRotation = (side: ArrowSide): number => ({ right: 0, down: 90, left: 180, up: 270 })[side];
