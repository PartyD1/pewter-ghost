/**
 * Rule-based reachability (G-07 rule check), ported from the audit's
 * audit-prototypes/generators/reachpy.py with the jump numbers taken from
 * @jump-tables instead of caps.json.
 *
 * The knight moves between STANDING cells (an empty cell with a solid tile
 * below). From a standing cell it can:
 *  - walk to the neighbouring standing cell, or step up one row;
 *  - walk off a ledge and fall straight down to the first surface below;
 *  - jump over `gap` empty columns onto a surface `dy` rows away when
 *    `gap <= maxGap(dy, runUp, tier)`, run-up = flat standing cells behind
 *    the takeoff (capped at FULL_RUNWAY), with headroom above the takeoff
 *    for rising jumps;
 *  - jump straight up onto a ledge within `maxRise` rows.
 *
 * It is a fast PRE-FILTER, not the verdict: it does not trace the arc through
 * ceilings (only a "no solid wall across the whole band" check), so a pit
 * under a low tunnel can pass the rules and still be impossible. The audit
 * measured 16 false "beatable" on 34 tunnel and wall cases; rules.test.ts
 * keeps one as a documented example. The physics agent (sim.ts) decides.
 */
import {
  arcSweep,
  DESIGN_TIER,
  FULL_RUNWAY,
  knightLimits,
  maxGap,
  TABLES,
  type Tier,
} from "@jump-tables";
import type { Point } from "../../../apps/editor/src/contracts";
import {
  goalColumns,
  goalPredicate,
  isPoint,
  makeSolid,
  settleStart,
  surfaces,
  type GoalSpec,
  type SolidGrid,
  type Surface,
  type XRange,
} from "./grid";

/**
 * How jumps are checked against solid cells between takeoff and landing:
 *  - "none": no check (reachpy's default; most permissive);
 *  - "passable": every column crossed must have at least one empty cell in
 *    the band the arc can occupy (reachpy's arc_min; still permissive, so
 *    it never rejects a jump the knight can make). Default.
 *  - "sweep": the design arc from @jump-tables (`arcSweep`) must be clear of
 *    solids. Strict: it rejects jumps that need a lower, cut arc.
 */
export type ArcCheck = "none" | "passable" | "sweep";

export interface RuleOptions {
  /** Jump tier for maxGap. Default the design tier (NORMAL). */
  tier?: Tier;
  /** Arc clearance rule. Default "passable". */
  arc?: ArcCheck;
  /** Only consider cells inside these columns (inclusive). */
  xRange?: XRange;
}

export type MoveKind = "walk" | "step" | "fall" | "jump" | "climb";

export interface RuleMove {
  to: Point;
  kind: MoveKind;
  /** Jumps: empty columns crossed, rows (to.y - from.y), run-up used. */
  gap?: number;
  dy?: number;
  runUp?: number;
}

export interface RuleReach {
  /** Settled start cell, or null when the start has nothing to stand on. */
  start: Point | null;
  /** Reachable standing cells as y * w + x. */
  reachable: Set<number>;
  /** cell index -> the cell index it was first reached from. */
  parent: Map<number, number>;
  /** cell index -> the move that first reached it. */
  via: Map<number, RuleMove>;
  w: number;
  has(p: Point): boolean;
  /** Reachable cells as points (unordered). */
  cells(): Point[];
  /** Standing-cell route from the start to `p` (inclusive), or [] if unreachable. */
  pathTo(p: Point): Point[];
}

/** Rule check verdict for a start and a goal. */
export interface RuleVerdict {
  ok: boolean;
  /** Standing-cell route (one point per move) when ok. */
  path: Point[];
  /** The goal cell reached, when ok. */
  reached?: Point;
  /** Surfaces (in the window) with no reachable cell. */
  unreachable: Surface[];
  /** Readable reason for the model, when not ok. */
  reason?: string;
  /** The reachable standing cell that got closest to the goal. */
  blockedAt?: Point;
  ms: number;
}

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

