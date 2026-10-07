/**
 * Coin classification (G-26) and the pattern-tag detectors.
 *
 * Every detector is a plain rule over the surface graph, the grid and the
 * entities, so a tag can be explained in one sentence (the brief's pattern
 * catalogue uses the same sentences):
 *
 *  staircase          >= 3 one- or two-tile steps in one direction, no gaps
 *  gap-run            >= 3 jumps over gaps in a row, height change <= 1 each
 *  pillar-hop         >= 2 narrow (<= 2 wide) pillar tops hopped in a row
 *  rising-steps       >= 3 jumps over gaps in a row, each landing higher
 *  coin-arc           >= 3 coins on one jump's arc (jump-tables sweep), or
 *                     >= 3 airborne coins in adjacent columns peaking in the middle
 *  coin-row-on-floor  >= 3 coins in adjacent columns lying on a floor
 *  coin-ladder        >= 3 coins stacked in one column
 *  risky-coin         a coin with nothing solid below it (over a pit)
 *  guarded-reward     a coin or fruit with an enemy within 3 tiles
 *  rest               >= 4 columns of flat, enemy-free ground with headroom >= 2
 *  enemy-gate         an enemy on a surface the route must cross that is
 *                     narrow (<= 5) or low-ceilinged, or any enemy in a tunnel
 *  wall               a solid face >= 3 tiles tall beside a standing cell
 *  pit                a jump over a gap with nothing below, or columns with no
 *                     solid tile at all between solid columns
 *  tunnel             >= 4 columns of standing cells under a ceiling <= 3 up
 */
import type { Point } from "../../../apps/editor/src/contracts";
import { ENEMY_KINDS, COLLECTABLE_KINDS } from "../../../apps/editor/src/contracts";
import { arcSweep } from "@jump-tables";
import { MEASURE, PATTERN_TAGS, type PatternTag } from "./constants";
import {
  chebyshev,
  hasSolidBelow,
  headroom,
  inRect,
  isSolid,
  isStanding,
  type EntityLike,
  type GridLike,
  type Rect,
} from "./grid";
import type { Surface, SurfaceGraph, Transition } from "./surfaces";

export interface PatternHit {
  tag: PatternTag;
  /** Inclusive tile extent of the matched structure. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface CoinClasses {
  /** Coins (kind "coin") inside the rect, in (x, y) order. */
  coins: EntityLike[];
  /** Indices into `coins` lying on a floor (a standing cell). */
  onFloor: Set<number>;
  /** Indices into `coins` on a jump arc (not on a floor). */
  onArc: Set<number>;
  /** Transition index -> coin indices on that transition's arc. */
  byTransition: Map<number, number[]>;
  /** Shape-detected arcs (coin index groups) not tied to a transition. */
  shapeArcs: number[][];
}

const key = (x: number, y: number) => `${x},${y}`;

const byXY = (a: EntityLike, b: EntityLike) => a.x - b.x || a.y - b.y;

/** Cells (absolute) swept by the knight's body on a transition's arc, both directions. */
export function transitionSweep(t: Transition): Point[] {
  if (t.kind !== "jump" || !t.possible) return [];
  const out: Point[] = [];
  for (const o of arcSweep(t.gap, t.dy)) out.push({ x: t.takeoff.x + o.x, y: t.takeoff.y + o.y });
  // The same jump made right-to-left, from the target's near edge.
  for (const o of arcSweep(-t.gap, -t.dy)) out.push({ x: t.landing.x + o.x, y: t.landing.y + o.y });
  return out;
}

/**
 * Coins on floors vs on arcs (G-26). A coin is on the floor when it sits in
 * a standing cell (the knight is under one tile tall, so it walks through it).
 * Otherwise it is on an arc when the knight's body sweeps its cell on the
 * jump between two surfaces (jump-tables `arcSweep`, either direction), or
 * when it belongs to an arc-shaped group of airborne coins (a hop arc drawn
 * over flat ground).
 */
