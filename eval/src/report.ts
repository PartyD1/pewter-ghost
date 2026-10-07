/**
 * Run summaries and markdown reports (eval/reports/<name>.md).
 *
 *  - summarize(cases, config): the headline numbers of one run
 *  - runReport(run): one run as markdown (summary table, stage and kind
 *    breakdowns, variety per session, per-case table)
 *  - compareReport(a, b): two runs on the same requests, deltas per measure
 *    and the cases whose first-try verdict flipped
 */
import type { SuggestionKind } from "../../apps/editor/src/contracts";
import { calibrationStats, type CalibrationStats } from "./score/calibration";
import { scoreLatency, type LatencyScore } from "./score/latency";
import { scoreVariety, type VarietyScore } from "./score/variety";
import type { CaseResult, RunConfig, RunResult } from "./types";

export interface Summary {
  cases: number;
  scored: number;
  skipped: number;
  errors: number;
  /** Share of scored calls whose every sample parsed. */
  schemaOk: number;
  acted: number;
  declined: number;
  /** Share of acting answers with every coordinate check passed. */
  coordAccuracy: number;
  /** Mean per-item coordinate share over acting answers. */
  coordItemShare: number;
  /** Items answered in level coordinates (total). */
  levelCoordItems: number;
  /** Share of acting answers passing the validator. */
  validatorPass: number;
  /** Share of acting answers verified on the first try (validator + rules + agent). */
  playFirstTry: number;
  stages: Record<string, number>;
  agentTimeouts: number;
  sendBacks: number;
  sendBackPass: number;
  /** Share of acting answers verified after at most one send-back. */
  playAfterSendBack: number;
  expectMet: number;
  expectN: number;
  kinds: Partial<Record<SuggestionKind, number>>;
  variety: VarietyScore;
  latency: LatencyScore;
  /** Stated confidence vs first-try (a quick calibration look). */
  calibration: CalibrationStats;
  meanConfidence: number;
  promptTokens: number;
  outputTokens: number;
  cached: number;
}

const share = (num: number, den: number) => (den ? num / den : 0);
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(results: readonly CaseResult[], cfg: Pick<RunConfig, "callTimeoutMs">): Summary {
  const scored = results.filter((r) => !r.skipped);
  const called = scored.filter((r) => !r.error);
  const acting = called.filter((r) => r.act === true);
  const verified = acting.filter((r) => r.firstTryOk !== undefined);
  const stages: Record<string, number> = {};
  for (const r of verified) stages[r.firstStage ?? "?"] = (stages[r.firstStage ?? "?"] ?? 0) + 1;
  const kinds: Partial<Record<SuggestionKind, number>> = {};
  for (const r of acting) if (r.kind) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const sendBacks = verified.filter((r) => r.sendBack);
  const withExpect = called.filter((r) => r.expectMet !== undefined);
  const conf = verified.filter((r) => r.confidence?.stated !== undefined);
  return {
    cases: results.length,
    scored: scored.length,
    skipped: results.length - scored.length,
    errors: scored.filter((r) => r.error).length,
    schemaOk: share(called.filter((r) => r.schemaOk).length, scored.length),
    acted: acting.length,
    declined: called.filter((r) => r.act === false).length,
    coordAccuracy: share(acting.filter((r) => r.coord?.accurate).length, acting.length),
    coordItemShare: mean(acting.map((r) => r.coord?.share ?? 0)),
    levelCoordItems: acting.reduce((a, r) => a + (r.coord?.levelCoords ?? 0), 0),
    validatorPass: share(verified.filter((r) => r.validatorStage === "ok").length, acting.length),
    playFirstTry: share(verified.filter((r) => r.firstTryOk).length, acting.length),
    stages,
    agentTimeouts: verified.filter((r) => r.agentTimedOut).length,
    sendBacks: sendBacks.length,
    sendBackPass: share(sendBacks.filter((r) => r.sendBackOk).length, sendBacks.length),
    playAfterSendBack: share(verified.filter((r) => r.firstTryOk || r.sendBackOk).length, acting.length),
    expectMet: share(withExpect.filter((r) => r.expectMet).length, withExpect.length),
    expectN: withExpect.length,
    kinds,
    variety: scoreVariety(
      called.map((r) => ({ sessionId: r.sessionId, seq: r.seq, act: r.act, kind: r.kind, label: r.label, tags: r.tags, history: r.history })),
    ),
    latency: scoreLatency(
      called.map((r) => r.latencyMs),
      cfg.callTimeoutMs,
    ),
    calibration: calibrationStats(conf.map((r) => ({ confidence: r.confidence!.stated!, label: !!r.firstTryOk }))),
    meanConfidence: mean(conf.map((r) => r.confidence!.stated!)),
    promptTokens: mean(called.filter((r) => r.promptTokens).map((r) => r.promptTokens!)),
    outputTokens: mean(called.filter((r) => r.outputTokens).map((r) => r.outputTokens!)),
    cached: called.filter((r) => r.cached).length,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "n/a");
export const ms = (v: number) => `${Math.round(v)} ms`;
const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : v === Infinity ? "inf" : "n/a");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The headline rows: [label, formatted value, raw value, higher-is-better]. */
export function headline(s: Summary): [string, string, number, boolean][] {
  return [
    ["Playability first try (of acting answers)", pct(s.playFirstTry), s.playFirstTry, true],
    ["Playable after one send-back", pct(s.playAfterSendBack), s.playAfterSendBack, true],
    ["Send-back pass rate", `${pct(s.sendBackPass)} (${s.sendBacks} sent back)`, s.sendBackPass, true],
    ["Schema ok", pct(s.schemaOk), s.schemaOk, true],
    ["Coordinate accuracy (all checks)", pct(s.coordAccuracy), s.coordAccuracy, true],
    ["Coordinate item share", pct(s.coordItemShare), s.coordItemShare, true],
    ["Validator pass", pct(s.validatorPass), s.validatorPass, true],
    ["Expectation met (seed labels)", `${pct(s.expectMet)} of ${s.expectN}`, s.expectMet, true],
    ["Acted / declined", `${s.acted} / ${s.declined}`, s.acted, true],
    ["Distinct tags per session", num(s.variety.distinctPerSession, 1), s.variety.distinctPerSession, true],
    ["Tag three times running (violations)", `${s.variety.violations}${s.variety.pass ? " (pass)" : " (FAIL)"}`, s.variety.violations, false],
    ["Extends repeating the last two accepted", String(s.variety.historyRepeats), s.variety.historyRepeats, false],
    ["Tag novelty vs previous answer", num(s.variety.tagNovelty), s.variety.tagNovelty, true],
    ["Latency p50 / p90", `${ms(s.latency.p50)} / ${ms(s.latency.p90)}`, s.latency.p50, false],
    [`Within call budget (${s.latency.budgetMs} ms)`, pct(s.latency.withinBudget), s.latency.withinBudget, true],
    ["Stated confidence AUC vs first try", num(s.calibration.auc), s.calibration.auc, true],
    ["Mean stated confidence", num(s.meanConfidence), s.meanConfidence, true],
    ["Prompt / output tokens (mean)", `${Math.round(s.promptTokens)} / ${Math.round(s.outputTokens)}`, s.promptTokens, false],
    ["Errors / skipped", `${s.errors} / ${s.skipped}`, s.errors, false],
  ];
}

