/**
 * Type-defining numbers: what makes a level read as parkour, maze,
 * collect-a-thon, story or speedrun, stated as bands on @measure numbers.
 *
 * The bands restate prompts/brief/types.md in numbers (gap fractions are of
 * the knight's running limit, maxGapRun = 11 tiles at the design tier):
 *
 *  parkour        sparse, bursty (hard jumps then a rest), gaps often 0.6-0.9,
 *                 narrow landings and pillars, few coins and enemies.
 *  maze           dense and vertical, walls/tunnels/ceilings, fruit
 *                 rewarding dead ends. (Its "small gaps" rule is not banded:
 *                 @measure's arcs ignore ceilings, see TYPE_RULES.maze.)
 *  collect-a-thon a reward every few tiles, coins on arcs (never rows on the
 *                 floor), moderate gaps.
 *  story          gentle: long rests, signs before new ideas, few enemies,
 *                 gaps 0.5 at most, low difficulty.
 *  speedrun       platforms at jump rhythm (regular takeoffs), flat-ish
 *                 linear route, gaps 0.4-0.8, wide landings, almost no walls.
 *
 * Tests assert every reference level fits its own type, and that every
 * type's bands reject at least one level of another type (no vacuous rule).
 */
import { analyzeWindow, fullRect, measureLevel, type LevelMeasures } from "@measure";
import type { LevelSnapshot } from "../../apps/editor/src/contracts";
import type { LevelType } from "./source";

