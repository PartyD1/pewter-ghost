/**
 * OpenRouter chat/completions upstream. Serves both OpenRouter and BayLeaf
 * (https://api.bayleaf.dev, UCSC's free OpenRouter front end), which speak the same API.
 *
 * - POST <baseUrl>/chat/completions, key in `Authorization: Bearer` only; never in URLs, logs or errors
 * - response_format: json_schema (the prompt's schema translated from Gemini's subset),
 *   stepping down to json_object, then none, if the model rejects it
 * - logprobs and `reasoning` (OpenRouter's thinking switch) are optional and dropped for good if rejected
 *   (as is temperature, which some reasoning models refuse)
 * - samples = 2 -> two parallel calls; one deadline for the whole call
 */
import type { RenderedPrompt } from "../../apps/editor/src/contracts";
import { UpstreamError, type Upstream, type UpstreamRequest, type UpstreamResult } from "./upstream";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const BAYLEAF_BASE_URL = "https://api.bayleaf.dev/v1";
export const OPENROUTER_DEFAULT_MODEL = "z-ai/glm-5.3-flash";
export const BAYLEAF_DEFAULT_MODEL = "openrouter:z-ai/glm-5.3-flash";

export type ResponseFormatMode = "json_schema" | "json_object" | "none";
const FORMAT_STEPS: ResponseFormatMode[] = ["json_schema", "json_object", "none"];

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Name used in error messages ("openrouter", "bayleaf"). */
  provider?: string;
  fetch?: typeof fetch;
  /** Whole-call deadline in ms (default 10 000). */
  timeoutMs?: number;
  /** Ask for token log-probabilities (default true; disabled automatically if rejected). */
  logprobs?: boolean;
  /** OpenRouter `reasoning` object ({ enabled: false }, { effort: "low" }, ...); null/undefined = not sent. */
  reasoning?: Record<string, unknown> | null;
  maxOutputTokens?: number;
}

export interface OpenRouterBodyOptions {
  model: string;
  temperature: number | null;
  format: ResponseFormatMode;
  logprobs: boolean;
  reasoning?: Record<string, unknown> | null;
  maxOutputTokens?: number;
}

/**
 * Gemini's responseSchema subset -> plain JSON Schema: lower-case type names,
 * no propertyOrdering. Everything else passes through.
 */
export function toJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "propertyOrdering") continue;
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object")
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, ps]) => [p, toJsonSchema(ps)]));
    else out[k] = toJsonSchema(v);
  }
  return out;
}

/** The exact request body sent to chat/completions. Exported for tests. */
export function buildOpenRouterBody(prompt: RenderedPrompt, o: OpenRouterBodyOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  };
  if (o.temperature !== null) body.temperature = o.temperature;
  if (o.format === "json_schema")
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "fill_answer", schema: toJsonSchema(prompt.responseSchema), strict: false },
    };
  else if (o.format === "json_object") body.response_format = { type: "json_object" };
  if (o.maxOutputTokens) body.max_completion_tokens = o.maxOutputTokens;
  if (o.logprobs) body.logprobs = true;
  if (o.reasoning) body.reasoning = o.reasoning;
  return body;
}

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
  logprobs?: { content?: { logprob?: number }[] | null } | null;
}
interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string | number } | string;
}

/** Text of the first choice, or null. */
export function extractChatText(r: ChatResponse): string | null {
  const t = r.choices?.[0]?.message?.content;
  return typeof t === "string" && t.length ? t : null;
}

/** Mean token log-probability of the first choice, if present. */
export function extractChatLogprob(r: ChatResponse): number | undefined {
  const toks = r.choices?.[0]?.logprobs?.content;
  if (!Array.isArray(toks) || !toks.length) return undefined;
  const vals = toks.map((t) => t.logprob).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
}

export class OpenRouterUpstream implements Upstream {
  readonly model: string;
  readonly provider: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly maxOutputTokens?: number;
  /** Flipped off permanently when the API rejects the field. */
  logprobsEnabled: boolean;
  reasoning: Record<string, unknown> | null;
  temperatureEnabled = true;
  format: ResponseFormatMode = "json_schema";

