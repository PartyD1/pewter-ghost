/**
 * G-29 dashboard metrics from session logs and saved levels.
 *
 *  - acceptance by kind and by confidence band (accepted + partial / ended)
 *  - drawn-over rate over session time (per minute since the session began)
 *  - verified first try and send-back pass (fill.call verdicts)
 *  - drop rate: calls dropped for time (error mentions a timeout, or slower
 *    than the call budget) and calls whose answer failed verification
 *  - latency of answered calls
 *  - hand repair: a person edit inside an accepted ghost's cells within 60 s
 *  - patterns per session: distinct pattern tags of accepted ghosts
 *  - saved levels through @measure: diversity (mean pairwise expressive
 *    distance), difficulty, and the linearity x leniency expressive range
 */
import type { LevelSnapshot, LogEvent, SuggestionKind } from "../../apps/editor/src/contracts";
import { DEFAULT_CONFIG } from "../../apps/editor/src/suggest/config";
import { expressiveFeatures, expressiveHistogram, measureLevel, meanPairwiseDistance, type ExpressiveFeatures } from "@measure";
import { VALIDATION_BANDS } from "../../apps/editor/src/verify/validate";
import { ACCEPTED, ghostsOf, type GhostRecord, type SessionLog } from "./logs";
import { scoreLatency, type LatencyScore } from "./score/latency";

export interface Rate {
  n: number;
  hits: number;
  rate: number;
}

const rate = (hits: number, n: number): Rate => ({ n, hits, rate: n ? hits / n : 0 });

export interface SessionSummary {
  sessionId: string;
  filler: string;
  model: string;
  promptVersion: string;
  minutes: number;
  shown: number;
  accepted: number;
  drawnOver: number;
  patterns: string[];
  saves: number;
  beatableAtEnd: boolean | null;
}

export interface LevelGroupMetrics {
  group: string;
  levels: number;
  diversity: number;
  meanDifficulty: number;
  maxDifficulty: number;
  meanDistinctPatterns: number;
  features: (ExpressiveFeatures & { name: string })[];
  /** linearity (x) x leniency (y) histogram, counts[y][x]. */
  range: { bins: number; counts: number[][]; coverage: number };
}

export interface SurveyAnswer {
  sessionId: string;
  /** "Did a suggestion give you an idea you would not have had?" */
  idea?: boolean;
  feel?: string;
  annoyed?: string;
}

export interface DashboardMetrics {
  sessions: SessionSummary[];
  ghosts: number;
  acceptance: Rate;
  byKind: Record<SuggestionKind, Rate & { outcomes: Record<string, number> }>;
  byBand: { band: "low" | "mid" | "high"; lo: number; hi: number; r: Rate }[];
  byConfidence: { lo: number; hi: number; r: Rate }[];
  drawnOverByMinute: { minute: number; r: Rate }[];
  drawnOver: Rate;
  verifiedFirstTry: Rate;
  sendBackPass: Rate;
  dropForTime: Rate;
  dropForVerify: Rate;
  latency: LatencyScore;
  handRepair: Rate;
  /** Accepted ghosts without a recording to know their cells. */
  handRepairUnknown: number;
  patternsPerSession: number;
  patternRuns3: number;
  levels: LevelGroupMetrics[];
  survey?: { answers: number; ideaYes: Rate; notes: SurveyAnswer[] };
}

export interface MetricsOptions {
  showAtPauseAbove?: number;
  showNowAbove?: number;
  callTimeoutMs?: number;
}

type FillCall = Extract<LogEvent, { type: "fill.call" }>;

