/**
 * Beatability with the physics-exact playtest agent (@physsim search), from
 * the level start to the flag. The agent models the knight and the tiles
 * exactly; it does not model enemies (they patrol and can be jumped or
 * stomped), so enemy placement is checked by lint rules in build.ts instead.
 */
import {
  gridFromCells,
  isStandable,
  search,
  settleStart,
  THOROUGH_PASSES,
  type SearchResult,
  type TileRect,
} from "@physsim";
import type { LevelSnapshot, Point } from "../../apps/editor/src/contracts";
import { flagOf } from "./source";

export interface BeatOptions {
  /** Wall-clock cap for the whole search, ms. Default 30 000 (offline, so generous). */
  capMs?: number;
  /** Node cap. Default 4 000 000. */
  maxNodes?: number;
}

export interface BeatResult {
  /** The agent found inputs from the start to the goal. */
  beatable: boolean;
  /** Every reachable state was explored without reaching the goal (the strongest "no"). */
  exhausted: boolean;
  timedOut: boolean;
  from: Point;
  goal: TileRect;
  /** What the goal is: the flag, or (open levels) the rightmost standable column. */
  goalKind: "flag" | "frontier";
  frames?: number;
  /** Seconds of play at 60 fps. */
  seconds?: number;
  nodes: number;
  ms: number;
  /** Standing cell nearest the goal the agent reached. */
  blockedAt?: Point;
  /** Body-centre cells along the route (when beatable). */
  path: Point[];
}

/** Rightmost column with a standable cell, or -1. */
export function rightmostStandable(snap: LevelSnapshot): number {
  const grid = gridFromCells(snap.cells, snap.w, snap.h);
  for (let x = snap.w - 1; x >= 0; x--) for (let y = 0; y + 1 < snap.h; y++) if (isStandable(grid, x, y)) return x;
  return -1;
}

/**
 * The goal region. With a flag: standing (or passing) in the flag's column at
 * the flag's row or the row above (the flag body is 16 px tall). Without one:
 * any standing cell in the rightmost standable column.
 */
export function goalOf(snap: LevelSnapshot): { goal: TileRect; kind: "flag" | "frontier" } {
  const f = flagOf(snap);
  if (f) return { goal: { x0: f.x, x1: f.x, y0: f.y - 1, y1: f.y }, kind: "flag" };
  const x = rightmostStandable(snap);
  return { goal: { x0: Math.max(0, x) }, kind: "frontier" };
}

/** Run the playtest agent from the level start to its goal. */
export function verifyBeatable(snap: LevelSnapshot, opts: BeatOptions = {}): BeatResult {
  const grid = gridFromCells(snap.cells, snap.w, snap.h);
  const { goal, kind } = goalOf(snap);
  const from = settleStart(grid, snap.start);
  if (!from)
    return {
      beatable: false,
      exhausted: true,
      timedOut: false,
      from: snap.start,
      goal,
      goalKind: kind,
      nodes: 0,
      ms: 0,
      path: [],
    };
  const r: SearchResult = search(grid, from, goal, {
    capMs: opts.capMs ?? 30_000,
    maxNodes: opts.maxNodes ?? 4_000_000,
    passes: THOROUGH_PASSES,
  });
  return {
    beatable: r.found,
    exhausted: r.exhausted,
    timedOut: r.timedOut,
    from,
    goal,
    goalKind: kind,
    frames: r.frames,
    seconds: r.frames !== undefined ? Math.round((r.frames / 60) * 100) / 100 : undefined,
    nodes: r.nodes,
    ms: Math.round(r.ms),
    blockedAt: r.blockedAt,
    path: r.path,
  };
}
