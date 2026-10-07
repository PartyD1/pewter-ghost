/**
 * Live runner: calls the model straight through proxy/src/gemini.ts (no proxy
 * server, no browser) with the prompt from fill/prompt.ts renderFillPrompt.
 *
 *  - concurrency-limited (`limit`)
 *  - cached on disk by (rendered prompt, model, sampling config) so reruns of
 *    the same request and configuration are free (eval/.cache/calls)
 *  - retries 429 / 5xx / network errors with backoff
 *  - only runs when VITE_LLM_API_KEY (or GEMINI_API_KEY) is set; the key is
 *    never printed, logged or written: GeminiUpstream scrubs it from errors
 *    and this module only ever reports whether one is set
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RenderedPrompt } from "../../apps/editor/src/contracts";
import { canonicalJson } from "../../apps/editor/src/research/hash";
import { GeminiUpstream } from "../../proxy/src/gemini";
import { UpstreamError, type Upstream } from "../../proxy/src/upstream";
import type { CallResult } from "./types";

export interface CallOptions {
  temperature: number;
  samples: 1 | 2;
}

/** Anything that turns a rendered prompt into model text. */
export interface ModelCaller {
  readonly model: string;
  /** Extra settings that change the answer (part of the cache key). */
  readonly settings: Record<string, unknown>;
  call(prompt: RenderedPrompt, o: CallOptions): Promise<CallResult>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Cache key: the exact prompt plus everything that changes the answer. */
export function callKey(prompt: RenderedPrompt, model: string, o: CallOptions, settings: Record<string, unknown> = {}): string {
  return sha256(
    canonicalJson({
      system: sha256(prompt.system),
      user: sha256(prompt.user),
      schema: sha256(canonicalJson(prompt.responseSchema)),
      model,
      temperature: o.temperature,
      samples: o.samples,
      settings,
    }),
  );
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryable(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) return false;
  if (e.kind === "network") return true;
  if (e.kind === "http" && e.status !== undefined) return e.status === 429 || e.status >= 500;
  return false;
}

/** Wraps any proxy Upstream (GeminiUpstream or a test fake). */
export class UpstreamCaller implements ModelCaller {
  readonly model: string;
  readonly settings: Record<string, unknown>;
  private readonly retry: Required<RetryOptions>;
  private readonly clock: () => number;

  constructor(
    private readonly upstream: Upstream,
    o: { settings?: Record<string, unknown>; retry?: RetryOptions; clock?: () => number } = {},
  ) {
    this.model = upstream.model;
    this.settings = o.settings ?? {};
    this.retry = { retries: o.retry?.retries ?? 3, baseDelayMs: o.retry?.baseDelayMs ?? 1500, sleep: o.retry?.sleep ?? defaultSleep };
    this.clock = o.clock ?? (() => performance.now());
  }

  async call(prompt: RenderedPrompt, o: CallOptions): Promise<CallResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retry.retries; attempt++) {
      const t0 = this.clock();
      try {
        const r = await this.upstream.generate({ prompt, temperature: o.temperature, samples: o.samples });
        const out: CallResult = {
          texts: r.texts,
          latencyMs: Math.round(this.clock() - t0),
          model: r.model,
          promptVersion: prompt.promptVersion,
        };
        if (r.logprob !== undefined) out.logprob = r.logprob;
        if (r.usage) out.usage = r.usage;
        if (r.sampleErrors?.some((e) => e)) out.error = r.sampleErrors.filter(Boolean).join("; ");
        return out;
      } catch (e) {
        lastErr = e;
        if (attempt < this.retry.retries && retryable(e)) {
          await this.retry.sleep(this.retry.baseDelayMs * 2 ** attempt);
          continue;
        }
        return {
          texts: [],
          latencyMs: Math.round(this.clock() - t0),
          model: this.model,
          promptVersion: prompt.promptVersion,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    return { texts: [], latencyMs: 0, model: this.model, promptVersion: prompt.promptVersion, error: String(lastErr) };
  }
}

/** On-disk cache of call results, one JSON file per key. */
export class CallCache {
  hits = 0;
  misses = 0;
  constructor(readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(key: string): CallResult | undefined {
    const f = this.file(key);
    if (!existsSync(f)) {
      this.misses++;
      return undefined;
    }
    try {
      const r = JSON.parse(readFileSync(f, "utf8")) as CallResult;
      this.hits++;
      return { ...r, cached: true };
    } catch {
      this.misses++;
      return undefined;
    }
  }

  set(key: string, r: CallResult): void {
    const f = this.file(key);
    mkdirSync(path.dirname(f), { recursive: true });
    const { cached: _c, ...rest } = r;
    writeFileSync(f, JSON.stringify(rest));
  }
}

/** Run async jobs with at most `n` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * A caller with a cache in front. Failed calls are not cached (a rerun
 * retries them) unless `cacheErrors` is set.
 */
export class CachedCaller implements ModelCaller {
  constructor(
    private readonly inner: ModelCaller,
    readonly cache: CallCache,
    private readonly o: { cacheErrors?: boolean; refresh?: boolean } = {},
  ) {}
  get model(): string {
    return this.inner.model;
  }
  get settings(): Record<string, unknown> {
    return this.inner.settings;
  }
  async call(prompt: RenderedPrompt, o: CallOptions): Promise<CallResult> {
    const key = callKey(prompt, this.inner.model, o, this.inner.settings);
    if (!this.o.refresh) {
      const hit = this.cache.get(key);
      if (hit) return hit;
    }
    const r = await this.inner.call(prompt, o);
    if (!r.error || this.o.cacheErrors) this.cache.set(key, r);
    return r;
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface LiveEnv {
  VITE_LLM_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PROXY_UPSTREAM_TIMEOUT_MS?: string;
  PROXY_THINKING_BUDGET?: string;
  PROXY_LOGPROBS?: string;
}

/** Load .env.local / .env from the project root into process.env (Node >= 20.12), silently. */
export function loadDotEnv(root: string): void {
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  for (const name of [".env.local", ".env"]) {
    const p = path.join(root, name);
    if (existsSync(p)) {
      try {
        loader(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/** True when a model key is available. Never returns or prints the key itself. */
export const hasApiKey = (env: LiveEnv = process.env): boolean => !!(env.VITE_LLM_API_KEY || env.GEMINI_API_KEY);

export interface GeminiCallerOptions {
  model: string;
  /** null = model default thinking; 0 = off (the app's proxy setting). */
  thinkingBudget: number | null;
  timeoutMs?: number;
  logprobs?: boolean;
  fetch?: typeof fetch;
  retry?: RetryOptions;
}

/** A live Gemini caller from the environment. Throws when no key is set. */
export function geminiCaller(o: GeminiCallerOptions, env: LiveEnv = process.env): UpstreamCaller {
  const apiKey = env.VITE_LLM_API_KEY || env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("no model key: set VITE_LLM_API_KEY to run live");
  const timeout = Number(env.PROXY_UPSTREAM_TIMEOUT_MS);
  const upstream = new GeminiUpstream({
    apiKey,
    model: o.model,
    fetch: o.fetch,
    timeoutMs: o.timeoutMs ?? (Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000),
    thinkingBudget: o.thinkingBudget,
    logprobs: o.logprobs ?? env.PROXY_LOGPROBS !== "0",
  });
  return new UpstreamCaller(upstream, { settings: { thinkingBudget: o.thinkingBudget }, retry: o.retry });
}