interface Ctx {
  grid: SolidGrid;
  w: number;
  h: number;
  tier: Tier;
  arc: ArcCheck;
  maxRise: number;
  lo: number;
  hi: number;
  solid: (x: number, y: number) => boolean;
  stand: (x: number, y: number) => boolean;
  /** Widest gap reachable onto any row, for any run-up (loop bound). */
  maxReach: number;
}

function makeCtx(grid: SolidGrid, o: RuleOptions): Ctx {
  const solid = makeSolid(grid);
  const lo = Math.max(0, o.xRange ? Math.min(o.xRange[0], o.xRange[1]) : 0);
  const hi = Math.min(grid.w - 1, o.xRange ? Math.max(o.xRange[0], o.xRange[1]) : grid.w - 1);
  const stand = (x: number, y: number) =>
    x >= lo && x <= hi && y >= 0 && y + 1 < grid.h && !solid(x, y) && solid(x, y + 1);
  const tier = o.tier ?? DESIGN_TIER;
  let maxReach = 0;
  for (let dy = TABLES.dyMin; dy <= TABLES.dyMax; dy++) maxReach = Math.max(maxReach, maxGap(dy, FULL_RUNWAY, tier));
  return {
    grid,
    w: grid.w,
    h: grid.h,
    tier,
    arc: o.arc ?? "passable",
    maxRise: knightLimits(tier).maxRise,
    lo,
    hi,
    solid,
    stand,
    maxReach,
  };
}

/** Flat standing cells behind (x, y), opposite to direction d, capped at FULL_RUNWAY. */
function runway(c: Ctx, x: number, y: number, d: number): number {
  let r = 0;
  while (r < FULL_RUNWAY && c.stand(x - d * (r + 1), y)) r++;
  return r;
}

/** Cells y-1 .. y-n above (x, y) are empty (rows above the level count as empty). */
function head(c: Ctx, x: number, y: number, n: number): boolean {
  for (let i = 1; i <= n; i++) if (y - i >= 0 && c.solid(x, y - i)) return false;
  return true;
}

/**
 * reachpy arc_passable: the body can be no higher than `maxRise` rows above
 * the lower of the two standing rows, so a column solid over that whole band
 * is a wall. The band reaches one row below the lower standing row because
 * TILE_BIAS lets a body up to 16 px under a ledge's top snap onto it.
 */
function arcPassable(c: Ctx, x: number, y: number, d: number, dx: number, ty: number): boolean {
  const top = Math.max(0, Math.min(y, ty) - c.maxRise);
  const bottom = Math.min(c.h - 1, Math.max(y, ty) + 1);
  for (let ix = 1; ix < dx; ix++) {
    const cx = x + d * ix;
    let open = false;
    for (let cy = top; cy <= bottom; cy++)
      if (!c.solid(cx, cy)) {
        open = true;
        break;
      }
    if (!open) return false;
  }
  return true;
}

/** The design arc's swept cells are all empty. */
function arcSweepClear(c: Ctx, x: number, y: number, d: number, gap: number, dy: number): boolean {
  const cells = arcSweep(d * gap, dy);
  if (cells.length === 0) return false;
  for (const p of cells) if (c.solid(x + p.x, y + p.y)) return false;
  return true;
}

function neighbours(c: Ctx, x: number, y: number): RuleMove[] {
  const out: RuleMove[] = [];
  for (const d of [1, -1]) {
    const nx = x + d;
    if (c.stand(nx, y)) out.push({ to: { x: nx, y }, kind: "walk" });
    if (c.stand(nx, y - 1) && !c.solid(x, y - 1)) out.push({ to: { x: nx, y: y - 1 }, kind: "step" });
    if (nx >= c.lo && nx <= c.hi && !c.solid(nx, y) && !c.stand(nx, y)) {
      for (let fy = y + 1; fy < c.h; fy++) {
        if (c.solid(nx, fy)) break;
        if (c.stand(nx, fy)) {
          out.push({ to: { x: nx, y: fy }, kind: "fall" });
          break;
        }
      }
    }
    const r = runway(c, x, y, d);
    for (let dx = 2; dx <= c.maxReach + 1; dx++) {
      const tx = x + d * dx;
      if (tx < c.lo || tx > c.hi) break;
      const gap = dx - 1;
      for (let ty = 0; ty + 1 < c.h; ty++) {
        if (!c.stand(tx, ty)) continue;
        const dy = ty - y;
        const rise = -dy;
        if (gap > maxGap(dy, r, c.tier)) continue;
        if (rise > 0 && !head(c, x, y, rise + 1)) continue;
        if (c.arc === "passable" && !arcPassable(c, x, y, d, dx, ty)) continue;
        if (c.arc === "sweep" && !arcSweepClear(c, x, y, d, gap, dy)) continue;
        out.push({ to: { x: tx, y: ty }, kind: "jump", gap, dy, runUp: r });
      }
    }
  }
  for (let rise = 2; rise <= c.maxRise; rise++)
    for (const tx of [x, x - 1, x + 1])
      if (c.stand(tx, y - rise) && head(c, x, y, rise + 1))
        out.push({ to: { x: tx, y: y - rise }, kind: "climb", dy: -rise, runUp: 0 });
  return out;
}

