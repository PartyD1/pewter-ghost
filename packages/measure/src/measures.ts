/**
 * Window measurements: grid (+ entities) + rect -> numbers.
 *
 * Definitions (plan, "Measurements"; the brief and the validator quote these):
 *
 *  density        solid tiles / cells in the rect.
 *  gapHist        widths of the gaps jumped (kind "jump") as a fraction of the
 *                 knight's running limit (maxGapRun), shares in 5 bins
 *                 [0,.2) [.2,.4) [.4,.6) [.6,.8) [.8,inf). All zero if no gaps.
 *  riseHist       rises (dy < 0) as a fraction of maxRise, same bins.
 *  verticality    sum|dy| / (sum|dy| + sum(gap + 1)) over transitions: the
 *                 share of the route's movement that is vertical. 0 = flat.
 *  linearity      1 - min(1, RMS residual / 4 tiles) of a least-squares line
 *                 through every standing cell's height (one point per column
 *                 of each surface). 1 = one straight line (floor or ramp).
 *  leniency       share of jumps (not drops) a mistimed jump still survives:
 *                 reachable at the design tier and either not over a pit, or
 *                 with >= 1 tile of GUARANTEED-tier slack onto a landing wider
 *                 than 2. 1 when there are no jumps. This approximates "slack
 *                 in the agent's search" (G-22) with the slack in the reach
 *                 tables, which come from the same solver; the physics agent
 *                 is not run here.
 *  meanSlack      mean design-tier slack (reach - gap) / maxGapRun, in [-1, 1].
 *  rewardSpacing  mean distance (tiles) between consecutive collectables in x
 *                 order; 0 with fewer than two.
 *  coinsOnArcShare / coinsOnFloorShare  (G-26) share of coins on a jump arc
 *                 (patterns.classifyCoins) / lying on a floor. 0 with no coins.
 *  pressure       enemies within 3 tiles (Chebyshev) of any landing, divided by
 *                 the number of landings (every transition lands once). 0 when
 *                 there are no landings.
 *  difficulty     weighted sum of DIFFICULTY_WEIGHTS components, in [0, 1].
 *  patterns       detected pattern tags in catalogue order.
 *
 * Everything is relative to the rect, so moving content and rect together
 * leaves every number unchanged (tested as a property).
 */
import {
  ENEMY_KINDS,
  COLLECTABLE_KINDS,
  SOLID_TILES,
  type KnightLimits,
  type MeasuredNumbers,
} from "../../../apps/editor/src/contracts";
import { DESIGN_TIER, knightLimits, type Tier } from "@jump-tables";
import {
  DIFFICULTY_WEIGHTS,
  HIST_BINS,
  MEASURE,
  SCREEN_COLS,
  type DifficultyPart,
  type PatternTag,
} from "./constants";
import { chebyshev, clipRect, inRect, type EntityLike, type GridLike, type Rect } from "./grid";
import { buildSurfaceGraph, type SurfaceGraph, type Transition } from "./surfaces";
import { classifyCoins, detectPatterns, tagsOf, type CoinClasses, type PatternHit } from "./patterns";

export interface MeasureOptions {
  /** Timing tier for reach and limits. Default: the design tier (NORMAL). */
  tier?: Tier;
}

/** Every number for one rect. Plain data (JSON-safe). */
export interface WindowMeasures {
  density: number;
  gapHist: number[];
  riseHist: number[];
  verticality: number;
  linearity: number;
  leniency: number;
  meanSlack: number;
  rewardSpacing: number;
  coinsOnArcShare: number;
  coinsOnFloorShare: number;
  pressure: number;
  difficulty: number;
  difficultyParts: Record<DifficultyPart, number>;
  patterns: PatternTag[];
  /** Mean width of the surfaces landed on by jumps (0 if none). */
  meanLandingWidth: number;
  counts: {
    cells: number;
    solids: number;
    surfaces: number;
    transitions: number;
    /** Transitions other than drops. */
    jumps: number;
    /** Jumps over a gap (kind "jump"). */
    gaps: number;
    /** Transitions not clearable at the design tier. */
    unreachable: number;
    lethal: number;
    coins: number;
    collectables: number;
    enemies: number;
  };
}

