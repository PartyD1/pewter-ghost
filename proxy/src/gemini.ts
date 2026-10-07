/**
 * Gemini generateContent upstream (JSON mode, pinned model).
 *
 * - POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 * - key in the `x-goog-api-key` header only; never in URLs, logs or errors
 * - generationConfig: responseMimeType application/json, responseSchema,
 *   temperature, responseLogprobs (dropped for good if the API rejects it),
 *   optional thinkingConfig (also dropped if rejected)
 * - samples = 2 -> two parallel calls (more portable than candidateCount)
 * - one deadline for the whole call, including a fallback retry
 */
import type { RenderedPrompt } from "../../apps/editor/src/contracts";
import { UpstreamError, type Upstream, type UpstreamRequest, type UpstreamResult } from "./upstream";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_MODEL = "gemini-3.7-flash";

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  /** Whole-call deadline in ms (default 10 000). */
  timeoutMs?: number;
  baseUrl?: string;
  /** Ask for token log-probabilities (default true; disabled automatically if rejected). */
  logprobs?: boolean;
  /** thinkingConfig.thinkingBudget; null/undefined = do not send thinkingConfig. */
  thinkingBudget?: number | null;
  maxOutputTokens?: number;
}

export interface GeminiBodyOptions {
  temperature: number;
  logprobs: boolean;
  thinkingBudget?: number | null;
  maxOutputTokens?: number;
}

/** The exact request body sent to generateContent. Exported for tests and eval. */
export function buildGeminiBody(prompt: RenderedPrompt, o: GeminiBodyOptions): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: prompt.responseSchema,
    temperature: o.temperature,
    candidateCount: 1,
  };
  if (o.maxOutputTokens) generationConfig.maxOutputTokens = o.maxOutputTokens;
  if (o.logprobs) generationConfig.responseLogprobs = true;
  if (o.thinkingBudget !== undefined && o.thinkingBudget !== null)
    generationConfig.thinkingConfig = { thinkingBudget: o.thinkingBudget };
  return {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: "user", parts: [{ text: prompt.user }] }],
    generationConfig,
  };
}

interface GeminiCandidate {
  content?: { parts?: { text?: string; thought?: boolean }[] };
  finishReason?: string;
  avgLogprobs?: number;
  logprobsResult?: { chosenCandidates?: { logProbability?: number }[] };
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

/** Text of the first candidate (thought parts skipped), or null. */
export function extractText(r: GeminiResponse): string | null {
  const parts = r.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) return null;
  const text = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  return text.length ? text : null;
}