export function configLine(c: RunConfig): string {
  const w = c.window ? `${c.window.cols}x${c.window.rows}` : "as recorded";
  return (
    `model \`${c.model}\`, window ${w}, summary ${c.summary === undefined ? "as recorded" : c.summary ? "on" : "off"}, ` +
    `examples ${c.examples ? "on" : "off"}, brief ${c.compactUser ? "off (compact user message)" : "on"}, ` +
    `confidence ${c.confidenceSource}, samples ${c.samples}, temperature ${c.temperature}, thinking ${c.thinkingBudget ?? "model default"}, ` +
    `send-back ${c.sendBack}, agent cap ${c.agentCapMs} ms, call budget ${c.callTimeoutMs} ms` +
    (c.systemOverride ? `, system prompt override ${c.systemOverride.version}` : "")
  );
}

function caseTable(cases: readonly CaseResult[]): string {
  const rows = [
    "| case | mode | act | kind | label | schema | coords | first try | send-back | tags | conf | ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of cases) {
    if (r.skipped) {
      rows.push(`| ${r.id} | ${r.mode} | skipped: ${esc(r.skipped)} |  |  |  |  |  |  |  |  |  |`);
      continue;
    }
    if (r.error) {
      rows.push(`| ${r.id} | ${r.mode} | error: ${esc(r.error.slice(0, 80))} |  |  |  |  |  |  |  |  | ${r.latencyMs} |`);
      continue;
    }
    const first = r.firstTryOk === undefined ? "" : r.firstTryOk ? "ok" : `${r.firstStage}: ${esc((r.firstReason ?? "").slice(0, 90))}`;
    const sb = r.sendBack ? (r.sendBackOk ? "pass" : "fail") : "";
    const coords = r.coord ? (r.coord.accurate ? "ok" : esc(r.coord.issues.join("; ").slice(0, 80))) : "";
    rows.push(
      `| ${r.id} | ${r.mode} | ${r.act === null ? "?" : r.act} | ${r.kind ?? ""} | ${esc((r.label ?? "").slice(0, 40))} | ${r.schemaOk ? "ok" : esc(r.schemaError ?? "no")} | ${coords} | ${first} | ${sb} | ${(r.tags ?? []).join(", ")} | ${r.confidence?.used !== undefined ? r.confidence.used.toFixed(2) : ""} | ${r.latencyMs} |`,
    );
  }
  return rows.join("\n");
}

