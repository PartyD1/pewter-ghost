/**
 * Every number the measure package decides with lives here, so the brief,
 * the validator bands and the offline suite all read the same definitions.
 * Change a value here and every consumer moves together.
 */

/** Columns in one "screen" for per-screen measures (= the default 24-column fill window). */
export const SCREEN_COLS = 24;

/** Number of bins in the gap and rise histograms: [0,.2) [.2,.4) [.4,.6) [.6,.8) [.8, inf). */
export const HIST_BINS = 5;

export const MEASURE = {
  /** A rest is flat, enemy-free ground at least this wide (also the slicing unit). */
  restMinWidth: 4,
  /** Slicing: columns of a long rest kept by each neighbouring chunk. */
  sliceRestMargin: 3,
  /** Headroom (empty cells counted from the standing cell up) a rest needs. */
  restMinHeadroom: 2,
  /** "Within N tiles" for pressure and guarded rewards (Chebyshev distance). */
  nearTiles: 3,
  /** Staircase: at least this many single-step transitions in one direction. */
  staircaseMinSteps: 3,
  /** Largest |dy| a staircase step may have. */
  staircaseMaxStep: 2,
  /** Gap run / rising steps: at least this many gap jumps in a row. */
  gapRunMin: 3,
  /** Largest |dy| inside a gap run (beyond that it is rising/falling steps). */
  gapRunMaxDy: 1,
  risingStepsMin: 3,
  /** Pillar: a standing surface at most this wide ... */
  pillarMaxWidth: 2,
  /** ... with at least this many solid tiles directly below it. */
  pillarMinDepth: 2,
  /** Pillar hop: at least this many pillars hopped in a row. */
  pillarHopMin: 2,
  /** Wall: a solid face at least this tall beside a standing cell. */
  wallMinHeight: 3,
  /** Tunnel: standing cells whose ceiling is at most this many cells up (1 = crawl space) ... */
  tunnelMaxHeadroom: 3,
  /** ... for at least this many columns in a row. */
  tunnelMinLength: 4,
  /** Coin arc / coin row / coin ladder: at least this many coins. */
  coinGroupMin: 3,
  /** Enemy gate: the enemy's surface is at most this wide, or its ceiling this low. */
  enemyGateMaxWidth: 5,
  /** A landing surface this narrow or narrower counts as "narrow" for difficulty. */
  narrowWidth: 2,
  /** Linearity: RMS residual (tiles) of the height fit at which linearity reaches 0. */
  linearityScale: 4,
  /** Obstacle rate: jumps per screen at which the rate component saturates at 1. */
  obstaclesPerScreenFull: 6,
  /**
   * Leniency: a lethal jump still counts as forgiving when the GUARANTEED-tier
   * reach exceeds the gap by at least this many tiles AND the landing is at
   * least `narrowWidth + 1` wide (a mistimed jump still lands).
   */
  lenientSlackTiles: 1,
} as const;

/**
 * Difficulty = sum(weight * component), every component in [0, 1], weights
 * summing to 1, so difficulty is in [0, 1]. Calibrated later against Play
 * deaths (G-29); until then these are the plan's four named inputs (gap ratio,
 * rise, enemy proximity to landings, platform width) plus three supporting
 * ones.
 */
export const DIFFICULTY_WEIGHTS = {
  /** Mean gap width / maxGapRun over gap jumps. */
  gapRatio: 0.2,
  /** Widest gap / maxGapRun. */
  maxGapRatio: 0.15,
  /** Mean rise / maxRise over rising transitions. */
  rise: 0.15,
  /** Pressure (enemies near landings / landings), clamped to 1. */
  pressure: 0.15,
  /** Share of jump landings on narrow (<= 2 wide) surfaces. */
  narrow: 0.1,
  /** Share of jumps over a lethal pit. */
  lethal: 0.1,
  /** 1 - leniency. */
  unforgiving: 0.05,
  /** Jumps per screen / obstaclesPerScreenFull, clamped to 1. */
  obstacleRate: 0.1,
} as const;

export type DifficultyPart = keyof typeof DIFFICULTY_WEIGHTS;

/**
 * Pattern tags, in catalogue order. `patterns` arrays are always sorted in
 * this order so equal levels give equal arrays.
 */
export const PATTERN_TAGS = [
  "staircase",
  "gap-run",
  "pillar-hop",
  "rising-steps",
  "coin-arc",
  "coin-row-on-floor",
  "coin-ladder",
  "risky-coin",
  "guarded-reward",
  "rest",
  "enemy-gate",
  "wall",
  "pit",
  "tunnel",
] as const;

export type PatternTag = (typeof PATTERN_TAGS)[number];
