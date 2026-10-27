/**
 * The CDHF acceptance predictor: two logistic regressions (Mozannar et al.
 * 2023 found XGBoost best, logistic regression close; logistic keeps the
 * weights a small JSON object a launcher token can override).
 *
 *   context: P(accept | X)     stage 1, decides whether to call the model at all
 *   full:    P(accept | X, S)  stage 2, decides whether (and, re-evaluated every
 *                              tick, when) a verified ghost shows
 *
 * PRIOR_WEIGHTS are hand-set signs and sizes, not fitted: they stand in until
 * `npm run eval -- timing --train` fits weights on logged sessions and the
 * result is passed as config.cdhfWeights.
 */
import { CONTEXT_FEATURES, FULL_FEATURES, type Features } from "./features";

export interface LogisticModel {
  bias: number;
  w: Record<string, number>;
}

export interface CdhfWeights {
  context: LogisticModel;
  full: LogisticModel;
  /** "prior" or "trained-<date>" (logged with the session config). */
  version: string;
  /** Labelled ghosts the weights were fitted on (0 for the prior). */
  trainedOn: number;
}

const CONTEXT_PRIOR: Record<string, number> = {
  idleSec: 0.15, // a pause is a natural moment
  rate2s: -0.8, // mid-drag: a ghost interrupts
  rate10s: -0.2,
  eraseShare: -1.5, // erasing: they are undoing, not building
  acceptRate5: 1.5, // they have been keeping ghosts
  dismissRun: -0.4, // they have been dismissing them
  sinceGhostSec: 0.3, // a ghost just went away
  tidy: -0.3,
};

export const PRIOR_WEIGHTS: CdhfWeights = {
  version: "prior",
  trainedOn: 0,
  context: { bias: -1, w: CONTEXT_PRIOR },
  full: {
    bias: -1,
    w: {
      ...CONTEXT_PRIOR,
      confidence: 2.5,
      cells: -0.1,
      finish: 0.5,
      fix: -0.2,
      sendBack: -0.3,
      dist: -0.3,
    },
  },
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** P(accept). Features missing from the vector count as 0; weights for unknown features are ignored. */
export function predict(m: LogisticModel, f: Features): number {
  let z = Number.isFinite(m.bias) ? m.bias : 0;
  for (const [k, w] of Object.entries(m.w)) {
    const v = (f as Record<string, number | undefined>)[k];
    if (v !== undefined && Number.isFinite(v) && Number.isFinite(w)) z += w * v;
  }
  return sigmoid(z);
}

/** Shannon entropy of a Bernoulli(p) in bits (the paper's gate r(X) thresholds this). */
export function entropyBits(p: number): number {
  if (!(p > 0 && p < 1)) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

export interface Example {
  f: Record<string, number>;
  y: 0 | 1;
}

export interface TrainOptions {
  /** L2 penalty on the weights (not the bias). */
  l2?: number;
  epochs?: number;
  lr?: number;
}

/** Fit a logistic regression by full-batch gradient descent. Deterministic. */
export function train(examples: readonly Example[], names: readonly string[], o: TrainOptions = {}): LogisticModel {
  const l2 = o.l2 ?? 0.01;
  const epochs = o.epochs ?? 3000;
  const lr = o.lr ?? 0.3;
  const w = names.map(() => 0);
  let b = 0;
  const n = examples.length;
  if (n === 0) return { bias: 0, w: Object.fromEntries(names.map((k) => [k, 0])) };
  const X = examples.map((e) => names.map((k) => (Number.isFinite(e.f[k]) ? e.f[k] : 0)));
  for (let ep = 0; ep < epochs; ep++) {
    const gw = names.map(() => 0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - examples[i].y;
      gb += err;
      for (let j = 0; j < w.length; j++) gw[j] += err * X[i][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < w.length; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return { bias: round(b), w: Object.fromEntries(names.map((k, j) => [k, round(w[j])])) };
}

/** Fit both stages from labelled show-time feature vectors. */
export function trainCdhf(examples: readonly Example[], version: string, o?: TrainOptions): CdhfWeights {
  return {
    version,
    trainedOn: examples.length,
    context: train(examples, CONTEXT_FEATURES, o),
    full: train(examples, FULL_FEATURES, o),
  };
}

/** Area under the ROC curve (ties count half); NaN when one class is missing. */
export function auc(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  scores.forEach((s, i) => (labels[i] === 1 ? pos : neg).push(s));
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Loose shape check for weights arriving through config overrides. */
export function isCdhfWeights(v: unknown): v is CdhfWeights {
  const m = (x: unknown) =>
    !!x &&
    typeof x === "object" &&
    Number.isFinite((x as LogisticModel).bias) &&
    !!(x as LogisticModel).w &&
    typeof (x as LogisticModel).w === "object";
  return !!v && typeof v === "object" && m((v as CdhfWeights).context) && m((v as CdhfWeights).full);
}