export function runReport(run: RunResult, title = `Suite run: ${run.config.name}`): string {
  const s = run.summary;
  const out: string[] = [];
  out.push(`# ${title}`, "");
  out.push(`- Prompt \`${run.promptVersion}\`; ${configLine(run.config)}.`);
  out.push(`- ${s.cases} cases (${s.scored} scored, ${s.skipped} skipped, ${s.errors} call errors, ${s.cached} from cache). Run ${run.startedAt} to ${run.finishedAt}.`);
  out.push("");
  out.push("## Summary", "", "| measure | value |", "|---|---|");
  for (const [k, v] of headline(s)) out.push(`| ${k} | ${v} |`);
  out.push("");
  out.push("## First-try verdict by stage", "", "| stage | answers |", "|---|---|");
  for (const [k, v] of Object.entries(s.stages).sort((a, b) => b[1] - a[1])) out.push(`| ${k} | ${v} |`);
  out.push(`\nAgent over its cap on ${s.agentTimeouts} answer(s) (counted as fails, as in the app).`, "");
  out.push("## Kinds", "", "| kind | answers |", "|---|---|");
  for (const [k, v] of Object.entries(s.kinds)) out.push(`| ${k} | ${v} |`);
  out.push("");
  out.push("## Variety per session (G-25)", "", "| session | answers | distinct tags | longest run | 3-in-a-row | history repeats | tag novelty |", "|---|---|---|---|---|---|---|");
  for (const v of s.variety.sessions)
    out.push(
      `| ${v.sessionId} | ${v.answers} | ${v.distinct} (${v.tags.join(", ")}) | ${v.longestRun ? `${v.longestRun.tag} x${v.longestRun.length}` : "-"} | ${v.violations.map((x) => `${x.tag} x${x.length}`).join(", ") || "none"} | ${v.historyRepeats} | ${num(v.tagNovelty)} |`,
    );
  out.push("");
  out.push("## Stated confidence vs first try", "", "| band | n | first-try rate |", "|---|---|---|");
  for (const b of s.calibration.bands) out.push(`| ${b.name} [${b.lo}, ${b.hi}) | ${b.n} | ${pct(b.rate)} |`);
  out.push("");
  out.push("## Cases", "", caseTable(run.cases), "");
  return out.join("\n");
}

export function compareReport(a: RunResult, b: RunResult, title = `Compare: ${a.config.name} vs ${b.config.name}`): string {
  const out: string[] = [`# ${title}`, ""];
  out.push(`- A: \`${a.config.name}\` prompt \`${a.promptVersion}\`; ${configLine(a.config)}.`);
  out.push(`- B: \`${b.config.name}\` prompt \`${b.promptVersion}\`; ${configLine(b.config)}.`);
  const ids = new Set(a.cases.filter((c) => !c.skipped).map((c) => c.id));
  const common = b.cases.filter((c) => !c.skipped && ids.has(c.id)).map((c) => c.id);
  out.push(`- ${common.length} requests scored by both.`, "");
  const keep = new Set(common);
  const sa = summarize(a.cases.filter((c) => keep.has(c.id)), a.config);
  const sb = summarize(b.cases.filter((c) => keep.has(c.id)), b.config);
  const ha = headline(sa);
  const hb = headline(sb);
  out.push("| measure | A | B | delta | |", "|---|---|---|---|---|");
  ha.forEach(([label, va, ra, better], i) => {
    const [, vb, rb] = hb[i];
    const d = rb - ra;
    const isRate = /%/.test(va) || /%/.test(vb);
    const dTxt = !Number.isFinite(d) ? "n/a" : isRate ? `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)} pt` : `${d >= 0 ? "+" : ""}${num(d)}`;
    const verdict = !Number.isFinite(d) || Math.abs(d) < 1e-9 ? "" : (d > 0) === better ? "better" : "worse";
    out.push(`| ${label} | ${va} | ${vb} | ${dTxt} | ${verdict} |`);
  });
  out.push("");
  const byB = new Map(b.cases.map((c) => [c.id, c]));
  const flips = a.cases
    .filter((c) => keep.has(c.id))
    .map((c) => [c, byB.get(c.id)!] as const)
    .filter(([x, y]) => (x.firstTryOk ?? null) !== (y.firstTryOk ?? null));
  out.push("## First-try changes", "");
  if (!flips.length) out.push("None.");
  else {
    out.push("| case | A | B |", "|---|---|---|");
    const v = (r: CaseResult) => (r.firstTryOk === undefined ? (r.act === false ? "declined" : r.error ? "error" : "-") : r.firstTryOk ? "ok" : `fail (${r.firstStage})`);
    for (const [x, y] of flips) out.push(`| ${x.id} | ${v(x)} | ${v(y)} |`);
  }
  const gate = sb.playFirstTry >= sa.playFirstTry && !(sb.calibration.auc < sa.calibration.auc - 0.05);
  out.push("", `**Ship gate** (B must not lower playability-first-try or flatten calibration): ${gate ? "PASS" : "FAIL"}.`, "");
  return out.join("\n");
}
