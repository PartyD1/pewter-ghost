/**
 * Timing policies compared on logged sessions (G-36, suggest/timing).
 *
 * Two views, both from proxy/.data/logs:
 *
 *  1. Live, per condition (session.config.timing: llm | cdhf | jev): ghosts
 *     shown and kept per minute, keep / dismiss rates, model calls per minute
 *     (fill and Jev), calls the CDHF gate skipped. This is the comparison of
 *     the three policies as people experienced them.
 *
 *  2. Retrospective, on every shown ghost (Mozannar et al. 2023, §5): the
 *     `timing` show events carry the feature vector under every policy, joined
 *     to their ghost.end outcome. Scored by AUC: the LLM's own confidence, the
 *     CDHF prior, the Jev's last verdict (jev sessions), and a CDHF model
 *     trained on a 70% session split and scored on the rest. Then the paper's
 *     counterfactual: hiding ghosts below t2, what share would be hidden, how
 *     many of those were in fact rejected, and the keep rate of the rest.
 *
 * Training data selection follows the paper: only automatic shows (requested
 * and patrol ghosts are not timing decisions), and only decided outcomes
 * (kept vs Esc / drawn over / timeout).
 */
import type { LogEvent, TimingEvent, TimingPolicyName } from "../../apps/editor/src/contracts";
import { acceptLabel } from "../../apps/editor/src/suggest/timing/activity";
import { auc, predict, PRIOR_WEIGHTS, trainCdhf, type CdhfWeights, type Example } from "../../apps/editor/src/suggest/timing/model";
import type { SessionLog } from "./logs";

export interface TimingExample extends Example {
  sessionId: string;
  suggestionId: string;
  policy: TimingPolicyName;
  /** The filler's stated confidence (features.confidence + 0.5). */
  confidence: number;
  /** The Jev's latest verdict p before the show (jev sessions). */
  jevP?: number;
}

export interface PolicyStats {
  policy: TimingPolicyName;
  sessions: number;
  minutes: number;
  fillCalls: number;
  jevPolls: number;
  jevErrors: number;
  gated: number;
  shown: number;
  kept: number;
  rejected: number;
  /** kept / (kept + rejected). */
  keepRate: number;
  /** Ghosts kept per minute of editing. */
  keptPerMin: number;
  /** Model calls (fill + Jev) per kept ghost. */
  callsPerKept: number;
  medianDwellMs: number;
}

export interface Counterfactual {
  t2: number;
  /** Share of shown ghosts hidden at this threshold. */
  hidden: number;
  /** Share of hidden ghosts that were rejected (the paper's 94.7%). */
  hiddenRejected: number;
  /** Keep rate among the ghosts still shown. */
  keepAfter: number;
}

const isTiming = (e: LogEvent): e is TimingEvent => e.type === "timing";

export function sessionPolicy(s: SessionLog): TimingPolicyName {
  const head = s.events.find((e) => e.type === "session") as Extract<LogEvent, { type: "session" }> | undefined;
  const t = head?.config?.timing;
  return t === "cdhf" || t === "jev" ? t : "llm";
}

function minutes(events: readonly LogEvent[]): number {
  if (events.length < 2) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events) {
    lo = Math.min(lo, e.t);
    hi = Math.max(hi, e.t);
  }
  return Math.max(0, hi - lo) / 60_000;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function policyStats(sessions: readonly SessionLog[]): PolicyStats[] {
  const by = new Map<TimingPolicyName, SessionLog[]>();
  for (const s of sessions) {
    const p = sessionPolicy(s);
    by.set(p, [...(by.get(p) ?? []), s]);
  }
  const out: PolicyStats[] = [];
  for (const policy of ["llm", "cdhf", "jev"] as const) {
    const ss = by.get(policy);
    if (!ss) continue;
    let mins = 0;
    let fillCalls = 0;
    let jevPolls = 0;
    let jevErrors = 0;
    let gated = 0;
    let shown = 0;
    let kept = 0;
    let rejected = 0;
    const dwell: number[] = [];
    for (const s of ss) {
      mins += minutes(s.events);
      for (const e of s.events) {
        if (e.type === "fill.call" && !e.sendBack) fillCalls++;
        else if (e.type === "ghost.show") shown++;
        else if (e.type === "ghost.end") {
          const y = acceptLabel(e.outcome);
          if (y === 1) kept++;
          else if (y === 0) rejected++;
          dwell.push(e.dwellMs);
        } else if (isTiming(e) && e.stage === "jev") {
          jevPolls++;
          if (e.decision === "error") jevErrors++;
        } else if (isTiming(e) && e.stage === "gate" && e.decision === "skip") gated++;
      }
    }
    out.push({
      policy,
      sessions: ss.length,
      minutes: mins,
      fillCalls,
      jevPolls,
      jevErrors,
      gated,
      shown,
      kept,
      rejected,
      keepRate: kept + rejected ? kept / (kept + rejected) : NaN,
      keptPerMin: mins > 0 ? kept / mins : NaN,
      callsPerKept: kept ? (fillCalls + jevPolls) / kept : NaN,
      medianDwellMs: median(dwell),
    });
  }
  return out;
}

