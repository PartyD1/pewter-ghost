/**
 * G-28 model and window-size selection: run the suite over models x window
 * sizes (each with and without the one-line summary of the rest of the
 * level) and choose the smallest model and window meeting the targets.
 *
 * Models are listed smallest first; windows are sorted by area. Only cases
 * with a full level can be rebuilt for another window, so recordings without
 * one are skipped by the cells whose window differs.
 */
import { pct, ms } from "./report";
import type { RunConfig, RunResult } from "./types";

export interface MatrixTargets {
  playFirstTry: number;
  coordAccuracy: number;
  schemaOk: number;
  /** p50 latency budget, ms. */
  latencyP50Ms: number;
}

export const DEFAULT_TARGETS: MatrixTargets = { playFirstTry: 0.6, coordAccuracy: 0.8, schemaOk: 0.95, latencyP50Ms: 1000 };

export interface MatrixCell {
  model: string;
  window: { cols: number; rows: number };
  summary: boolean;
  run: RunResult;
  meetsQuality: boolean;
  meetsLatency: boolean;
}

export interface MatrixPlan {
  models: string[];
  windows: { cols: number; rows: number }[];
  summaries: boolean[];
}

/** The configs of a matrix, in model order then window area then summary. */
export function matrixConfigs(base: RunConfig, plan: MatrixPlan): RunConfig[] {
  const windows = [...plan.windows].sort((a, b) => a.cols * a.rows - b.cols * b.rows);
  const out: RunConfig[] = [];
  for (const model of plan.models)
    for (const w of windows)
      for (const summary of plan.summaries)
        out.push({ ...base, model, window: w, summary, name: `${model}-${w.cols}x${w.rows}-${summary ? "sum" : "nosum"}` });
  return out;
}

export function judgeCell(run: RunResult, t: MatrixTargets): { meetsQuality: boolean; meetsLatency: boolean } {
  const s = run.summary;
  return {
    meetsQuality: s.playFirstTry >= t.playFirstTry && s.coordAccuracy >= t.coordAccuracy && s.schemaOk >= t.schemaOk,
    meetsLatency: s.latency.n > 0 && s.latency.p50 <= t.latencyP50Ms,
  };
}

/** First cell (smallest model, then smallest window) meeting every target; else the first meeting quality. */
export function chooseCell(cells: readonly MatrixCell[]): { cell?: MatrixCell; why: string } {
  const all = cells.find((c) => c.meetsQuality && c.meetsLatency);
  if (all) return { cell: all, why: "smallest model and window meeting every target" };
  const q = cells.find((c) => c.meetsQuality);
  if (q) return { cell: q, why: "no configuration meets the latency target; smallest meeting the quality targets" };
  const best = [...cells].sort((a, b) => b.run.summary.playFirstTry - a.run.summary.playFirstTry)[0];
  return { cell: best, why: "no configuration meets the quality targets; highest playability first try shown" };
}

export function matrixMarkdown(cells: readonly MatrixCell[], t: MatrixTargets, title = "Model and window-size matrix (G-28)"): string {
  const out: string[] = [`# ${title}`, ""];
  out.push(
    `Targets: playability first try >= ${pct(t.playFirstTry)}, coordinate accuracy >= ${pct(t.coordAccuracy)}, schema ok >= ${pct(t.schemaOk)}, latency p50 <= ${t.latencyP50Ms} ms.`,
    "",
  );
  out.push(
    "| model | window | summary | scored | play first try | after send-back | coords | schema | distinct tags/session | p50 | p90 | prompt tok | quality | latency |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const c of cells) {
    const s = c.run.summary;
    out.push(
      `| ${c.model} | ${c.window.cols}x${c.window.rows} | ${c.summary ? "on" : "off"} | ${s.scored - s.errors} | ${pct(s.playFirstTry)} | ${pct(s.playAfterSendBack)} | ${pct(s.coordAccuracy)} | ${pct(s.schemaOk)} | ${s.variety.distinctPerSession.toFixed(1)} | ${ms(s.latency.p50)} | ${ms(s.latency.p90)} | ${Math.round(s.promptTokens)} | ${c.meetsQuality ? "yes" : "no"} | ${c.meetsLatency ? "yes" : "no"} |`,
    );
  }
  const { cell, why } = chooseCell(cells);
  out.push("");
  out.push(cell ? `**Choice:** \`${cell.model}\` with ${cell.window.cols}x${cell.window.rows}, summary ${cell.summary ? "on" : "off"} (${why}). Pin it in the proxy (VITE_LLM_MODEL_NAME) and suggest/config windowCols/windowRows.` : "**Choice:** none.");
  out.push("");
  return out.join("\n");
}