function sessionSummary(s: SessionLog, ghosts: GhostRecord[]): SessionSummary {
  const head = s.events.find((e) => e.type === "session") as Extract<LogEvent, { type: "session" }> | undefined;
  const ts = s.events.map((e) => e.t);
  const minutes = ts.length ? (Math.max(...ts) - Math.min(...ts)) / 60_000 : 0;
  const patrols = s.events.filter((e): e is Extract<LogEvent, { type: "patrol" }> => e.type === "patrol");
  const neutral = VALIDATION_BANDS.neutralTags;
  const patterns = new Set<string>();
  for (const g of ghosts) if (ACCEPTED.has(g.outcome)) for (const t of g.tags ?? []) if (!neutral.includes(t)) patterns.add(t);
  return {
    sessionId: s.sessionId,
    filler: head?.filler ?? "?",
    model: head?.model ?? "?",
    promptVersion: head?.promptVersion ?? "?",
    minutes,
    shown: ghosts.length,
    accepted: ghosts.filter((g) => ACCEPTED.has(g.outcome)).length,
    drawnOver: ghosts.filter((g) => g.outcome === "drawn-over").length,
    patterns: [...patterns].sort(),
    saves: s.events.filter((e) => e.type === "save").length,
    beatableAtEnd: patrols.length ? patrols[patrols.length - 1].beatable : null,
  };
}

/** A tag in 3 consecutive accepted Extend ghosts of a session. */
function runs3(ghosts: GhostRecord[]): number {
  const neutral = VALIDATION_BANDS.neutralTags;
  const ext = ghosts.filter((g) => g.kind === "extend" && ACCEPTED.has(g.outcome));
  let n = 0;
  for (let i = 2; i < ext.length; i++) {
    const [a, b, c] = [ext[i - 2], ext[i - 1], ext[i]].map((g) => new Set((g.tags ?? []).filter((t) => !neutral.includes(t))));
    if ([...c].some((t) => a.has(t) && b.has(t))) n++;
  }
  return n;
}

export function levelGroupMetrics(group: string, levels: readonly { name: string; level: LevelSnapshot }[], bins = 10): LevelGroupMetrics {
  const measured = levels.map((l) => ({ name: l.name, m: measureLevel(l.level) }));
  const feats = measured.map((x) => ({ name: x.name, ...expressiveFeatures(x.m) }));
  const hist = expressiveHistogram(measured.map((x) => x.m), { bins, x: "linearity", y: "leniency" });
  const diffs = measured.map((x) => x.m.aggregate.meanDifficulty);
  return {
    group,
    levels: levels.length,
    diversity: measured.length > 1 ? meanPairwiseDistance(measured.map((x) => x.m)) : 0,
    meanDifficulty: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0,
    maxDifficulty: measured.length ? Math.max(...measured.map((x) => x.m.aggregate.maxDifficulty)) : 0,
    meanDistinctPatterns: measured.length ? measured.reduce((a, x) => a + x.m.aggregate.distinctPatterns, 0) / measured.length : 0,
    features: feats,
    range: { bins, counts: hist.counts, coverage: hist.coverage },
  };
}