/** The numbers the type rules read. All plain numbers (JSON-safe). */
export interface TypeNumbers {
  /** Mean solid share per screen with content. */
  density: number;
  linearity: number;
  verticality: number;
  meanDifficulty: number;
  maxDifficulty: number;
  /** Transitions other than drops, whole level. */
  jumps: number;
  /** Jumps over a gap. */
  gaps: number;
  /** Share of gaps >= 0.6 of maxGapRun. */
  gapNear: number;
  /** Share of gaps in [0.4, 0.8) of maxGapRun. */
  gapMid: number;
  /** Share of gaps < 0.4 of maxGapRun. */
  gapSmall: number;
  meanLandingWidth: number;
  /** Coefficient of variation of the distance between consecutive jump takeoffs (0 = metronome). */
  rhythmCV: number;
  collectables: number;
  coins: number;
  fruit: number;
  enemies: number;
  signs: number;
  /** Collectables per screen with content. */
  rewardsPerScreen: number;
  rewardSpacing: number;
  coinsOnArc: number;
  coinsOnFloor: number;
  pressure: number;
  /** Screens whose tags include each of these patterns. */
  restScreens: number;
  wallScreens: number;
  tunnelScreens: number;
  pillarScreens: number;
  screens: number;
  distinctPatterns: number;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Measure a level into the numbers the type rules read. */
export function typeNumbers(snap: LevelSnapshot, lm: LevelMeasures = measureLevel(snap)): TypeNumbers {
  const whole = lm.whole;
  const a = analyzeWindow(snap, snap.entities, fullRect(snap));
  const takeoffs = a.graph.transitions
    .filter((t) => t.kind !== "drop")
    .map((t) => t.takeoff.x)
    .sort((p, q) => p - q);
  const steps: number[] = [];
  for (let i = 1; i < takeoffs.length; i++) steps.push(takeoffs[i] - takeoffs[i - 1]);
  const m = steps.length ? steps.reduce((s, v) => s + v, 0) / steps.length : 0;
  const sd = steps.length ? Math.sqrt(steps.reduce((s, v) => s + (v - m) ** 2, 0) / steps.length) : 0;
  const h = whole.gapHist;
  const anyGaps = whole.counts.gaps > 0;
  const count = (k: string) => snap.entities.filter((e) => e.kind === k).length;
  const ps = lm.aggregate.patternScreens;
  const screens = lm.aggregate.screensWithContent;
  return {
    density: lm.aggregate.meanDensity,
    linearity: lm.aggregate.meanLinearity,
    verticality: lm.aggregate.meanVerticality,
    meanDifficulty: lm.aggregate.meanDifficulty,
    maxDifficulty: lm.aggregate.maxDifficulty,
    jumps: whole.counts.jumps,
    gaps: whole.counts.gaps,
    gapNear: anyGaps ? round(h[3] + h[4]) : 0,
    gapMid: anyGaps ? round(h[2] + h[3]) : 0,
    gapSmall: anyGaps ? round(h[0] + h[1]) : 0,
    meanLandingWidth: whole.meanLandingWidth,
    rhythmCV: m > 0 ? round(sd / m) : 0,
    collectables: whole.counts.collectables,
    coins: whole.counts.coins,
    fruit: count("fruit"),
    enemies: whole.counts.enemies,
    signs: count("sign"),
    rewardsPerScreen: screens ? round(whole.counts.collectables / screens) : 0,
    rewardSpacing: whole.rewardSpacing,
    coinsOnArc: whole.coinsOnArcShare,
    coinsOnFloor: whole.coinsOnFloorShare,
    pressure: whole.pressure,
    restScreens: ps.rest,
    wallScreens: ps.wall,
    tunnelScreens: ps.tunnel,
    pillarScreens: ps["pillar-hop"],
    screens,
    distinctPatterns: lm.aggregate.distinctPatterns,
  };
}

export interface TypeRule {
  /** Short id, e.g. "sparse". */
  id: string;
  /** What the rule means, for messages and the README. */
  text: string;
  key: keyof TypeNumbers;
  min?: number;
  max?: number;
}

const rule = (id: string, key: keyof TypeNumbers, text: string, min?: number, max?: number): TypeRule => ({
  id,
  key,
  text,
  min,
  max,
});

/** The bands per type. Inclusive. */
export const TYPE_RULES: Record<LevelType, readonly TypeRule[]> = {
  parkour: [
    rule("sparse", "density", "sparse terrain", undefined, 0.2),
    rule("hard-gaps", "gapNear", "most gaps 0.6+ of the knight's limit", 0.6),
    rule("many-jumps", "gaps", "a gap jump every screen or so", 10),
    rule("bursty", "rhythmCV", "bursts of jumps then rests (irregular takeoffs)", 0.3),
    rule("rests", "restScreens", "rests between bursts", 2),
    rule("few-coins", "collectables", "few rewards", undefined, 16),
    rule("few-enemies", "enemies", "few enemies", undefined, 4),
    rule("hard", "meanDifficulty", "hard on average", 0.25),
    rule("peaks", "maxDifficulty", "the hardest screen near the top of the scale", 0.5),
  ],
  // No gap band for mazes: @measure's arcs assume open sky (ceilings are not
  // checked), so its gap shares under a roof count jumps nobody can make.
  maze: [
    rule("dense", "density", "dense terrain", 0.4),
    rule("vertical", "verticality", "paths go up and down", 0.3),
    rule("winding", "linearity", "surfaces far from one line", undefined, 0.7),
    rule("walls", "wallScreens", "walls in most screens", 4),
    rule("tunnels", "tunnelScreens", "tunnels or low ceilings", 2),
    rule("dead-end-fruit", "fruit", "fruit rewarding dead ends", 2),
  ],
  "collect-a-thon": [
    rule("many-rewards", "rewardsPerScreen", "rewards all along the route (5+ per screen)", 5),
    rule("close-rewards", "rewardSpacing", "rewards close together along the route", 1, 9),
    rule("coins-on-arcs", "coinsOnArc", "coins on jump arcs", 0.8),
    rule("no-floor-rows", "coinsOnFloor", "coins (almost) never on the floor", undefined, 0.1),
    rule("moderate-gaps", "gapNear", "gaps moderate (few at the limit)", undefined, 0.35),
  ],
  story: [
    rule("signs", "signs", "signs before new ideas", 3),
    rule("rests", "restScreens", "long rests", 4),
    rule("gentle", "meanDifficulty", "gentle difficulty", undefined, 0.2),
    rule("small-gaps", "gapNear", "gaps about 0.5 of the limit at most (none 0.6+)", undefined, 0),
    rule("few-enemies", "enemies", "few enemies", undefined, 2),
  ],
  speedrun: [
    rule("rhythm", "rhythmCV", "takeoffs at a steady rhythm", undefined, 0.15),
    rule("linear", "linearity", "flat-ish linear route", 0.85),
    rule("flat", "verticality", "little climbing", undefined, 0.15),
    rule("run-gaps", "gapMid", "gaps 0.4-0.8 with a full run-up", 0.8),
    rule("wide-landings", "meanLandingWidth", "landings 3+ wide to keep speed", 3),
    rule("many-jumps", "jumps", "constant jumping", 15),
    rule("no-walls", "wallScreens", "almost no walls", undefined, 1),
    rule("few-enemies", "enemies", "few enemies", undefined, 2),
  ],
};

export interface RuleResult extends TypeRule {
  value: number;
  ok: boolean;
}

export interface TypeFit {
  type: LevelType;
  ok: boolean;
  results: RuleResult[];
  failures: RuleResult[];
}

/** Check numbers against one type's bands. */
export function fitType(type: LevelType, n: TypeNumbers): TypeFit {
  const results = TYPE_RULES[type].map((r) => {
    const value = n[r.key];
    const ok = (r.min === undefined || value >= r.min) && (r.max === undefined || value <= r.max);
    return { ...r, value, ok };
  });
  const failures = results.filter((r) => !r.ok);
  return { type, ok: failures.length === 0, results, failures };
}

/** One line per failed rule, e.g. "parkour/sparse: density 0.31 > 0.2 (sparse terrain)". */
export function describeFailures(fit: TypeFit): string[] {
  return fit.failures.map((f) => {
    const band =
      f.min !== undefined && f.value < f.min ? `< ${f.min}` : f.max !== undefined ? `> ${f.max}` : "out of band";
    return `${fit.type}/${f.id}: ${f.key} ${f.value} ${band} (${f.text})`;
  });
}
