/**
 * The suite runner (G-20): replay cases through one configuration and score
 * every answer.
 *
 *   1. request per case (rebuilt for another window size when needed)
 *   2. model calls, concurrency-limited and cached (live.ts), or the recorded
 *      answers when config.model === "recorded"
 *   3. scoring, one case at a time (the in-process agent shares the event
 *      loop, so verification is sequential): schema, coordinates, validator,
 *      rules + agent first try, send-back, pattern tags, confidence
 */
import type { FillRequest, ModelAnswer, RenderedPrompt, Suggestion } from "../../apps/editor/src/contracts";
import { renderFillPrompt, renderUserMessage, PROMPT_VERSION } from "../../apps/editor/src/fill/prompt";
import { convertModelAnswer } from "../../apps/editor/src/fill/answer";
import { logprobConfidence, sampleAgreement } from "../../apps/editor/src/fill/LLMFiller";
import { config as liveConfig, DEFAULT_CONFIG } from "../../apps/editor/src/suggest/config";
import type { AgentLike } from "../../apps/editor/src/verify/playability";
import { hashRequest, levelFor, requestFor } from "./cases";
import { mapLimit, type ModelCaller } from "./live";
import { summarize } from "./report";
import { scoreCoords } from "./score/coords";
import { scoreSchema } from "./score/schema";
import { blockedFromRequest, scoreVerification } from "./score/verify";
import type { CallResult, CaseResult, EvalCase, RunConfig, RunResult } from "./types";

export const DEFAULT_RUN_CONFIG: RunConfig = {
  name: "default",
  model: DEFAULT_CONFIG.model,
  confidenceSource: "stated",
  samples: 1,
  temperature: 0.2,
  thinkingBudget: 0,
  sendBack: "always",
  agentCapMs: DEFAULT_CONFIG.agentCapMs,
  callTimeoutMs: DEFAULT_CONFIG.callTimeoutMs,
};

export interface RunDeps {
  /** Live (or fake) model; required unless config.model is "recorded". */
  caller?: ModelCaller;
  agent: AgentLike;
  concurrency?: number;
  /** Progress lines (no secrets ever pass through here). */
  log?: (line: string) => void;
  now?: () => Date;
}

/** The prompt a config sends for a request. */
export function renderFor(req: FillRequest, cfg: Pick<RunConfig, "compactUser" | "systemOverride">): RenderedPrompt {
  const p = renderFillPrompt(req);
  if (cfg.compactUser) p.user = renderUserMessage(req, { compact: true });
  if (cfg.systemOverride) {
    p.system = cfg.systemOverride.text;
    p.promptVersion = cfg.systemOverride.version;
  }
  return p;
}

/** Samples a config asks for (twoSample needs two). */
export const samplesFor = (cfg: Pick<RunConfig, "samples" | "confidenceSource">): 1 | 2 =>
  cfg.confidenceSource === "twoSample" ? 2 : cfg.samples;

/** The recorded answer of a case as a CallResult. */
export function recordedCall(c: EvalCase): CallResult | null {
  const r = c.recorded;
  if (!r) return null;
  const parsed: (ModelAnswer | null)[] = r.answers && r.answers.length ? r.answers : [r.answer];
  const out: CallResult = {
    texts: r.raw ?? parsed.map(() => null),
    parsed,
    latencyMs: r.latencyMs,
    model: r.model,
    promptVersion: r.promptVersion,
  };
  if (r.logprob !== undefined) out.logprob = r.logprob;
  if (r.error) out.error = r.error;
  return out;
}

interface Prepared {
  c: EvalCase;
  req: FillRequest | null;
  prompt?: RenderedPrompt;
  skipped?: string;
}

function expectMet(c: EvalCase, act: boolean | null, kind?: string): boolean | undefined {
  const e = c.expect;
  if (!e || (e.act === undefined && !e.kinds)) return undefined;
  if (act === null) return false;
  if (e.act !== undefined && act !== e.act) return false;
  if (act && e.kinds && kind && !e.kinds.includes(kind as never)) return false;
  return true;
}