  constructor(opts: OpenRouterOptions) {
    this.provider = opts.provider ?? "openrouter";
    if (!opts.apiKey) throw new UpstreamError("config", `no ${this.provider} API key configured`);
    if (!opts.model || /\s/.test(opts.model)) throw new UpstreamError("config", "invalid model id");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.logprobsEnabled = opts.logprobs ?? true;
    this.reasoning = opts.reasoning ?? null;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  get url(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  async generate(req: UpstreamRequest): Promise<UpstreamResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      if (req.samples === 2) {
        const settled = await Promise.allSettled([this.once(req, ctrl.signal), this.once(req, ctrl.signal)]);
        const ok = settled.filter((s): s is PromiseFulfilledResult<ChatResponse> => s.status === "fulfilled");
        if (ok.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
        const texts = settled.map((s) => (s.status === "fulfilled" ? extractChatText(s.value) : null));
        const sampleErrors = settled.map((s) => (s.status === "rejected" ? errMessage(s.reason, this.apiKey) : null));
        return {
          texts,
          logprob: settled[0].status === "fulfilled" ? extractChatLogprob(settled[0].value) : undefined,
          model: this.model,
          sampleErrors: sampleErrors.some((e) => e) ? sampleErrors : undefined,
          usage: usageOf(ok[0].value),
        };
      }
      const r = await this.once(req, ctrl.signal);
      return { texts: [extractChatText(r)], logprob: extractChatLogprob(r), model: this.model, usage: usageOf(r) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One chat/completions call. On a 400 that blames an optional field the
   * field is dropped for good and the call retried. On any other 400 the call
   * is retried with response_format stepped down (json_schema -> json_object
   * -> none) and then without logprobs/reasoning; a step is kept for good only
   * if the retry works.
   */
  private async once(req: UpstreamRequest, signal: AbortSignal): Promise<ChatResponse> {
    let format = this.format;
    let plain = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const logprobs = this.logprobsEnabled && !plain;
      const reasoning = plain ? null : this.reasoning;
      const body = buildOpenRouterBody(req.prompt, {
        model: this.model,
        temperature: this.temperatureEnabled ? req.temperature : null,
        format,
        logprobs,
        reasoning,
        maxOutputTokens: this.maxOutputTokens,
      });
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new UpstreamError("timeout", `upstream timeout after ${this.timeoutMs} ms`);
        throw new UpstreamError("network", `upstream network error: ${errMessage(e, this.apiKey)}`);
      }
      let json: ChatResponse;
      try {
        json = (await res.json()) as ChatResponse;
      } catch {
        if (signal.aborted) throw new UpstreamError("timeout", `upstream timeout after ${this.timeoutMs} ms`);
        throw new UpstreamError("bad-response", `upstream ${res.status}: body is not JSON`, res.status);
      }
      if (res.ok && !json.error) {
        // A stepped-down body worked where the fuller one did not: keep it.
        this.format = format;
        if (plain) {
          this.logprobsEnabled = false;
          this.reasoning = null;
        }
        return json;
      }
      const raw = typeof json?.error === "string" ? json.error : (json?.error?.message ?? res.statusText ?? "");
      const msg = scrub(raw, this.apiKey).slice(0, 300);
      if (res.status === 400 || res.status === 422) {
        const m = msg.toLowerCase();
        if (logprobs && m.includes("logprob")) {
          this.logprobsEnabled = false;
          continue;
        }
        if (reasoning && m.includes("reasoning")) {
          // A model that must think refuses "off": think as little as it allows instead.
          this.reasoning = reasoning.enabled === false ? { effort: "minimal", exclude: true } : null;
          continue;
        }
        if (this.temperatureEnabled && m.includes("temperature")) {
          this.temperatureEnabled = false;
          continue;
        }
        if (format !== "none" && /response_format|json_schema|json_object|structured|schema/.test(m)) {
          format = this.format = FORMAT_STEPS[FORMAT_STEPS.indexOf(format) + 1];
          continue;
        }
        if (format !== "none") {
          format = FORMAT_STEPS[FORMAT_STEPS.indexOf(format) + 1];
          continue;
        }
        if (!plain && (logprobs || reasoning)) {
          plain = true;
          continue;
        }
      }
      throw new UpstreamError("http", `${this.provider} ${res.status}: ${msg}`, res.status);
    }
    throw new UpstreamError("http", "upstream rejected the request after dropping optional fields");
  }
}

function usageOf(r: ChatResponse): UpstreamResult["usage"] {
  const u = r.usage;
  return u ? { promptTokens: u.prompt_tokens, outputTokens: u.completion_tokens } : undefined;
}

function scrub(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

function errMessage(e: unknown, key: string): string {
  return scrub(e instanceof Error ? e.message : String(e), key);
}