/** WindowMeasures plus the structures they were computed from (positions are absolute). */
export interface WindowAnalysis extends WindowMeasures {
  rect: Rect;
  tier: Tier;
  limits: KnightLimits;
  graph: SurfaceGraph;
  coins: CoinClasses;
  hits: PatternHit[];
}

const round = (v: number, d = 4) => {
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/** Shares in HIST_BINS bins of width 0.2 (last bin open). All zero for no values. */
export function histogram(fractions: readonly number[]): number[] {
  const bins = new Array<number>(HIST_BINS).fill(0);
  for (const f of fractions) bins[clamp(Math.floor(f / 0.2 + 1e-9), 0, HIST_BINS - 1)]++;
  const n = fractions.length;
  return bins.map((b) => (n ? round(b / n) : 0));
}

/** 1 - min(1, rms / scale) of the least-squares line through the points. */
export function linearityOf(points: readonly { x: number; y: number }[]): number {
  if (points.length < 2) return 1;
  const n = points.length;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let sxx = 0,
    sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  let ss = 0;
  for (const p of points) ss += (p.y - (my + b * (p.x - mx))) ** 2;
  const rms = Math.sqrt(ss / n);
  return 1 - Math.min(1, rms / MEASURE.linearityScale);
}

function isLenient(t: Transition, targetWidth: number): boolean {
  if (!t.reachable) return false;
  if (!t.lethal) return true;
  return t.slackGuaranteed >= MEASURE.lenientSlackTiles && targetWidth > MEASURE.narrowWidth;
}

/** Full analysis of one rect (clipped to the grid). */
export function analyzeWindow(
  g: GridLike,
  entities: readonly EntityLike[],
  rect: Rect,
  opts: MeasureOptions = {},
): WindowAnalysis {
  const tier = opts.tier ?? DESIGN_TIER;
  const limits = knightLimits(tier);
  const r = clipRect(g, rect);
  const cells = r.w * r.h;

  let solids = 0;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) if (SOLID_TILES.has(g.cells[y * g.w + x])) solids++;

  const graph = buildSurfaceGraph(g, r, tier);
  const { surfaces, transitions } = graph;
  const inside = entities.filter((e) => inRect(r, e.x, e.y));
  const enemies = inside.filter((e) => ENEMY_KINDS.has(e.kind));
  const collectables = inside.filter((e) => COLLECTABLE_KINDS.has(e.kind)).sort((a, b) => a.x - b.x || a.y - b.y);

  const jumps = transitions.filter((t) => t.kind !== "drop");
  const gaps = transitions.filter((t) => t.kind === "jump");
  const rises = transitions.filter((t) => t.dy < 0);

  const gapFr = gaps.map((t) => t.gap / limits.maxGapRun);
  const riseFr = rises.map((t) => -t.dy / limits.maxRise);

  let sumDy = 0,
    sumDx = 0;
  for (const t of transitions) {
    sumDy += Math.abs(t.dy);
    sumDx += t.gap + 1;
  }
  const verticality = sumDy + sumDx > 0 ? sumDy / (sumDy + sumDx) : 0;

  const pts: { x: number; y: number }[] = [];
  for (const s of surfaces)
    for (let x = Math.max(s.x0, r.x); x <= Math.min(s.x1, r.x + r.w - 1); x++) pts.push({ x: x - r.x, y: s.y - r.y });
  const linearity = linearityOf(pts);

  const leniency = jumps.length
    ? jumps.filter((t) => isLenient(t, surfaces[t.to].width)).length / jumps.length
    : 1;
  const meanSlack = jumps.length ? mean(jumps.map((t) => clamp(t.slack / limits.maxGapRun, -1, 1))) : 0;

  let spacing = 0;
  for (let i = 1; i < collectables.length; i++)
    spacing += Math.hypot(collectables[i].x - collectables[i - 1].x, collectables[i].y - collectables[i - 1].y);
  const rewardSpacing = collectables.length >= 2 ? spacing / (collectables.length - 1) : 0;

  const coins = classifyCoins(g, graph, entities, r);
  const nCoins = coins.coins.length;

  const near = enemies.filter((e) => transitions.some((t) => chebyshev(e, t.landing) <= MEASURE.nearTiles));
  const pressure = transitions.length ? near.length / transitions.length : 0;

  const landingWidths = jumps.map((t) => surfaces[t.to].width);
  const screens = r.w / SCREEN_COLS;
  const parts: Record<DifficultyPart, number> = {
    gapRatio: mean(gapFr.map((f) => Math.min(1, f))),
    maxGapRatio: gapFr.length ? Math.min(1, Math.max(...gapFr)) : 0,
    rise: mean(riseFr.map((f) => Math.min(1, f))),
    pressure: Math.min(1, pressure),
    narrow: jumps.length ? landingWidths.filter((w) => w <= MEASURE.narrowWidth).length / jumps.length : 0,
    lethal: jumps.length ? jumps.filter((t) => t.lethal).length / jumps.length : 0,
    unforgiving: 1 - leniency,
    obstacleRate: screens > 0 ? Math.min(1, jumps.length / screens / MEASURE.obstaclesPerScreenFull) : 0,
  };
  let difficulty = 0;
  for (const k of Object.keys(DIFFICULTY_WEIGHTS) as DifficultyPart[]) difficulty += DIFFICULTY_WEIGHTS[k] * parts[k];
  for (const k of Object.keys(parts) as DifficultyPart[]) parts[k] = round(parts[k]);

  const hits = detectPatterns({ g, r, graph, entities, coins });

  return {
    rect: r,
    tier,
    limits,
    graph,
    coins,
    hits,
    density: cells ? round(solids / cells) : 0,
    gapHist: histogram(gapFr),
    riseHist: histogram(riseFr),
    verticality: round(verticality),
    linearity: round(linearity),
    leniency: round(leniency),
    meanSlack: round(meanSlack),
    rewardSpacing: round(rewardSpacing),
    coinsOnArcShare: nCoins ? round(coins.onArc.size / nCoins) : 0,
    coinsOnFloorShare: nCoins ? round(coins.onFloor.size / nCoins) : 0,
    pressure: round(pressure),
    difficulty: round(clamp(difficulty, 0, 1)),
    difficultyParts: parts,
    patterns: tagsOf(hits),
    meanLandingWidth: round(mean(landingWidths)),
    counts: {
      cells,
      solids,
      surfaces: surfaces.length,
      transitions: transitions.length,
      jumps: jumps.length,
      gaps: gaps.length,
      unreachable: transitions.filter((t) => !t.reachable).length,
      lethal: transitions.filter((t) => t.lethal).length,
      coins: nCoins,
      collectables: collectables.length,
      enemies: enemies.length,
    },
  };
}