/** Score one case given its call result. */
export async function scoreCase(
  c: EvalCase,
  req: FillRequest,
  call: CallResult,
  cfg: RunConfig,
  deps: RunDeps,
): Promise<CaseResult> {
  const base: CaseResult = {
    id: c.id,
    sessionId: c.sessionId,
    seq: c.seq,
    family: c.family,
    mode: req.mode,
    requestHash: hashRequest(req),
    latencyMs: call.latencyMs,
    schemaOk: false,
    act: null,
    cells: 0,
    dropped: 0,
    history: req.lastGhosts,
  };
  if (call.cached) base.cached = true;
  if (call.usage?.promptTokens) base.promptTokens = call.usage.promptTokens;
  if (call.usage?.outputTokens) base.outputTokens = call.usage.outputTokens;
  if (!call.texts.length && !call.parsed?.length) {
    base.error = call.error ?? "no answer";
    return base;
  }
  const schema = scoreSchema(call);
  base.schemaOk = schema.ok;
  if (!schema.ok) base.schemaError = schema.errors.find(Boolean);
  const answer = schema.answers[0] ?? null;
  base.answer = answer;
  if (!answer) {
    base.expectMet = expectMet(c, null);
    return base;
  }
  base.act = answer.act;
  base.label = answer.label;
  if (answer.levelGuess) base.levelGuess = answer.levelGuess;
  base.expectMet = expectMet(c, answer.act, answer.kind);

  // Confidence from every source available.
  const conf: NonNullable<CaseResult["confidence"]> = { stated: answer.act ? answer.confidence : 0 };
  if (call.logprob !== undefined) conf.logprob = logprobConfidence(call.logprob);
  if (schema.answers.length >= 2) conf.twoSample = sampleAgreement(schema.answers[0], schema.answers[1]);
  conf.used = conf[cfg.confidenceSource] ?? conf.stated;
  base.confidence = conf;
  if (!answer.act) return base;

  base.kind = answer.kind;
  base.cells = answer.adds.length + answer.removes.length + answer.entities.length;
  const level = levelFor(c);
  base.coord = scoreCoords(answer, req, level);
  const conv = convertModelAnswer(answer, req, { filler: "llm", requestHash: base.requestHash, latencyMs: call.latencyMs, id: `eval-${c.id}` });
  base.dropped = conv.dropped.length;
  if (!conv.suggestion) {
    base.validatorStage = "shape";
    base.firstTryOk = false;
    base.firstStage = "shape";
    base.firstReason = "nothing usable left after converting the answer (all cells outside the window or invalid)";
    return base;
  }

  // Send-back: the model sees the failure reason once.
  const gate = cfg.sendBack === "always" ? Number.POSITIVE_INFINITY : cfg.sendBack === "never" ? -1 : liveConfig.sendBackIfUnderMs;
  const sendBackFiller = {
    fill: async (retry: FillRequest): Promise<Suggestion | null> => {
      if (!deps.caller || cfg.model === "recorded") return null;
      const r = await deps.caller.call(renderFor(retry, cfg), { temperature: cfg.temperature, samples: 1 });
      if (r.error && !r.texts.length) throw new Error(r.error);
      const a = scoreSchema(r).answers[0];
      if (!a) return null;
      return convertModelAnswer(a, retry, { filler: "llm", requestHash: hashRequest(retry), latencyMs: r.latencyMs, attempts: 2, id: `eval-${c.id}-2` }).suggestion;
    },
  };
  const blocked = c.blocked ?? blockedFromRequest(req, level);
  const v = await scoreVerification(level, req, conv.suggestion, sendBackFiller, {
    agent: deps.agent,
    agentCapMs: cfg.agentCapMs,
    sendBackIfUnderMs: gate,
    blocked,
  });
  base.validatorStage = v.validatorStage;
  base.tags = v.tags;
  base.firstTryOk = v.firstTryOk;
  base.firstStage = v.firstStage;
  if (v.firstReason) base.firstReason = v.firstReason;
  base.agentTimedOut = v.agentTimedOut;
  base.sendBack = v.sendBack;
  if (v.sendBackOk !== undefined) base.sendBackOk = v.sendBackOk;
  return base;
}

/** Run a configuration over cases. */
export async function runSuite(cases: readonly EvalCase[], cfg: RunConfig, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const startedAt = now().toISOString();
  const recorded = cfg.model === "recorded";
  if (!recorded && !deps.caller) throw new Error("runSuite: a model caller is needed unless model is 'recorded'");

  const prepared: Prepared[] = cases.map((c) => {
    const req = requestFor(c, cfg);
    if (!req) return { c, req: null, skipped: "cannot rebuild this request for the configured window (no full level)" };
    if (recorded && !c.recorded) return { c, req, skipped: "no recorded answer" };
    return { c, req, prompt: recorded ? undefined : renderFor(req, cfg) };
  });

  let done = 0;
  const calls = await mapLimit(prepared, deps.concurrency ?? 4, async (p) => {
    if (p.skipped || !p.req) return null;
    const r = recorded ? recordedCall(p.c)! : await deps.caller!.call(p.prompt!, { temperature: cfg.temperature, samples: samplesFor(cfg) });
    done++;
    if (!recorded) log(`  [${done}/${prepared.length}] ${p.c.id}: ${r.error ? `error ${r.error.slice(0, 120)}` : `${r.latencyMs} ms${r.cached ? " (cached)" : ""}`}`);
    return r;
  });

  const results: CaseResult[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    if (p.skipped || !p.req) {
      results.push({
        id: p.c.id,
        sessionId: p.c.sessionId,
        seq: p.c.seq,
        family: p.c.family,
        mode: p.c.request.mode,
        requestHash: p.c.requestHash,
        skipped: p.skipped,
        latencyMs: 0,
        schemaOk: false,
        act: null,
        cells: 0,
        dropped: 0,
      });
      continue;
    }
    results.push(await scoreCase(p.c, p.req, calls[i]!, cfg, deps));
  }

  const promptVersion = cfg.systemOverride?.version ?? (recorded ? [...new Set(cases.map((c) => c.recorded?.promptVersion).filter(Boolean))].join(", ") || PROMPT_VERSION : PROMPT_VERSION);
  return { config: cfg, promptVersion, startedAt, finishedAt: now().toISOString(), cases: results, summary: summarize(results, cfg) };
}