/** Every standing cell the rules can reach from `from` (settled onto the surface below). */
export function reachability(grid: SolidGrid, from: Point, opts: RuleOptions = {}): RuleReach {
  const c = makeCtx(grid, opts);
  const w = grid.w;
  const start = settleStart(grid, from);
  const reachable = new Set<number>();
  const parent = new Map<number, number>();
  const via = new Map<number, RuleMove>();
  if (start && c.stand(start.x, start.y)) {
    const s0 = start.y * w + start.x;
    reachable.add(s0);
    // Breadth-first so pathTo gives few moves.
    const queue: number[] = [s0];
    for (let qi = 0; qi < queue.length; qi++) {
      const ci = queue[qi];
      const cx = ci % w;
      const cy = (ci - cx) / w;
      for (const m of neighbours(c, cx, cy)) {
        const ni = m.to.y * w + m.to.x;
        if (reachable.has(ni)) continue;
        reachable.add(ni);
        parent.set(ni, ci);
        via.set(ni, m);
        queue.push(ni);
      }
    }
  }
  return {
    start: start && c.stand(start.x, start.y) ? start : null,
    reachable,
    parent,
    via,
    w,
    has: (p) => reachable.has(p.y * w + p.x),
    cells: () => [...reachable].map((i) => ({ x: i % w, y: Math.floor(i / w) })),
    pathTo(p: Point): Point[] {
      let i = p.y * w + p.x;
      if (!reachable.has(i)) return [];
      const out: Point[] = [];
      for (;;) {
        out.push({ x: i % w, y: Math.floor(i / w) });
        const pi = parent.get(i);
        if (pi === undefined) break;
        i = pi;
      }
      return out.reverse();
    },
  };
}

/** Surfaces (in the window) none of whose cells are reachable from `from`. */
export function unreachableSurfaces(grid: SolidGrid, from: Point, opts: RuleOptions = {}): Surface[] {
  const r = reachability(grid, from, opts);
  return surfacesNotIn(grid, r, opts.xRange);
}

function surfacesNotIn(grid: SolidGrid, r: RuleReach, xRange?: XRange): Surface[] {
  const out: Surface[] = [];
  for (const s of surfaces(grid, xRange)) {
    let any = false;
    for (let x = s.x0; x <= s.x1 && !any; x++) if (r.reachable.has(s.y * grid.w + x)) any = true;
    if (!any) out.push(s);
  }
  return out;
}

/** Can the rules get the knight from `from` to `to`? */
export function reachable(grid: SolidGrid, from: Point, to: GoalSpec, opts: RuleOptions = {}): boolean {
  return checkRules(grid, from, to, opts).ok;
}

/**
 * Full rule check: verdict, route, unreachable surfaces and a reason the
 * model can act on ("blocked at (12,8): the next surface (22,8) is 9 empty
 * tiles away at the same height; the knight clears 8 with a 3-tile run-up").
 */