/** Labelled show-time feature vectors (automatic shows with a decided outcome). */
export function timingExamples(sessions: readonly SessionLog[]): TimingExample[] {
  const out: TimingExample[] = [];
  for (const s of sessions) {
    const policy = sessionPolicy(s);
    const ends = new Map<string, 0 | 1>();
    for (const e of s.events) {
      if (e.type !== "ghost.end") continue;
      const y = acceptLabel(e.outcome);
      if (y !== null) ends.set(e.suggestionId, y);
    }
    let jevP: number | undefined;
    for (const e of s.events) {
      if (!isTiming(e)) continue;
      if (e.stage === "jev" && e.p !== undefined) jevP = e.p;
      if (e.stage !== "show" || !e.features || !e.suggestionId) continue;
      if (e.why === "requested" || e.why === "patrol") continue;
      const y = ends.get(e.suggestionId);
      if (y === undefined) continue;
      const ex: TimingExample = {
        sessionId: s.sessionId,
        suggestionId: e.suggestionId,
        policy,
        f: e.features,
        y,
        confidence: (e.features.confidence ?? 0) + 0.5,
      };
      if (policy === "jev" && jevP !== undefined) ex.jevP = jevP;
      out.push(ex);
    }
  }
  return out;
}

/**
 * Deterministic split by session, so one person's ghosts stay on one side:
 * sessions ordered by an FNV-1a hash of their id, the first `trainShare` of
 * them train. With two or more sessions both sides get at least one; with one
 * session everything is train (nothing held out).
 */
export function splitBySession<T extends { sessionId: string }>(xs: readonly T[], trainShare = 0.7): { train: T[]; test: T[] } {
  const hash = (id: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
    return h;
  };
  const ids = [...new Set(xs.map((x) => x.sessionId))].sort((a, b) => hash(a) - hash(b) || a.localeCompare(b));
  const cut = ids.length < 2 ? ids.length : Math.min(ids.length - 1, Math.max(1, Math.round(ids.length * trainShare)));
  const trainIds = new Set(ids.slice(0, cut));
  const train: T[] = [];
  const test: T[] = [];
  for (const x of xs) (trainIds.has(x.sessionId) ? train : test).push(x);
  return { train, test };
}

export function counterfactuals(scores: readonly number[], labels: readonly (0 | 1)[], thresholds: readonly number[]): Counterfactual[] {
  return thresholds.map((t2) => {
    let hidden = 0;
    let hiddenRej = 0;
    let shown = 0;
    let shownKept = 0;
    scores.forEach((p, i) => {
      if (p < t2) {
        hidden++;
        if (labels[i] === 0) hiddenRej++;
      } else {
        shown++;
        if (labels[i] === 1) shownKept++;
      }
    });
    const n = scores.length;
    return {
      t2,
      hidden: n ? hidden / n : NaN,
      hiddenRejected: hidden ? hiddenRej / hidden : NaN,
      keepAfter: shown ? shownKept / shown : NaN,
    };
  });
}

/** The paper's choice: hide as much as possible while hidden ghosts stay at least `minRejected` rejected. */
export function chooseT2(cfs: readonly Counterfactual[], minRejected = 0.9): Counterfactual | null {
  let best: Counterfactual | null = null;
  for (const c of cfs) if (c.hidden > 0 && c.hiddenRejected >= minRejected && (!best || c.hidden > best.hidden)) best = c;
  return best;
}

export const T2_GRID = Array.from({ length: 19 }, (_, i) => Math.round((0.05 + i * 0.05) * 100) / 100);

export interface TimingAnalysis {
  stats: PolicyStats[];
  examples: number;
  positives: number;
  /** AUC of each scorer on the test split (or all examples for the fixed scorers when nothing was trained). */
  auc: { confidence: number; prior: number; trained?: number; jev?: number; jevN?: number };
  train: number;
  test: number;
  weights?: CdhfWeights;
  counterfactual: Counterfactual[];
  chosen: Counterfactual | null;
  /** Which scorer the counterfactual used. */
  scorer: "trained" | "prior";
}