export function computeMetrics(
  sessions: readonly SessionLog[],
  levelGroups: readonly { group: string; levels: { name: string; level: LevelSnapshot }[] }[] = [],
  o: MetricsOptions & { survey?: SurveyAnswer[] } = {},
): DashboardMetrics {
  const pauseEdge = o.showAtPauseAbove ?? DEFAULT_CONFIG.showAtPauseAbove;
  const nowEdge = o.showNowAbove ?? DEFAULT_CONFIG.showNowAbove;
  const budget = o.callTimeoutMs ?? DEFAULT_CONFIG.callTimeoutMs;

  const perSession = sessions.map((s) => ({ s, ghosts: ghostsOf(s) }));
  const ghosts = perSession.flatMap((x) => x.ghosts);
  const ended = ghosts.filter((g) => g.outcome !== "pending");

  const kinds: SuggestionKind[] = ["finish", "extend", "fix"];
  const byKind = {} as DashboardMetrics["byKind"];
  for (const k of kinds) {
    const list = ended.filter((g) => g.kind === k);
    const outcomes: Record<string, number> = {};
    for (const g of list) outcomes[g.outcome] = (outcomes[g.outcome] ?? 0) + 1;
    byKind[k] = { ...rate(list.filter((g) => ACCEPTED.has(g.outcome)).length, list.length), outcomes };
  }
  const band = (lo: number, hi: number) => {
    const l = ended.filter((g) => g.confidence >= lo && (g.confidence < hi || (hi >= 1 && g.confidence <= 1)));
    return rate(l.filter((g) => ACCEPTED.has(g.outcome)).length, l.length);
  };
  const byBand: DashboardMetrics["byBand"] = [
    { band: "low", lo: 0, hi: pauseEdge, r: band(0, pauseEdge) },
    { band: "mid", lo: pauseEdge, hi: nowEdge, r: band(pauseEdge, nowEdge) },
    { band: "high", lo: nowEdge, hi: 1, r: band(nowEdge, 1) },
  ];
  const byConfidence: DashboardMetrics["byConfidence"] = [];
  for (let i = 0; i < 10; i++) byConfidence.push({ lo: i / 10, hi: (i + 1) / 10, r: band(i / 10, (i + 1) / 10) });

  // Drawn-over by minute since the session's first event.
  const minutes = new Map<number, { n: number; hits: number }>();
  for (const { s, ghosts: gs } of perSession) {
    const t0 = s.events.length ? Math.min(...s.events.map((e) => e.t)) : 0;
    for (const g of gs) {
      if (g.outcome === "pending") continue;
      const m = Math.floor((g.shownAt - t0) / 60_000);
      const b = minutes.get(m) ?? { n: 0, hits: 0 };
      b.n++;
      if (g.outcome === "drawn-over") b.hits++;
      minutes.set(m, b);
    }
  }
  const drawnOverByMinute = [...minutes].sort((a, b) => a[0] - b[0]).map(([minute, b]) => ({ minute, r: rate(b.hits, b.n) }));

  const calls = sessions.flatMap((s) => s.events.filter((e): e is FillCall => e.type === "fill.call"));
  const live = calls.filter((c) => !c.superseded);
  const acted = live.filter((c) => c.act === true);
  const verdicted = acted.filter((c) => c.verdictStage !== undefined);
  const timedOut = (c: FillCall) => (c.error ? /time ?out/i.test(c.error) : false) || c.latencyMs > budget;
  const sendBacks = verdicted.filter((c) => c.sendBack);

  const accepted = ghosts.filter((g) => ACCEPTED.has(g.outcome));
  const known = accepted.filter((g) => g.repaired !== undefined);

  let survey: DashboardMetrics["survey"];
  if (o.survey && o.survey.length) {
    const withIdea = o.survey.filter((a) => a.idea !== undefined);
    survey = { answers: o.survey.length, ideaYes: rate(withIdea.filter((a) => a.idea).length, withIdea.length), notes: o.survey };
  }

  const summaries = perSession.map(({ s, ghosts: gs }) => sessionSummary(s, gs));
  return {
    sessions: summaries,
    ghosts: ghosts.length,
    acceptance: rate(ended.filter((g) => ACCEPTED.has(g.outcome)).length, ended.length),
    byKind,
    byBand,
    byConfidence,
    drawnOverByMinute,
    drawnOver: rate(ended.filter((g) => g.outcome === "drawn-over").length, ended.length),
    verifiedFirstTry: rate(verdicted.filter((c) => c.verdictStage === "ok" && !c.sendBack).length, verdicted.length),
    sendBackPass: rate(sendBacks.filter((c) => c.verdictStage === "ok").length, sendBacks.length),
    dropForTime: rate(live.filter(timedOut).length, live.length),
    dropForVerify: rate(verdicted.filter((c) => c.verdictStage !== "ok").length, verdicted.length),
    latency: scoreLatency(
      live.filter((c) => c.act !== null && !c.error).map((c) => c.latencyMs),
      budget,
    ),
    handRepair: rate(known.filter((g) => g.repaired).length, known.length),
    handRepairUnknown: accepted.length - known.length,
    patternsPerSession: summaries.length ? summaries.reduce((a, s) => a + s.patterns.length, 0) / summaries.length : 0,
    patternRuns3: perSession.reduce((a, x) => a + runs3(x.ghosts), 0),
    levels: levelGroups.map((g) => levelGroupMetrics(g.group, g.levels)),
    survey,
  };
}