export function checkRules(grid: SolidGrid, from: Point, to: GoalSpec, opts: RuleOptions = {}): RuleVerdict {
  const t0 = now();
  const r = reachability(grid, from, opts);
  const isGoal = goalPredicate(to);
  const unreachable = surfacesNotIn(grid, r, opts.xRange);
  if (!r.start) {
    return {
      ok: false,
      path: [],
      unreachable,
      reason: `the start (${from.x},${from.y}) has no ground to stand on`,
      ms: now() - t0,
    };
  }
  // Prefer the goal cell with the shortest route.
  let best: Point | null = null;
  let bestLen = Infinity;
  for (const p of r.cells()) {
    if (!isGoal(p.x, p.y)) continue;
    const len = r.pathTo(p).length;
    if (len < bestLen) {
      bestLen = len;
      best = p;
    }
  }
  if (best) return { ok: true, path: r.pathTo(best), reached: best, unreachable, ms: now() - t0 };
  const { reason, blockedAt } = explain(grid, r, to, opts);
  return { ok: false, path: [], unreachable, reason, blockedAt, ms: now() - t0 };
}

/** Find the furthest reachable cell toward the goal and describe the next jump it cannot make. */
function explain(
  grid: SolidGrid,
  r: RuleReach,
  to: GoalSpec,
  opts: RuleOptions,
): { reason: string; blockedAt?: Point } {
  const c = makeCtx(grid, opts);
  const cols = goalColumns(to);
  const cells = r.cells();
  if (!cols || cells.length === 0) return { reason: "the goal is not reachable by the jump rules" };
  const target = Number.isFinite(cols[0]) ? cols[0] : r.start!.x;
  const dir = target >= r.start!.x ? 1 : -1;
  // Furthest reachable cell in the goal's direction (ties: highest).
  let f = cells[0];
  for (const p of cells) if ((p.x - f.x) * dir > 0 || (p.x === f.x && p.y < f.y)) f = p;
  if (isPoint(to) && f.x === to.x) {
    const rise = f.y - to.y;
    return {
      blockedAt: f,
      reason:
        rise > 0
          ? `blocked at (${f.x},${f.y}): the goal (${to.x},${to.y}) is ${rise} tiles higher in the same column; the knight climbs at most ${c.maxRise}`
          : `blocked at (${f.x},${f.y}): the goal (${to.x},${to.y}) cannot be reached by the jump rules`,
    };
  }
  // Next surface beyond the frontier in that direction.
  let next: Surface | null = null;
  let nextX = 0;
  for (const s of surfaces(grid, opts.xRange)) {
    const x = dir > 0 ? s.x0 : s.x1;
    if ((x - f.x) * dir <= 0) continue;
    if (r.reachable.has(s.y * grid.w + x)) continue;
    const better =
      !next || (x - nextX) * dir < 0 || (x === nextX && Math.abs(s.y - f.y) < Math.abs(next.y - f.y));
    if (better) {
      next = s;
      nextX = x;
    }
  }
  if (!next) {
    return {
      blockedAt: f,
      reason: `blocked at (${f.x},${f.y}): there is nothing to land on ${dir > 0 ? "right" : "left"} of column ${f.x}`,
    };
  }
  const gap = Math.abs(nextX - f.x) - 1;
  const dy = next.y - f.y;
  const run = runway(c, f.x, f.y, dir);
  const allowed = maxGap(dy, run, c.tier);
  const height = dy === 0 ? "at the same height" : dy < 0 ? `${-dy} higher` : `${dy} lower`;
  let why: string;
  if (allowed < 0) why = `the knight climbs at most ${c.maxRise}`;
  else if (gap > allowed)
    why = `the knight clears ${allowed} with a ${run}-tile run-up${run < FULL_RUNWAY ? ` (${maxGap(dy, FULL_RUNWAY, c.tier)} with a full run-up)` : ""}`;
  else if (dy < 0 && !head(c, f.x, f.y, -dy + 1)) why = "a ceiling over the takeoff blocks the jump";
  else why = "a wall or ceiling between them blocks the arc";
  return {
    blockedAt: f,
    reason: `blocked at (${f.x},${f.y}): the next surface (${nextX},${next.y}) is ${gap} empty tile${gap === 1 ? "" : "s"} away, ${height}; ${why}`,
  };
}
