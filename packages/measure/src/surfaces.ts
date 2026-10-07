/**
 * Standable surfaces and the transitions between them: the skeleton every
 * measure is computed on.
 *
 * Surface: a maximal horizontal run of standing cells (empty cell with a solid
 * tile directly below) on one row. Widths are measured on the whole row even
 * when only part of the surface is inside the measured rect, so a run-up or a
 * rest is judged by its real size.
 *
 * Transition: how the knight gets from one surface to the next, reading the
 * level left to right (the travel direction in Pewter). Every surface gets at
 * most one forward transition, chosen as the designer most likely meant it:
 *
 *  1. the cheapest (gap + |dy|) target that is not lower and is physically
 *     reachable (ULTRA tier, full run-up): the next step, platform or ledge;
 *  2. otherwise the highest reachable lower target (a drop, or a descending
 *     platform before the floor under it);
 *  3. otherwise the nearest target at all (by gap, then |dy|), recorded as
 *     unreachable: this is how a too-wide gap or too-tall wall shows up.
 *
 * Surfaces that nothing leads into and that hang above another surface (a
 * floating platform over the floor) get a "climb" transition from the nearest
 * surface below. Forward transitions always move the surface's right end
 * strictly right, so following them never loops.
 */
import type { Point } from "../../../apps/editor/src/contracts";
import { canReach, maxGap, maxGapRaw, FULL_RUNWAY, DESIGN_TIER, type Tier } from "@jump-tables";
import { hasSolidBelow, isSolid, isStanding, type GridLike, type Rect } from "./grid";

export interface Surface {
  /** Index in the surfaces array. */
  id: number;
  /** Standing row (the empty row the knight's feet are in). */
  y: number;
  x0: number;
  x1: number;
  width: number;
  /** Minimum, over the surface's columns, of consecutive solid tiles directly below (capped at 8). */
  depth: number;
}

export type TransitionKind = "jump" | "step" | "drop" | "climb";

export interface Transition {
  from: number;
  to: number;
  kind: TransitionKind;
  /** Empty columns crossed (0 for step, drop and climb). */
  gap: number;
  /** Target row minus takeoff row (negative = up). */
  dy: number;
  /** Standing cell the knight leaves from. */
  takeoff: Point;
  /** First standing cell on the target. */
  landing: Point;
  /** Flat standing tiles behind the takeoff (0..FULL_RUNWAY). */
  runway: number;
  /** Clearable at the design tier with the available run-up. */
  reachable: boolean;
  /** Clearable by anyone at all (ULTRA tier, full run-up). */
  possible: boolean;
  /** Missing the jump means falling out of the level. */
  lethal: boolean;
  /** Design-tier reach minus gap, in tiles (negative = too wide). */
  slack: number;
  /** GUARANTEED-tier (most forgiving timing) reach minus gap, in tiles. */
  slackGuaranteed: number;
}

export interface SurfaceGraph {
  surfaces: Surface[];
  /** Forward transitions followed by climb transitions. */
  transitions: Transition[];
  /** surface id -> its forward transition index, or -1. */
  next: number[];
  /** Root-to-end paths of forward transitions (transition indices). */
  routes: number[][];
}

const MAX_DEPTH = 8;

const inCols = (r: Rect, x: number) => x >= r.x && x < r.x + r.w;

/** All surfaces on rows inside `r` that overlap its columns. */
export function findSurfaces(g: GridLike, r: Rect): Surface[] {
  const out: Surface[] = [];
  const cx0 = r.x,
    cx1 = r.x + r.w - 1;
  for (let y = r.y; y < r.y + r.h; y++) {
    let x = 0;
    while (x < g.w) {
      if (!isStanding(g, x, y)) {
        x++;
        continue;
      }
      const x0 = x;
      while (x + 1 < g.w && isStanding(g, x + 1, y)) x++;
      const x1 = x;
      x++;
      if (x1 < cx0 || x0 > cx1) continue;
      let depth = MAX_DEPTH;
      for (let xx = x0; xx <= x1; xx++) {
        let d = 0;
        while (d < MAX_DEPTH && isSolid(g, xx, y + 1 + d)) d++;
        depth = Math.min(depth, d);
      }
      out.push({ id: out.length, y, x0, x1, width: x1 - x0 + 1, depth });
    }
  }
  return out;
}