export function classifyCoins(
  g: GridLike,
  graph: SurfaceGraph,
  entities: readonly EntityLike[],
  r: Rect,
): CoinClasses {
  const coins = entities.filter((e) => e.kind === "coin" && inRect(r, e.x, e.y)).sort(byXY);
  const onFloor = new Set<number>();
  const onArc = new Set<number>();
  const byTransition = new Map<number, number[]>();
  const idx = new Map<string, number>();
  coins.forEach((c, i) => {
    idx.set(key(c.x, c.y), i);
    if (isStanding(g, c.x, c.y)) onFloor.add(i);
  });

  graph.transitions.forEach((t, ti) => {
    const hit = new Set<number>();
    for (const p of transitionSweep(t)) {
      const i = idx.get(key(p.x, p.y));
      if (i !== undefined && !onFloor.has(i)) hit.add(i);
    }
    if (hit.size) {
      byTransition.set(ti, [...hit].sort((a, b) => a - b));
      for (const i of hit) onArc.add(i);
    }
  });

  // Shape arcs: one airborne coin per column over adjacent columns, apex inside.
  const cols = new Map<number, number[]>();
  coins.forEach((c, i) => {
    if (onFloor.has(i)) return;
    const l = cols.get(c.x) ?? [];
    l.push(i);
    cols.set(c.x, l);
  });
  const xs = [...cols.keys()].sort((a, b) => a - b);
  const shapeArcs: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= MEASURE.coinGroupMin) {
      const ys = run.map((i) => coins[i].y);
      const apex = Math.min(...ys);
      const ai = ys.indexOf(apex);
      let ok = apex < ys[0] && apex < ys[ys.length - 1];
      for (let k = 1; ok && k <= ai; k++) if (ys[k] > ys[k - 1]) ok = false;
      for (let k = ai + 1; ok && k < ys.length; k++) if (ys[k] < ys[k - 1]) ok = false;
      for (let k = 1; ok && k < ys.length; k++) if (Math.abs(ys[k] - ys[k - 1]) > 3) ok = false;
      if (ok) {
        shapeArcs.push([...run]);
        for (const i of run) onArc.add(i);
      }
    }
    run = [];
  };
  for (let k = 0; k < xs.length; k++) {
    const list = cols.get(xs[k])!;
    if (list.length !== 1 || (k > 0 && xs[k] !== xs[k - 1] + 1)) flush();
    if (list.length === 1) run.push(list[0]);
  }
  flush();
  return { coins, onFloor, onArc, byTransition, shapeArcs };
}

function hitOf(tag: PatternTag, pts: Point[]): PatternHit {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { tag, x0, x1, y0, y1 };
}

const ends = (ts: Transition[]): Point[] => ts.flatMap((t) => [t.takeoff, t.landing]);

