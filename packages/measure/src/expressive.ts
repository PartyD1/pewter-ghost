/**
 * Expressive-range helpers (Smith & Whitehead style) for diversity across
 * levels: a feature vector per level, the linearity x leniency 2D histogram,
 * and pairwise distances between levels.
 */
import type { LevelMeasures } from "./level";
import type { WindowMeasures } from "./measures";

/** Features in [0, 1] describing one level (or one window). */
export interface ExpressiveFeatures {
  linearity: number;
  leniency: number;
  density: number;
  verticality: number;
  difficulty: number;
  pressure: number;
  coinsOnArcShare: number;
  /** Mean gap as a fraction of maxGapRun (from the gap histogram's bin centres). */
  gapMean: number;
}

export const FEATURE_KEYS: readonly (keyof ExpressiveFeatures)[] = [
  "linearity",
  "leniency",
  "density",
  "verticality",
  "difficulty",
  "pressure",
  "coinsOnArcShare",
  "gapMean",
];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function gapMeanOf(hist: readonly number[]): number {
  // Bin centres 0.1, 0.3, 0.5, 0.7, 0.9.
  let s = 0;
  hist.forEach((share, i) => (s += share * (0.1 + 0.2 * i)));
  return s;
}

function isLevel(m: LevelMeasures | WindowMeasures): m is LevelMeasures {
  return (m as LevelMeasures).screens !== undefined;
}

/**
 * Features of a level: linearity, density and verticality are the means over
 * screens with content (linearity is defined per screen); leniency,
 * pressure, coin share and gaps come from the whole level as one window;
 * difficulty is the per-screen mean. A WindowMeasures is used as is.
 */
export function expressiveFeatures(m: LevelMeasures | WindowMeasures): ExpressiveFeatures {
  if (!isLevel(m))
    return {
      linearity: clamp01(m.linearity),
      leniency: clamp01(m.leniency),
      density: clamp01(m.density),
      verticality: clamp01(m.verticality),
      difficulty: clamp01(m.difficulty),
      pressure: clamp01(m.pressure),
      coinsOnArcShare: clamp01(m.coinsOnArcShare),
      gapMean: clamp01(gapMeanOf(m.gapHist)),
    };
  const any = m.aggregate.screensWithContent > 0;
  return {
    linearity: any ? clamp01(m.aggregate.meanLinearity) : 1,
    leniency: clamp01(m.whole.leniency),
    density: clamp01(m.aggregate.meanDensity),
    verticality: clamp01(m.aggregate.meanVerticality),
    difficulty: clamp01(m.aggregate.meanDifficulty),
    pressure: clamp01(m.whole.pressure),
    coinsOnArcShare: clamp01(m.whole.coinsOnArcShare),
    gapMean: clamp01(gapMeanOf(m.whole.gapHist)),
  };
}

export interface ExpressiveHistogram {
  bins: number;
  x: keyof ExpressiveFeatures;
  y: keyof ExpressiveFeatures;
  /** counts[yBin][xBin]; bin i covers [i/bins, (i+1)/bins), the last includes 1. */
  counts: number[][];
  total: number;
  /** Share of bins holding at least one level: a crude "how much of the space is used". */
  coverage: number;
}

/**
 * 2D histogram of levels over two features (default linearity x leniency,
 * the classic expressive-range plot).
 */
export function expressiveHistogram(
  levels: readonly (LevelMeasures | WindowMeasures | ExpressiveFeatures)[],
  opts: { bins?: number; x?: keyof ExpressiveFeatures; y?: keyof ExpressiveFeatures } = {},
): ExpressiveHistogram {
  const bins = Math.max(1, Math.floor(opts.bins ?? 10));
  const xk = opts.x ?? "linearity";
  const yk = opts.y ?? "leniency";
  const counts = Array.from({ length: bins }, () => new Array<number>(bins).fill(0));
  const bin = (v: number) => Math.min(bins - 1, Math.max(0, Math.floor(clamp01(v) * bins)));
  for (const l of levels) {
    const f = asFeatures(l);
    counts[bin(f[yk])][bin(f[xk])]++;
  }
  const used = counts.flat().filter((c) => c > 0).length;
  return { bins, x: xk, y: yk, counts, total: levels.length, coverage: used / (bins * bins) };
}

function asFeatures(l: LevelMeasures | WindowMeasures | ExpressiveFeatures): ExpressiveFeatures {
  if ((l as LevelMeasures).screens !== undefined || (l as WindowMeasures).gapHist !== undefined)
    return expressiveFeatures(l as LevelMeasures | WindowMeasures);
  return l as ExpressiveFeatures;
}

/**
 * Distance between two levels: Euclidean over the features (each in [0, 1])
 * divided by sqrt(feature count), so the result is in [0, 1].
 */
export function levelDistance(
  a: LevelMeasures | WindowMeasures | ExpressiveFeatures,
  b: LevelMeasures | WindowMeasures | ExpressiveFeatures,
): number {
  const fa = asFeatures(a);
  const fb = asFeatures(b);
  let s = 0;
  for (const k of FEATURE_KEYS) s += (fa[k] - fb[k]) ** 2;
  return Math.sqrt(s / FEATURE_KEYS.length);
}

/** Symmetric matrix of levelDistance, zero diagonal. */
export function pairwiseDistances(levels: readonly (LevelMeasures | WindowMeasures | ExpressiveFeatures)[]): number[][] {
  const f = levels.map(asFeatures);
  const n = f.length;
  const m = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) m[i][j] = m[j][i] = levelDistance(f[i], f[j]);
  return m;
}

/** Mean pairwise distance (0 for fewer than two levels): the diversity number for a set of levels. */
export function meanPairwiseDistance(levels: readonly (LevelMeasures | WindowMeasures | ExpressiveFeatures)[]): number {
  const m = pairwiseDistances(levels);
  let s = 0,
    n = 0;
  for (let i = 0; i < m.length; i++)
    for (let j = i + 1; j < m.length; j++) {
      s += m[i][j];
      n++;
    }
  return n ? s / n : 0;
}
