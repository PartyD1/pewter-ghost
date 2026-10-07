/**
 * G-38 export: (request, accepted answer) pairs as JSONL for fine-tuning a
 * small model behind the same filler.
 *
 * Sources:
 *  - logs + recordings: the answer behind every accepted ghost (and, with
 *    `includePartial`, partially accepted ones), joined by suggestion id
 *  - a suite run: answers that passed verification on the first try
 *    (with `fromRun`), using the request the run's config sent
 *
 * Formats:
 *  - gemini: Vertex AI supervised tuning lines
 *      {"systemInstruction":{...},"contents":[{"role":"user",...},{"role":"model",...}]}
 *  - openai: {"messages":[{"role":"system"},{"role":"user"},{"role":"assistant"}]}
 *  - raw:    {"request", "answer", "source", "sessionId", "requestHash", ...}
 * The prompt is rendered with fill/prompt.ts renderFillPrompt, the answer with
 * answerJson (the key order the few-shots use). Pairs are deduplicated by
 * requestHash. The system prompt is ~8k tokens: `system: "none"` drops it.
 */
import type { FillRequest, ModelAnswer } from "../../apps/editor/src/contracts";
import { answerJson, PROMPT_VERSION, renderFillPrompt } from "../../apps/editor/src/fill/prompt";
import { ACCEPTED, ghostsOf, type SessionLog } from "./logs";

export type ExportFormat = "gemini" | "openai" | "raw";

export interface ExportPair {
  request: FillRequest;
  answer: ModelAnswer;
  requestHash: string;
  source: "accepted" | "partial" | "suite";
  sessionId?: string;
  promptVersion?: string;
  model?: string;
}

export interface ExportOptions {
  format?: ExportFormat;
  system?: "full" | "none";
  includePartial?: boolean;
}

/** Accepted ghosts joined to their recordings. */
export function pairsFromLogs(sessions: readonly SessionLog[], o: Pick<ExportOptions, "includePartial"> = {}): ExportPair[] {
  const out: ExportPair[] = [];
  for (const s of sessions)
    for (const g of ghostsOf(s, { tag: false })) {
      if (!ACCEPTED.has(g.outcome) || !g.recording?.answer) continue;
      if (g.outcome === "partial" && !o.includePartial) continue;
      out.push({
        request: g.recording.request,
        answer: g.recording.answer,
        requestHash: g.recording.requestHash,
        source: g.outcome === "partial" ? "partial" : "accepted",
        sessionId: s.sessionId,
        promptVersion: g.recording.promptVersion,
        model: g.recording.model,
      });
    }
  return out;
}

/** Suite answers that verified first try. `requests` maps case id -> the request the run sent. */
export function pairsFromRun(
  run: { cases: readonly { id: string; sessionId: string; requestHash: string; firstTryOk?: boolean; answer?: ModelAnswer | null }[]; promptVersion: string; config: { model: string } },
  requests: ReadonlyMap<string, FillRequest>,
): ExportPair[] {
  const out: ExportPair[] = [];
  for (const c of run.cases) {
    const req = requests.get(c.id);
    if (!c.firstTryOk || !c.answer || !req) continue;
    out.push({ request: req, answer: c.answer, requestHash: c.requestHash, source: "suite", sessionId: c.sessionId, promptVersion: run.promptVersion, model: run.config.model });
  }
  return out;
}

export function dedupe(pairs: readonly ExportPair[]): ExportPair[] {
  const seen = new Set<string>();
  return pairs.filter((p) => (seen.has(p.requestHash) ? false : (seen.add(p.requestHash), true)));
}

/** One JSONL line for a pair. */
export function exportLine(p: ExportPair, o: ExportOptions = {}): string {
  const format = o.format ?? "gemini";
  if (format === "raw") {
    return JSON.stringify({
      requestHash: p.requestHash,
      source: p.source,
      sessionId: p.sessionId,
      promptVersion: p.promptVersion ?? PROMPT_VERSION,
      model: p.model,
      request: p.request,
      answer: p.answer,
    });
  }
  const prompt = renderFillPrompt(p.request);
  const answer = answerJson(p.answer);
  const withSystem = (o.system ?? "full") === "full";
  if (format === "openai") {
    const messages = [
      ...(withSystem ? [{ role: "system", content: prompt.system }] : []),
      { role: "user", content: prompt.user },
      { role: "assistant", content: answer },
    ];
    return JSON.stringify({ messages });
  }
  const line: Record<string, unknown> = {
    contents: [
      { role: "user", parts: [{ text: prompt.user }] },
      { role: "model", parts: [{ text: answer }] },
    ],
  };
  if (withSystem) line.systemInstruction = { role: "system", parts: [{ text: prompt.system }] };
  return JSON.stringify(line);
}

export function exportJsonl(pairs: readonly ExportPair[], o: ExportOptions = {}): string {
  const lines = dedupe(pairs).map((p) => exportLine(p, o));
  return lines.length ? lines.join("\n") + "\n" : "";
}