/**
 * A jump over `gap` columns is blocked when a gap column is solid anywhere
 * between the takeoff and landing heights: a face in the way. Ceilings are
 * not checked here: under a low ceiling the knight can still make a short
 * hop by releasing jump early, which the open-sky arcs do not model. The
 * physics agent is the verdict on those.
 */
function faceClear(g: GridLike, s: Surface, t: Surface): boolean {
  const lo = Math.min(s.y, t.y);
  const hi = Math.max(s.y, t.y);
  for (let cx = s.x1 + 1; cx < t.x0; cx++) for (let y = lo; y <= hi; y++) if (isSolid(g, cx, y)) return false;
  return true;
}

interface Candidate {
  t: Surface;
  gap: number;
  dy: number;
  landingX: number;
  possible: boolean;
  /** No face between takeoff and landing. */
  clear: boolean;
}

function slackAt(gap: number, dy: number, runway: number, tier: Tier): number {
  if (maxGap(dy, runway, tier) < 0) return -1 - gap;
  return maxGapRaw(dy, runway, tier) - gap;
}

function makeTransition(
  g: GridLike,
  s: Surface,
  t: Surface,
  kind: TransitionKind,
  gap: number,
  dy: number,
  takeoff: Point,
  landing: Point,
  runway: number,
  tier: Tier,
  blocked = false,
): Transition {
  let lethal = false;
  if (kind === "jump")
    for (let cx = s.x1 + 1; cx < t.x0; cx++)
      if (!hasSolidBelow(g, cx, Math.min(s.y, t.y))) {
        lethal = true;
        break;
      }
  const r = Math.min(FULL_RUNWAY, Math.max(0, runway));
  return {
    from: s.id,
    to: t.id,
    kind,
    gap,
    dy,
    takeoff,
    landing,
    runway: r,
    reachable: !blocked && canReach(gap, dy, r, tier),
    possible: !blocked && canReach(gap, dy, true, "ULTRA"),
    lethal,
    slack: blocked ? -1 - gap : slackAt(gap, dy, r, tier),
    slackGuaranteed: blocked ? -1 - gap : slackAt(gap, dy, r, "GUARANTEED"),
  };
}

function pickForward(s: Surface, cands: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  // 1. reachable, not lower: cheapest gap + |dy|, then smaller |dy|.
  for (const c of cands) {
    if (!c.possible || c.dy > 0) continue;
    if (
      !best ||
      c.gap + Math.abs(c.dy) < best.gap + Math.abs(best.dy) ||
      (c.gap + Math.abs(c.dy) === best.gap + Math.abs(best.dy) && Math.abs(c.dy) < Math.abs(best.dy))
    )
      best = c;
  }
  if (best) return best;
  // 2. reachable, lower: highest, then nearest.
  for (const c of cands) {
    if (!c.possible) continue;
    if (!best || c.dy < best.dy || (c.dy === best.dy && c.gap < best.gap)) best = c;
  }
  if (best) return best;
  // 3. nothing reachable: nearest.
  for (const c of cands) {
    if (
      !best ||
      c.gap < best.gap ||
      (c.gap === best.gap && Math.abs(c.dy) < Math.abs(best.dy)) ||
      (c.gap === best.gap && Math.abs(c.dy) === Math.abs(best.dy) && c.dy < best.dy)
    )
      best = c;
  }
  return best;
}