export function analyseTiming(
  sessions: readonly SessionLog[],
  o: { train?: boolean; minRejected?: number; version?: string } = {},
): TimingAnalysis {
  const all = timingExamples(sessions);
  // Training needs a held-out side to score on: at least 10 ghosts from two sessions.
  const split = splitBySession(all);
  const doTrain = !!o.train && all.length >= 10 && split.train.length > 0 && split.test.length > 0;
  const { train, test } = doTrain ? split : { train: [], test: all };
  const evalSet = test;
  const labels = evalSet.map((e) => e.y);
  const weights = doTrain ? trainCdhf(train, o.version ?? "trained") : undefined;
  const prior = evalSet.map((e) => predict(PRIOR_WEIGHTS.full, e.f));
  const scores = weights ? evalSet.map((e) => predict(weights.full, e.f)) : prior;
  const jevSet = evalSet.filter((e) => e.jevP !== undefined);
  const a: TimingAnalysis["auc"] = {
    confidence: auc(
      evalSet.map((e) => e.confidence),
      labels,
    ),
    prior: auc(prior, labels),
  };
  if (weights) a.trained = auc(scores, labels);
  if (jevSet.length) {
    a.jev = auc(
      jevSet.map((e) => e.jevP!),
      jevSet.map((e) => e.y),
    );
    a.jevN = jevSet.length;
  }
  const cf = counterfactuals(scores, labels, T2_GRID);
  // Final weights for config.cdhfWeights: refit on everything once the split has been scored.
  const final = weights ? trainCdhf(all, o.version ?? "trained") : undefined;
  return {
    stats: policyStats(sessions),
    examples: all.length,
    positives: all.filter((e) => e.y === 1).length,
    auc: a,
    train: train.length,
    test: evalSet.length,
    weights: final,
    counterfactual: cf,
    chosen: chooseT2(cf, o.minRejected ?? 0.9),
    scorer: weights ? "trained" : "prior",
  };
}

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
const fx = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

export function timingMarkdown(a: TimingAnalysis, title = "Timing policies"): string {
  const out: string[] = [`# ${title}`, ""];
  out.push("## Live, per condition", "");
  if (!a.stats.length) out.push("No sessions.", "");
  else {
    out.push("| policy | sessions | minutes | shown | kept | keep rate | kept/min | fill calls | Jev polls (errors) | gated calls | calls per kept | median dwell ms |");
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of a.stats)
      out.push(
        `| ${s.policy} | ${s.sessions} | ${fx(s.minutes, 1)} | ${s.shown} | ${s.kept} | ${pct(s.keepRate)} | ${fx(s.keptPerMin)} | ${s.fillCalls} | ${s.jevPolls} (${s.jevErrors}) | ${s.gated} | ${fx(s.callsPerKept, 1)} | ${fx(s.medianDwellMs, 0)} |`,
      );
    out.push("");
  }
  out.push("## Retrospective, on shown ghosts (Mozannar et al. 2023)", "");
  out.push(`${a.examples} labelled automatic ghosts, ${a.positives} kept. Scored on ${a.test}${a.train ? ` (trained on ${a.train}, split by session)` : ""}.`, "");
  out.push("| scorer | AUC |", "|---|---|");
  out.push(`| LLM stated confidence | ${fx(a.auc.confidence, 3)} |`);
  out.push(`| CDHF prior weights | ${fx(a.auc.prior, 3)} |`);
  if (a.auc.trained !== undefined) out.push(`| CDHF trained | ${fx(a.auc.trained, 3)} |`);
  if (a.auc.jev !== undefined) out.push(`| Jev last verdict p (${a.auc.jevN} ghosts) | ${fx(a.auc.jev, 3)} |`);
  out.push("");
  out.push(`### Hiding ghosts below t2 (${a.scorer} CDHF)`, "");
  out.push("| t2 | hidden | of hidden, rejected | keep rate of the rest |", "|---|---|---|---|");
  for (const c of a.counterfactual) out.push(`| ${c.t2.toFixed(2)} | ${pct(c.hidden)} | ${pct(c.hiddenRejected)} | ${pct(c.keepAfter)} |`);
  out.push("");
  out.push(
    a.chosen
      ? `Suggested cdhfShowAbove: **${a.chosen.t2.toFixed(2)}** (hides ${pct(a.chosen.hidden)}, ${pct(a.chosen.hiddenRejected)} of them rejected).`
      : "No threshold keeps the hidden ghosts mostly rejected; keep the default cdhfShowAbove.",
  );
  out.push("");
  out.push("Caveat (as in the paper): this is retrospective. Outcomes exist only for ghosts that were shown, so the counterfactual says nothing about ghosts a policy hid; only the live table compares that.");
  return out.join("\n") + "\n";
}
