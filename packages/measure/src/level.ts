/**
 * Whole-level measures: per-screen series plus level aggregates, for the
 * status line, the brief's "last two screens", and the suite's
 * expressive-range plots.
 */
import type { LevelSnapshot } from "../../../apps/editor/src/contracts";
import { PATTERN_TAGS, SCREEN_COLS, type PatternTag } from "./constants";
import { contentBounds, fullRect, type EntityLike, type GridLike } from "./grid";
import { analyzeWindow, measuresOf, type MeasureOptions, type WindowMeasures } from "./measures";

export interface LevelMeasureOptions extends MeasureOptions {
  /** Columns per screen. Default SCREEN_COLS (24). */
  screenCols?: number;
}

export interface ScreenMeasures {
  index: number;
  /** First column of the screen. */
  x: number;
  /** Columns in the screen (the last one may be narrower). */
  w: number;
  /** False when the screen has no solid tile and no entity. */
  hasContent: boolean;
  measures: WindowMeasures;
}

/** Per-screen arrays, one entry per screen (index = screen). */
export interface ScreenSeries {
  density: number[];
  verticality: number[];
  linearity: number[];
  leniency: number[];
  pressure: number[];
  rewardSpacing: number[];
  coinsOnArcShare: number[];
  difficulty: number[];
  patterns: PatternTag[][];
}

export interface LevelMeasures {
  w: number;
  h: number;
  screenCols: number;
  screens: ScreenMeasures[];
  series: ScreenSeries;
  /** The level measured as one window (histograms, leniency, pressure over every transition). */
  whole: WindowMeasures;
  /** Aggregates over screens with content (0 when there are none). */
  aggregate: {
    screensWithContent: number;
    /** First and last column with content, or null for an empty level. */
    extent: { x0: number; x1: number } | null;
    meanDensity: number;
    meanLinearity: number;
    meanVerticality: number;
    meanDifficulty: number;
    maxDifficulty: number;
    /** Std. deviation of per-screen difficulty: how much the level varies. */
    difficultySpread: number;
    /** Screens (with content) whose tags include each pattern. */
    patternScreens: Record<PatternTag, number>;
    /** Distinct pattern tags anywhere in the level. */
    distinctPatterns: number;
  };
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Measure a level per screen and as a whole. */
export function measureLevel(level: LevelSnapshot, opts: LevelMeasureOptions = {}): LevelMeasures {
  return measureGrid(level, level.entities, opts);
}

/** Same as measureLevel for a bare grid and entity list. */
export function measureGrid(
  g: GridLike,
  entities: readonly EntityLike[],
  opts: LevelMeasureOptions = {},
): LevelMeasures {
  const screenCols = Math.max(1, Math.floor(opts.screenCols ?? SCREEN_COLS));
  const screens: ScreenMeasures[] = [];
  for (let x = 0, i = 0; x < g.w; x += screenCols, i++) {
    const w = Math.min(screenCols, g.w - x);
    const rect = { x, y: 0, w, h: g.h };
    const a = analyzeWindow(g, entities, rect, opts);
    const hasContent = a.counts.solids > 0 || entities.some((e) => e.x >= x && e.x < x + w && e.y >= 0 && e.y < g.h);
    screens.push({ index: i, x, w, hasContent, measures: measuresOf(a) });
  }
  const series: ScreenSeries = {
    density: screens.map((s) => s.measures.density),
    verticality: screens.map((s) => s.measures.verticality),
    linearity: screens.map((s) => s.measures.linearity),
    leniency: screens.map((s) => s.measures.leniency),
    pressure: screens.map((s) => s.measures.pressure),
    rewardSpacing: screens.map((s) => s.measures.rewardSpacing),
    coinsOnArcShare: screens.map((s) => s.measures.coinsOnArcShare),
    difficulty: screens.map((s) => s.measures.difficulty),
    patterns: screens.map((s) => [...s.measures.patterns]),
  };
  const whole = measuresOf(analyzeWindow(g, entities, fullRect(g), opts));
  const live = screens.filter((s) => s.hasContent);
  const diffs = live.map((s) => s.measures.difficulty);
  const md = mean(diffs);
  const patternScreens = Object.fromEntries(PATTERN_TAGS.map((t) => [t, 0])) as Record<PatternTag, number>;
  for (const s of live) for (const t of s.measures.patterns) patternScreens[t]++;
  const b = contentBounds(g, entities);
  return {
    w: g.w,
    h: g.h,
    screenCols,
    screens,
    series,
    whole,
    aggregate: {
      screensWithContent: live.length,
      extent: b ? { x0: b.x, x1: b.x + b.w - 1 } : null,
      meanDensity: round(mean(live.map((s) => s.measures.density))),
      meanLinearity: round(mean(live.map((s) => s.measures.linearity))),
      meanVerticality: round(mean(live.map((s) => s.measures.verticality))),
      meanDifficulty: round(md),
      maxDifficulty: round(diffs.length ? Math.max(...diffs) : 0),
      difficultySpread: round(Math.sqrt(mean(diffs.map((d) => (d - md) ** 2)))),
      patternScreens,
      distinctPatterns: whole.patterns.length,
    },
  };
}

/**
 * Measures for the last `n` screens up to and including the one holding
 * column `x` (the brief's "last two screens" around the frontier).
 */
export function recentScreens(lm: LevelMeasures, x: number, n = 2): ScreenMeasures[] {
  const i = Math.max(0, Math.min(lm.screens.length - 1, Math.floor(x / lm.screenCols)));
  return lm.screens.slice(Math.max(0, i - n + 1), i + 1);
}