/** Surfaces and transitions for the rect. Deterministic and translation-invariant. */
export function buildSurfaceGraph(g: GridLike, r: Rect, tier: Tier = DESIGN_TIER): SurfaceGraph {
  const surfaces = findSurfaces(g, r);
  const transitions: Transition[] = [];
  const next = new Array<number>(surfaces.length).fill(-1);
  const incoming = new Array<number>(surfaces.length).fill(0);

  for (const s of surfaces) {
    const cands: Candidate[] = [];
    const walkOff = s.x1 + 1;
    const canWalkOff = walkOff < g.w && !isSolid(g, walkOff, s.y);
    for (const t of surfaces) {
      if (t === s) continue;
      const dy = t.y - s.y;
      if (t.x0 > s.x1) {
        const gap = t.x0 - s.x1 - 1;
        // A gap-0 target at the same height would be the same surface; a
        // gap-0 lower target needs the walk-off cell open.
        if (gap === 0 && dy > 0 && !canWalkOff) continue;
        const clear = gap === 0 || faceClear(g, s, t);
        cands.push({ t, gap, dy, landingX: t.x0, clear, possible: clear && canReach(gap, dy, true, "ULTRA") });
      } else if (dy > 0 && canWalkOff && t.x0 <= walkOff && walkOff <= t.x1) {
        // Walk off the end and fall onto a surface underneath.
        let clear = true;
        for (let y = s.y; y < t.y; y++)
          if (isSolid(g, walkOff, y)) {
            clear = false;
            break;
          }
        if (clear) cands.push({ t, gap: 0, dy, landingX: walkOff, clear: true, possible: true });
      }
    }
    const c = pickForward(s, cands);
    if (!c) continue;
    // Only transitions that happen inside the rect's columns.
    if (!inCols(r, s.x1) || !inCols(r, c.landingX)) continue;
    const kind: TransitionKind = c.gap > 0 ? "jump" : c.dy < 0 ? "step" : "drop";
    next[s.id] = transitions.length;
    incoming[c.t.id]++;
    transitions.push(
      makeTransition(g, s, c.t, kind, c.gap, c.dy, { x: s.x1, y: s.y }, { x: c.landingX, y: c.t.y }, s.width - 1, tier, !c.clear),
    );
  }

  // Climb transitions into surfaces nothing leads to.
  for (const t of surfaces) {
    if (incoming[t.id] > 0) continue;
    let below: Surface | null = null;
    for (const s of surfaces) {
      if (s.y <= t.y || s.x1 < t.x0 - 1 || s.x0 > t.x1 + 1) continue;
      if (!below || s.y < below.y) below = s;
    }
    if (!below) continue;
    const s = below;
    const dy = t.y - s.y;
    let takeoff: Point;
    let landing: Point;
    let runway: number;
    let blocked = false;
    if (s.x0 <= t.x0 - 1 && t.x0 - 1 <= s.x1) {
      takeoff = { x: t.x0 - 1, y: s.y };
      landing = { x: t.x0, y: t.y };
      runway = t.x0 - 1 - s.x0;
    } else if (s.x0 <= t.x1 + 1 && t.x1 + 1 <= s.x1) {
      takeoff = { x: t.x1 + 1, y: s.y };
      landing = { x: t.x1, y: t.y };
      runway = s.x1 - (t.x1 + 1);
    } else {
      // The platform covers the whole surface below: no side to jump from.
      takeoff = { x: Math.max(s.x0, t.x0), y: s.y };
      landing = { x: Math.max(s.x0, t.x0), y: t.y };
      runway = 0;
      blocked = true;
    }
    if (!inCols(r, takeoff.x) || !inCols(r, landing.x)) continue;
    if (!blocked)
      for (let y = t.y; y < s.y; y++)
        if (isSolid(g, takeoff.x, y)) {
          blocked = true;
          break;
        }
    transitions.push(makeTransition(g, s, t, "climb", 0, dy, takeoff, landing, runway, tier, blocked));
  }

  // Routes: maximal forward paths from surfaces with no forward incoming.
  const forwardIn = new Array<number>(surfaces.length).fill(0);
  for (const ti of next) if (ti >= 0) forwardIn[transitions[ti].to]++;
  const routes: number[][] = [];
  for (const s of surfaces) {
    if (forwardIn[s.id] > 0 || next[s.id] < 0) continue;
    const path: number[] = [];
    let cur = s.id;
    while (next[cur] >= 0) {
      const ti = next[cur];
      path.push(ti);
      cur = transitions[ti].to;
    }
    routes.push(path);
  }
  return { surfaces, transitions, next, routes };
}