/** Mean token log-probability of the first candidate, if present. */
export function extractLogprob(r: GeminiResponse): number | undefined {
  const c = r.candidates?.[0];
  if (!c) return undefined;
  if (typeof c.avgLogprobs === "number" && Number.isFinite(c.avgLogprobs)) return c.avgLogprobs;
  const chosen = c.logprobsResult?.chosenCandidates;
  if (Array.isArray(chosen) && chosen.length) {
    const vals = chosen.map((x) => x.logProbability).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return undefined;
}

export class GeminiUpstream implements Upstream {
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly maxOutputTokens?: number;
  /** Flipped off permanently when the API rejects the field. */
  logprobsEnabled: boolean;
  thinkingBudget: number | null;

  constructor(opts: GeminiOptions) {
    if (!opts.apiKey) throw new UpstreamError("config", "no model API key configured");
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
    if (!/^[A-Za-z0-9._-]+$/.test(this.model)) throw new UpstreamError("config", "invalid model id");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.baseUrl = (opts.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
    this.logprobsEnabled = opts.logprobs ?? true;
    this.thinkingBudget = opts.thinkingBudget ?? null;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  get url(): string {
    return `${this.baseUrl}/models/${this.model}:generateContent`;
  }

  async generate(req: UpstreamRequest): Promise<UpstreamResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      if (req.samples === 2) {
        const settled = await Promise.allSettled([this.once(req, ctrl.signal), this.once(req, ctrl.signal)]);
        const ok = settled.filter((s): s is PromiseFulfilledResult<GeminiResponse> => s.status === "fulfilled");
        if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
        const texts = settled.map((s) => (s.status === "fulfilled" ? extractText(s.value) : null));
        const sampleErrors = settled.map((s) => (s.status === "rejected" ? errMessage(s.reason, this.apiKey) : null));
        const first = ok[0].value;
        return {
          texts,
          logprob: settled[0].status === "fulfilled" ? extractLogprob(settled[0].value) : undefined,
          model: this.model,
          sampleErrors: sampleErrors.some((e) => e) ? sampleErrors : undefined,
          usage: usageOf(first),
        };
      }
      const r = await this.once(req, ctrl.signal);
      return { texts: [extractText(r)], logprob: extractLogprob(r), model: this.model, usage: usageOf(r) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One generateContent call. On a 400 that blames an optional field
   * (responseLogprobs, thinkingConfig) the field is dropped for good and the
   * call retried. On any other 400 while optional fields were sent, the call is
   * retried once without them; they are disabled for good only if that works.
   */
  private async once(req: UpstreamRequest, signal: AbortSignal): Promise<GeminiResponse> {
    let plain = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const logprobs = this.logprobsEnabled && !plain;
      const thinking = plain ? null : this.thinkingBudget;
      const body = buildGeminiBody(req.prompt, {
        temperature: req.temperature,
        logprobs,
        thinkingBudget: thinking,
        maxOutputTokens: this.maxOutputTokens,
      });
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new UpstreamError("timeout", `upstream timeout after ${this.timeoutMs} ms`);
        throw new UpstreamError("network", `upstream network error: ${errMessage(e, this.apiKey)}`);
      }
      let json: GeminiResponse;
      try {
        json = (await res.json()) as GeminiResponse;
      } catch {
        if (signal.aborted) throw new UpstreamError("timeout", `upstream timeout after ${this.timeoutMs} ms`);
        throw new UpstreamError("bad-response", `upstream ${res.status}: body is not JSON`, res.status);
      }
      if (res.ok) {
        if (plain) {
          // The plain body worked where the full one did not: stop sending extras.
          this.logprobsEnabled = false;
          this.thinkingBudget = null;
        }
        return json;
      }
      const msg = scrub(json?.error?.message ?? res.statusText ?? "", this.apiKey).slice(0, 300);
      if (res.status === 400) {
        const m = msg.toLowerCase();
        if (logprobs && m.includes("logprob")) {
          this.logprobsEnabled = false;
          continue;
        }
        if (thinking !== null && m.includes("thinking")) {
          this.thinkingBudget = null;
          continue;
        }
        if (!plain && (logprobs || thinking !== null)) {
          plain = true;
          continue;
        }
      }
      throw new UpstreamError("http", `upstream ${res.status}: ${msg}`, res.status);
    }
    throw new UpstreamError("http", "upstream rejected the request after dropping optional fields");
  }
}

function usageOf(r: GeminiResponse): UpstreamResult["usage"] {
  const u = r.usageMetadata;
  return u ? { promptTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount } : undefined;
}

function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

function errMessage(e: unknown, key: string): string {
  return scrub(e instanceof Error ? e.message : String(e), key);
}

export interface GeminiEnv {
  VITE_LLM_API_KEY?: string;
  GEMINI_API_KEY?: string;
  VITE_LLM_MODEL_NAME?: string;
  PROXY_UPSTREAM_TIMEOUT_MS?: string;
  PROXY_THINKING_BUDGET?: string;
  PROXY_LOGPROBS?: string;
}

/** Build the upstream from env vars. Throws UpstreamError("config") when no key is set. */
export function geminiFromEnv(env: GeminiEnv, fetchImpl?: typeof fetch): GeminiUpstream {
  const apiKey = env.VITE_LLM_API_KEY || env.GEMINI_API_KEY || "";
  const timeout = Number(env.PROXY_UPSTREAM_TIMEOUT_MS);
  const budget = env.PROXY_THINKING_BUDGET;
  return new GeminiUpstream({
    apiKey,
    model: env.VITE_LLM_MODEL_NAME || DEFAULT_MODEL,
    fetch: fetchImpl,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    thinkingBudget: budget !== undefined && budget !== "" && Number.isFinite(Number(budget)) ? Number(budget) : null,
    logprobs: env.PROXY_LOGPROBS === "0" ? false : true,
  });
}