/** Maximal runs inside a route whose transitions satisfy `ok` and `pair`. */
function runs(
  route: Transition[],
  ok: (t: Transition) => boolean,
  pair: (a: Transition, b: Transition) => boolean = () => true,
): Transition[][] {
  const out: Transition[][] = [];
  let cur: Transition[] = [];
  for (const t of route) {
    if (ok(t) && (cur.length === 0 || pair(cur[cur.length - 1], t))) cur.push(t);
    else {
      if (cur.length) out.push(cur);
      cur = ok(t) ? [t] : [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const isPillar = (s: Surface) => s.width <= MEASURE.pillarMaxWidth && s.depth >= MEASURE.pillarMinDepth;

export interface PatternInput {
  g: GridLike;
  r: Rect;
  graph: SurfaceGraph;
  entities: readonly EntityLike[];
  coins: CoinClasses;
}

/** Run every detector. Hits are de-duplicated and sorted (catalogue order, then position). */
export function detectPatterns({ g, r, graph, entities, coins }: PatternInput): PatternHit[] {
  const hits: PatternHit[] = [];
  const { surfaces, transitions } = graph;
  const routes = graph.routes.map((p) => p.map((i) => transitions[i]));
  const inside = entities.filter((e) => inRect(r, e.x, e.y));
  const enemies = inside.filter((e) => ENEMY_KINDS.has(e.kind));
  const rewards = inside.filter((e) => COLLECTABLE_KINDS.has(e.kind));
  const colIn = (x: number) => x >= r.x && x < r.x + r.w;

  for (const route of routes) {
    // staircase
    for (const run of runs(
      route,
      (t) => t.gap === 0 && t.kind !== "climb" && Math.abs(t.dy) >= 1 && Math.abs(t.dy) <= MEASURE.staircaseMaxStep,
      (a, b) => Math.sign(a.dy) === Math.sign(b.dy),
    ))
      if (run.length >= MEASURE.staircaseMinSteps) hits.push(hitOf("staircase", ends(run)));
    // gap-run
    for (const run of runs(route, (t) => t.kind === "jump" && Math.abs(t.dy) <= MEASURE.gapRunMaxDy))
      if (run.length >= MEASURE.gapRunMin) hits.push(hitOf("gap-run", ends(run)));
    // rising-steps
    for (const run of runs(route, (t) => t.kind === "jump" && t.dy < 0))
      if (run.length >= MEASURE.risingStepsMin) hits.push(hitOf("rising-steps", ends(run)));
    // pillar-hop: consecutive jumps whose targets are pillars.
    for (const run of runs(route, (t) => t.kind === "jump" && isPillar(surfaces[t.to]))) {
      if (run.length < MEASURE.pillarHopMin) continue;
      const pts = ends(run);
      const last = surfaces[run[run.length - 1].to];
      pts.push({ x: last.x1, y: last.y });
      hits.push(hitOf("pillar-hop", pts));
    }
  }

  // coin-arc
  for (const list of coins.byTransition.values())
    if (list.length >= MEASURE.coinGroupMin) hits.push(hitOf("coin-arc", list.map((i) => coins.coins[i])));
  for (const list of coins.shapeArcs) hits.push(hitOf("coin-arc", list.map((i) => coins.coins[i])));

  // coin-row-on-floor
  {
    const floor = [...coins.onFloor].map((i) => coins.coins[i]).sort((a, b) => a.y - b.y || a.x - b.x);
    let cur: EntityLike[] = [];
    const flush = () => {
      if (cur.length >= MEASURE.coinGroupMin) hits.push(hitOf("coin-row-on-floor", cur));
      cur = [];
    };
    for (const c of floor) {
      const prev = cur[cur.length - 1];
      if (prev && !(prev.y === c.y && c.x === prev.x + 1)) flush();
      cur.push(c);
    }
    flush();
  }

  // coin-ladder
  {
    const col = [...coins.coins].sort((a, b) => a.x - b.x || a.y - b.y);
    let cur: EntityLike[] = [];
    const flush = () => {
      if (cur.length >= MEASURE.coinGroupMin) hits.push(hitOf("coin-ladder", cur));
      cur = [];
    };
    for (const c of col) {
      const prev = cur[cur.length - 1];
      if (prev && !(prev.x === c.x && c.y === prev.y + 1)) flush();
      cur.push(c);
    }
    flush();
  }

  // risky-coin
  for (const c of coins.coins) if (!hasSolidBelow(g, c.x, c.y)) hits.push(hitOf("risky-coin", [c]));

  // guarded-reward
  for (const c of rewards)
    for (const e of enemies)
      if (chebyshev(c, e) <= MEASURE.nearTiles) {
        hits.push(hitOf("guarded-reward", [c, e]));
        break;
      }

  // rest, tunnel (per surface, column runs clipped to the rect)
  for (const s of surfaces) {
    const occupied = enemies.some((e) => e.y === s.y && e.x >= s.x0 && e.x <= s.x1);
    let restRun: number[] = [];
    let tunnelRun: number[] = [];
    const flushRest = () => {
      if (!occupied && restRun.length >= MEASURE.restMinWidth)
        hits.push({ tag: "rest", x0: restRun[0], x1: restRun[restRun.length - 1], y0: s.y, y1: s.y });
      restRun = [];
    };
    const flushTunnel = () => {
      if (tunnelRun.length >= MEASURE.tunnelMinLength)
        hits.push({
          tag: "tunnel",
          x0: tunnelRun[0],
          x1: tunnelRun[tunnelRun.length - 1],
          y0: s.y - MEASURE.tunnelMaxHeadroom,
          y1: s.y,
        });
      tunnelRun = [];
    };
    for (let x = Math.max(s.x0, r.x); x <= Math.min(s.x1, r.x + r.w - 1); x++) {
      const hr = headroom(g, x, s.y);
      if (hr >= MEASURE.restMinHeadroom) restRun.push(x);
      else flushRest();
      if (hr >= 1 && hr <= MEASURE.tunnelMaxHeadroom) tunnelRun.push(x);
      else flushTunnel();
    }
    flushRest();
    flushTunnel();
  }

  // wall: a face >= wallMinHeight tall beside a standing cell.
  for (const s of surfaces) {
    for (const [fx, sx] of [
      [s.x1 + 1, s.x1],
      [s.x0 - 1, s.x0],
    ] as const) {
      if (!colIn(fx) || !colIn(sx)) continue;
      let h = 0;
      while (h < 64 && isSolid(g, fx, s.y - h)) h++;
      if (h >= MEASURE.wallMinHeight) hits.push({ tag: "wall", x0: fx, x1: fx, y0: s.y - h + 1, y1: s.y });
    }
  }

  // pit: lethal gaps, and bare columns between solid columns.
  for (const t of transitions)
    if (t.kind === "jump" && t.lethal)
      hits.push({ tag: "pit", x0: t.takeoff.x + 1, x1: t.landing.x - 1, y0: Math.min(t.takeoff.y, t.landing.y), y1: g.h - 1 });
  {
    const bare = (x: number) => !hasSolidBelow(g, x, r.y - 1);
    let x = r.x;
    while (x < r.x + r.w) {
      if (!bare(x)) {
        x++;
        continue;
      }
      const x0 = x;
      while (x + 1 < r.x + r.w && bare(x + 1)) x++;
      const x1 = x;
      x++;
      const covered = hits.some((h) => h.tag === "pit" && h.x0 === x0 && h.x1 === x1);
      if (!covered && x0 > r.x && x1 < r.x + r.w - 1) hits.push({ tag: "pit", x0, x1, y0: r.y, y1: g.h - 1 });
    }
  }

  // enemy-gate
  {
    const anyIn = new Set<number>();
    for (const t of transitions) anyIn.add(t.to);
    for (const e of enemies) {
      const s = surfaces.find((s) => s.y === e.y && e.x >= s.x0 && e.x <= s.x1);
      const hr = headroom(g, e.x, e.y);
      const lowCeiling = hr <= MEASURE.tunnelMaxHeadroom;
      let gate = lowCeiling && !!s;
      if (!gate && s) {
        const crossed = anyIn.has(s.id) && graph.next[s.id] >= 0;
        gate = crossed && s.width <= MEASURE.enemyGateMaxWidth;
      }
      if (gate) hits.push({ tag: "enemy-gate", x0: s ? s.x0 : e.x, x1: s ? s.x1 : e.x, y0: e.y, y1: e.y });
    }
  }

  // De-duplicate and sort.
  const order = new Map<string, number>(PATTERN_TAGS.map((t, i) => [t, i]));
  const seen = new Set<string>();
  const out: PatternHit[] = [];
  for (const h of hits) {
    const k = `${h.tag}|${h.x0}|${h.x1}|${h.y0}|${h.y1}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  out.sort((a, b) => order.get(a.tag)! - order.get(b.tag)! || a.x0 - b.x0 || a.y0 - b.y0 || a.x1 - b.x1 || a.y1 - b.y1);
  return out;
}

/** Unique tags in catalogue order. */
export function tagsOf(hits: readonly PatternHit[]): PatternTag[] {
  const set = new Set(hits.map((h) => h.tag));
  return PATTERN_TAGS.filter((t) => set.has(t));
}