/** Strip an analysis down to its plain numbers. */
export function measuresOf(a: WindowAnalysis): WindowMeasures {
  return {
    density: a.density,
    gapHist: [...a.gapHist],
    riseHist: [...a.riseHist],
    verticality: a.verticality,
    linearity: a.linearity,
    leniency: a.leniency,
    meanSlack: a.meanSlack,
    rewardSpacing: a.rewardSpacing,
    coinsOnArcShare: a.coinsOnArcShare,
    coinsOnFloorShare: a.coinsOnFloorShare,
    pressure: a.pressure,
    difficulty: a.difficulty,
    difficultyParts: { ...a.difficultyParts },
    patterns: [...a.patterns],
    meanLandingWidth: a.meanLandingWidth,
    counts: { ...a.counts },
  };
}

/** The contract's MeasuredNumbers (exactly its fields) from any measures. */
export function toMeasuredNumbers(m: WindowMeasures): MeasuredNumbers {
  return {
    density: m.density,
    gapHist: [...m.gapHist],
    verticality: m.verticality,
    rewardSpacing: m.rewardSpacing,
    pressure: m.pressure,
    difficulty: m.difficulty,
    patterns: [...m.patterns],
  };
}

/** Plain numbers for a rect. */
export function measureWindowFull(
  g: GridLike,
  entities: readonly EntityLike[],
  rect: Rect,
  opts?: MeasureOptions,
): WindowMeasures {
  return measuresOf(analyzeWindow(g, entities, rect, opts));
}

/**
 * The FillRequest's `measured` block for a rect: exactly the contract's
 * MeasuredNumbers fields, so the request hash only moves when they do.
 */
export function measureWindow(
  g: GridLike,
  entities: readonly EntityLike[],
  rect: Rect,
  opts?: MeasureOptions,
): MeasuredNumbers {
  return toMeasuredNumbers(analyzeWindow(g, entities, rect, opts));
}
