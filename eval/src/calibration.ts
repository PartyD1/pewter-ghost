/**
 * G-27 confidence calibration experiment.
 *
 * On the same requests, compare three confidence sources against an outcome:
 *   stated     the model's own confidence number
 *   logprob    exp(mean token log-probability) when the API exposes it
 *   twoSample  agreement of two samples (shared cells / union)
 * The outcome is acceptance from the logs when the request was shown to a
 * person (joined by requestHash), otherwise "verified on the first try" (the
 * suite's proxy for a good ghost). Each source gets a curve (rate per bin and
 * per app band) and a steepness (AUC - 0.5); the steepest wins and sets
 * showNowAbove / showAtPauseAbove from its curve.
 */
import { CONFIDENCE_BANDS } from "../../apps/editor/src/suggest/config";
import { calibrationStats, suggestThresholds, type CalibrationStats, type CalPoint } from "./score/calibration";
import { pct } from "./report";
import type { CaseResult, ConfidenceSource, RunResult } from "./types";

export interface SourceCalibration {
  source: ConfidenceSource;
  n: number;
  stats: CalibrationStats;
  thresholds: { showNowAbove?: number; showAtPauseAbove?: number };
}

export interface CalibrationReport {
  labelSource: "logs" | "verified" | "mixed";
  labelsFromLogs: number;
  sources: SourceCalibration[];
  /** Steepest source with enough points, or undefined. */
  pick?: ConfidenceSource;
  /** Plan target: top band acceptance >= 1.5x the bottom band. */
  meetsTarget: boolean;
  minN: number;
}

export interface CalibrateOptions {
  /** requestHash -> accepted (from logs). */
  labels?: ReadonlyMap<string, boolean>;
  minN?: number;
  nowRate?: number;
  pauseRate?: number;
}

const SOURCES: ConfidenceSource[] = ["stated", "logprob", "twoSample"];

export function calibrate(results: readonly CaseResult[], o: CalibrateOptions = {}): CalibrationReport {
  const minN = o.minN ?? 5;
  const edges = { ...CONFIDENCE_BANDS };
  let fromLogs = 0;
  let fromVerify = 0;
  const labelled: { r: CaseResult; label: boolean }[] = [];
  for (const r of results) {
    if (r.act !== true || !r.confidence) continue;
    const logLabel = o.labels?.get(r.requestHash);
    if (logLabel !== undefined) {
      fromLogs++;
      labelled.push({ r, label: logLabel });
    } else if (r.firstTryOk !== undefined) {
      fromVerify++;
      labelled.push({ r, label: r.firstTryOk });
    }
  }
  const sources: SourceCalibration[] = SOURCES.map((source) => {
    const pts: CalPoint[] = labelled
      .filter(({ r }) => r.confidence?.[source] !== undefined)
      .map(({ r, label }) => ({ confidence: r.confidence![source]!, label }));
    return {
      source,
      n: pts.length,
      stats: calibrationStats(pts, edges),
      thresholds: suggestThresholds(pts, { nowRate: o.nowRate, pauseRate: o.pauseRate, minN }),
    };
  });
  const eligible = sources.filter((s) => s.n >= minN);
  const pick = eligible.length ? eligible.reduce((a, b) => (b.stats.steepness > a.stats.steepness ? b : a)).source : undefined;
  const picked = sources.find((s) => s.source === pick);
  return {
    labelSource: fromLogs && fromVerify ? "mixed" : fromLogs ? "logs" : "verified",
    labelsFromLogs: fromLogs,
    sources,
    pick,
    meetsTarget: !!picked && picked.stats.bandRatio >= 1.5,
    minN,
  };
}

const n2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : v === Infinity ? "inf" : "n/a");

export function calibrationMarkdown(rep: CalibrationReport, run?: Pick<RunResult, "config" | "promptVersion">): string {
  const out: string[] = ["# Confidence calibration (G-27)", ""];
  if (run) out.push(`- Run \`${run.config.name}\`, prompt \`${run.promptVersion}\`, model \`${run.config.model}\`, samples ${run.config.samples}, temperature ${run.config.temperature}.`);
  out.push(
    `- Outcome: ${rep.labelSource === "logs" ? "acceptance from the logs" : rep.labelSource === "mixed" ? `acceptance from the logs (${rep.labelsFromLogs}) and verified-first-try for the rest` : "verified on the first try (no log outcomes joined; the suite's proxy for acceptance)"}.`,
  );
  out.push(`- Steepness = AUC - 0.5 (how much better than chance the source ranks good answers). Sources need at least ${rep.minN} points.`, "");
  out.push("| source | n | AUC | steepness | high/low band | top/bottom tertile | slope | Brier | ECE | suggested showNowAbove | suggested showAtPauseAbove |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of rep.sources)
    out.push(
      `| ${s.source}${s.source === rep.pick ? " (pick)" : ""} | ${s.n} | ${n2(s.stats.auc)} | ${n2(s.stats.steepness)} | ${n2(s.stats.bandRatio)} | ${n2(s.stats.tertileRatio)} | ${n2(s.stats.slope)} | ${n2(s.stats.brier)} | ${n2(s.stats.ece)} | ${s.thresholds.showNowAbove ?? "-"} | ${s.thresholds.showAtPauseAbove ?? "-"} |`,
    );
  out.push("");
  for (const s of rep.sources) {
    out.push(`## ${s.source}`, "");
    if (!s.n) {
      out.push(s.source === "logprob" ? "No log-probabilities (the model rejects responseLogprobs; the proxy drops it)." : "No points.", "");
      continue;
    }
    out.push("| confidence bin | n | rate | mean confidence | curve |", "|---|---|---|---|---|");
    for (const b of s.stats.bins)
      out.push(`| ${b.lo.toFixed(1)}-${b.hi.toFixed(1)} | ${b.n} | ${b.n ? pct(b.rate) : "-"} | ${b.n ? b.meanConfidence.toFixed(2) : "-"} | ${b.n ? "#".repeat(Math.round(b.rate * 20)) : ""} |`);
    out.push("", "| app band | n | rate |", "|---|---|---|");
    for (const b of s.stats.bands) out.push(`| ${b.name} [${b.lo}, ${b.hi}) | ${b.n} | ${b.n ? pct(b.rate) : "-"} |`);
    out.push("");
  }
  out.push(
    `**Pick:** ${rep.pick ?? "none (not enough points)"}. Target (top band >= 1.5x bottom band): ${rep.meetsTarget ? "met" : "not met"}.`,
    "",
  );
  return out.join("\n");
}
