/** Latency scorer: percentiles and the share inside the client's call budget. */

export interface LatencyScore {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** Share of calls at or under the budget (1 - drop-for-timeout rate). */
  withinBudget: number;
  budgetMs: number;
}

/** Nearest-rank percentile of sorted values (q in 0..1). */
export function percentile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export function scoreLatency(values: readonly number[], budgetMs: number): LatencyScore {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  const n = v.length;
  return {
    n,
    mean: n ? v.reduce((a, b) => a + b, 0) / n : 0,
    p50: percentile(v, 0.5),
    p90: percentile(v, 0.9),
    p99: percentile(v, 0.99),
    max: n ? v[n - 1] : 0,
    withinBudget: n ? v.filter((x) => x <= budgetMs).length / n : 0,
    budgetMs,
  };
}
