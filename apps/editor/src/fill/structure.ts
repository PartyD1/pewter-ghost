/**
 * "What is the person building?" as one computed line for the prompt.
 *
 * The model reads an ASCII window and, left alone, often misreads the SHAPE of a
 * half-drawn structure (a staircase going up and to the right becomes "fill
 * below it"). The local detectors (@chunks detectFinish) read the same strokes
 * exactly: they know a step is 2 wide and rises 1, that it is filled or hollow,
 * which tiles cap it. This module runs them on the request and states the
 * result, with the exact continuation cells, so the model can copy it, extend
 * it, or (when the strokes clearly mean something else) say why not.
 *
 * Pure and deterministic: the same request gives the same line. Window
 * coordinates, like everything else the model reads and writes.
 */
import { detectFinish, type FinishProposal } from "@chunks";
import type { FillRequest } from "../contracts";
import { parseWindowGrid } from "./windowGrid";

/** Most cells spelled out one by one; beyond this the cells are summarised as boxes. */
const MAX_LISTED_CELLS = 24;

const cellText = (a: { x: number; y: number; tile: string }) => `${a.tile}(${a.x},${a.y})`;

/** The continuation grouped per tile: "grass (12,5) (13,5); dirt (12,6) ...". */
function cellsText(adds: FinishProposal["adds"]): string {
  const sorted = [...adds].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length <= MAX_LISTED_CELLS) return sorted.map(cellText).join(" ");
  const xs = sorted.map((a) => a.x);
  const ys = sorted.map((a) => a.y);
  const tiles = [...new Set(sorted.map((a) => a.tile))].join("/");
  return `${sorted.length} ${tiles} cells in columns ${Math.min(...xs)}-${Math.max(...xs)}, rows ${Math.min(...ys)}-${Math.max(...ys)}`;
}

/** "up and to the right" from where the last stroke is to where the continuation goes. */
function directionOf(p: FinishProposal, last: { x: number; y: number } | undefined): string {
  if (!last || !p.adds.length) return "";
  const far = p.adds.reduce((a, b) => (Math.abs(b.x - last.x) + Math.abs(b.y - last.y) > Math.abs(a.x - last.x) + Math.abs(a.y - last.y) ? b : a));
  const dx = far.x - last.x;
  const dy = far.y - last.y;
  const parts: string[] = [];
  if (dy < 0) parts.push("up");
  else if (dy > 0) parts.push("down");
  if (dx > 0) parts.push("to the right");
  else if (dx < 0) parts.push("to the left");
  return parts.join(" and ");
}

/** The detector's reading of the strokes: the best proposal that continues the last one. */
export function detectStructure(req: Pick<FillRequest, "grid" | "size" | "recent">): FinishProposal | undefined {
  if (!req.recent.length) return undefined;
  const grid = parseWindowGrid(req);
  if (!grid) return undefined;
  const proposals = detectFinish(
    grid,
    req.recent.map((r) => ({ x: r.x, y: r.y, tile: r.tile, tool: r.tool })),
  );
  return proposals.find((p) => p.touchesLast && p.adds.length > 0);
}

/**
 * One line describing the structure the person is drawing, or undefined when
 * the strokes do not clearly continue (nothing recent, an unreadable window,
 * or the best reading does not touch the last stroke).
 */
export function describeStructure(req: Pick<FillRequest, "grid" | "size" | "recent">): string | undefined {
  const best = detectStructure(req);
  if (!best) return undefined;
  const last = [...req.recent].reverse().find((r) => r.tool === "paint");
  const dir = directionOf(best, last);
  const cells = cellsText(best.adds);
  return (
    `detected (computed from the strokes, reliable about the shape): ${best.label}${dir ? `, going ${dir}` : ""}; ` +
    `its continuation is ${cells}. ` +
    `Use it as your finish unless the strokes clearly mean something else.`
  );
}
