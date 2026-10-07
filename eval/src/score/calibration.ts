/**
 * Calibration scorer (G-27): how well a confidence number predicts a binary
 * outcome (accepted from the logs, or verified first try in the suite).
 *
 *  - bins: equal-width confidence bins with the positive rate per bin
 *  - bands: the app's three bands (below showAtPauseAbove, between, at or
 *    above showNowAbove) and the top/bottom acceptance ratio (target >= 1.5)
 *  - tertile ratio: the same on equal-count tertiles, so sources on different
 *    scales compare fairly
 *  - AUC (rank), Brier, ECE, least-squares slope of outcome on confidence
 *  - steepness: the single number used to pick a source (AUC - 0.5, i.e.
 *    how far above chance the ranking is)
 *  - thresholds: smallest confidence whose ghosts at or above it are accepted
 *    at the target rates (suggested showNowAbove / showAtPauseAbove)
 */

export interface CalPoint {
  confidence: number;
  label: boolean;
}

export interface CalBin {
  lo: number;
  hi: number;
  n: number;
  positives: number;
  rate: number;
  meanConfidence: number;
}

export interface CalBand {
  name: "low" | "mid" | "high";
  lo: number;
  hi: number;
  n: number;
  rate: number;
}

export interface CalibrationStats {
  n: number;
  positives: number;
  baseRate: number;
  bins: CalBin[];
  bands: CalBand[];
  /** high-band rate / low-band rate (Infinity when low is 0 and high > 0; NaN when a band is empty). */
  bandRatio: number;
  tertileRatio: number;
  auc: number;
  brier: number;
  ece: number;
  slope: number;
  steepness: number;
}

export interface BandEdges {
  showAtPauseAbove: number;
  showNowAbove: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

export function calibrationBins(points: readonly CalPoint[], bins = 5): CalBin[] {
  const out: CalBin[] = [];
  for (let i = 0; i < bins; i++) out.push({ lo: i / bins, hi: (i + 1) / bins, n: 0, positives: 0, rate: 0, meanConfidence: 0 });
  for (const p of points) {
    const c = clamp01(p.confidence);
    const b = out[Math.min(bins - 1, Math.floor(c * bins))];
    b.n++;
    b.meanConfidence += c;
    if (p.label) b.positives++;
  }
  for (const b of out) {
    b.rate = b.n ? b.positives / b.n : 0;
    b.meanConfidence = b.n ? b.meanConfidence / b.n : 0;
  }
  return out;
}

function rateOf(ps: readonly CalPoint[]): number {
  return ps.length ? ps.filter((p) => p.label).length / ps.length : NaN;
}

function ratio(hi: number, lo: number): number {
  if (Number.isNaN(hi) || Number.isNaN(lo)) return NaN;
  if (lo === 0) return hi > 0 ? Infinity : NaN;
  return hi / lo;
}

/** Rank AUC (Mann-Whitney), ties count half. 0.5 when one class is missing. */
export function auc(points: readonly CalPoint[]): number {
  const pos = points.filter((p) => p.label).map((p) => p.confidence);
  const neg = points.filter((p) => !p.label).map((p) => p.confidence);
  if (!pos.length || !neg.length) return 0.5;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

export function calibrationStats(points: readonly CalPoint[], edges: BandEdges = { showAtPauseAbove: 0.4, showNowAbove: 0.75 }, bins = 5): CalibrationStats {
  const n = points.length;
  const positives = points.filter((p) => p.label).length;
  const b = calibrationBins(points, bins);
  const low = points.filter((p) => p.confidence < edges.showAtPauseAbove);
  const mid = points.filter((p) => p.confidence >= edges.showAtPauseAbove && p.confidence < edges.showNowAbove);
  const high = points.filter((p) => p.confidence >= edges.showNowAbove);
  const bands: CalBand[] = [
    { name: "low", lo: 0, hi: edges.showAtPauseAbove, n: low.length, rate: rateOf(low) },
    { name: "mid", lo: edges.showAtPauseAbove, hi: edges.showNowAbove, n: mid.length, rate: rateOf(mid) },
    { name: "high", lo: edges.showNowAbove, hi: 1, n: high.length, rate: rateOf(high) },
  ];
  const sorted = [...points].sort((x, y) => x.confidence - y.confidence);
  const t = Math.floor(n / 3);
  const tertileRatio = t > 0 ? ratio(rateOf(sorted.slice(n - t)), rateOf(sorted.slice(0, t))) : NaN;
  const brier = n ? points.reduce((a, p) => a + (clamp01(p.confidence) - (p.label ? 1 : 0)) ** 2, 0) / n : 0;
  const ece = n ? b.reduce((a, bin) => a + (bin.n / n) * Math.abs(bin.rate - bin.meanConfidence), 0) : 0;
  const mx = n ? points.reduce((a, p) => a + p.confidence, 0) / n : 0;
  const my = n ? positives / n : 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.confidence - mx) * ((p.label ? 1 : 0) - my);
    sxx += (p.confidence - mx) ** 2;
  }
  const a = auc(points);
  return {
    n,
    positives,
    baseRate: my,
    bins: b,
    bands,
    bandRatio: ratio(bands[2].rate, bands[0].rate),
    tertileRatio,
    auc: a,
    brier,
    ece,
    slope: sxx > 0 ? sxy / sxx : 0,
    steepness: a - 0.5,
  };
}

/**
 * Smallest threshold c (from the observed confidences) such that points with
 * confidence >= c have a positive rate >= target and at least `minN` points.
 * Undefined when no threshold reaches the target.
 */
export function thresholdFor(points: readonly CalPoint[], target: number, minN = 5): number | undefined {
  const cs = [...new Set(points.map((p) => p.confidence))].sort((a, b) => a - b);
  for (const c of cs) {
    const above = points.filter((p) => p.confidence >= c);
    if (above.length < minN) break;
    if (rateOf(above) >= target) return c;
  }
  return undefined;
}

/** Suggested showNowAbove / showAtPauseAbove from a curve. */
export function suggestThresholds(
  points: readonly CalPoint[],
  o: { nowRate?: number; pauseRate?: number; minN?: number } = {},
): { showNowAbove?: number; showAtPauseAbove?: number } {
  return {
    showNowAbove: thresholdFor(points, o.nowRate ?? 0.6, o.minN),
    showAtPauseAbove: thresholdFor(points, o.pauseRate ?? 0.3, o.minN),
  };
}
