/**
 * Picks the model provider behind /fill from the environment.
 *
 *   LLM_PROVIDER=gemini | openrouter | bayleaf
 *
 * Unset: the first provider with a key, in that order (Gemini first, so
 * existing setups keep working). Each provider has its own key and model vars,
 * so switching LLM_PROVIDER never sends one provider's model id to another:
 *
 *   gemini      VITE_LLM_API_KEY or GEMINI_API_KEY; VITE_LLM_MODEL_NAME or GEMINI_MODEL
 *   openrouter  OPENROUTER_API_KEY; OPENROUTER_MODEL
 *   bayleaf     BAYLEAF_API_KEY (default "campus": works on the UCSC network); BAYLEAF_MODEL
 *
 * Shared: PROXY_UPSTREAM_TIMEOUT_MS, PROXY_LOGPROBS=0, PROXY_THINKING_BUDGET
 * (0 = thinking off; for OpenRouter/BayLeaf sent as reasoning.enabled=false, N as reasoning.max_tokens),
 * PROXY_REASONING_EFFORT (OpenRouter/BayLeaf: reasoning.effort, e.g. "low"; wins over the budget).
 */
import { DEFAULT_MODEL, geminiFromEnv, type GeminiEnv } from "./gemini";
import { BAYLEAF_BASE_URL, BAYLEAF_DEFAULT_MODEL, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL, OpenRouterUpstream } from "./openrouter";
import { UpstreamError, type Upstream } from "./upstream";

export const PROVIDERS = ["gemini", "openrouter", "bayleaf"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ProviderEnv extends GeminiEnv {
  LLM_PROVIDER?: string;
  GEMINI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  BAYLEAF_API_KEY?: string;
  BAYLEAF_MODEL?: string;
  PROXY_REASONING_EFFORT?: string;
}

/** The chosen provider. Throws UpstreamError("config") on an unknown LLM_PROVIDER. */
export function providerFromEnv(env: ProviderEnv): Provider {
  const named = env.LLM_PROVIDER?.trim().toLowerCase();
  if (named) {
    if ((PROVIDERS as readonly string[]).includes(named)) return named as Provider;
    throw new UpstreamError("config", `unknown LLM_PROVIDER "${named}" (use ${PROVIDERS.join(", ")})`);
  }
  if (env.VITE_LLM_API_KEY || env.GEMINI_API_KEY) return "gemini";
  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (env.BAYLEAF_API_KEY) return "bayleaf";
  return "gemini";
}

/** The model id the chosen provider will use (for logs and the "unconfigured" stub). */
export function modelFromEnv(env: ProviderEnv, provider = providerFromEnv(env)): string {
  if (provider === "openrouter") return env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;
  if (provider === "bayleaf") return env.BAYLEAF_MODEL || BAYLEAF_DEFAULT_MODEL;
  return env.VITE_LLM_MODEL_NAME || env.GEMINI_MODEL || DEFAULT_MODEL;
}

/** True when the chosen provider has what it needs to make calls. Never returns the key. */
export function hasProviderKey(env: ProviderEnv): boolean {
  try {
    const p = providerFromEnv(env);
    if (p === "openrouter") return !!env.OPENROUTER_API_KEY;
    if (p === "bayleaf") return true; // "campus" works without a key on the UCSC network
    return !!(env.VITE_LLM_API_KEY || env.GEMINI_API_KEY);
  } catch {
    return false;
  }
}

/** The key of the chosen provider, for the dist/ key scan only. */
export function configuredKey(env: ProviderEnv): string | undefined {
  try {
    const p = providerFromEnv(env);
    if (p === "openrouter") return env.OPENROUTER_API_KEY;
    if (p === "bayleaf") return env.BAYLEAF_API_KEY;
    return env.VITE_LLM_API_KEY || env.GEMINI_API_KEY;
  } catch {
    return undefined;
  }
}

/** Build the chosen upstream. Throws UpstreamError("config") when it cannot be configured. */
export function upstreamFromEnv(env: ProviderEnv, fetchImpl?: typeof fetch): Upstream {
  const provider = providerFromEnv(env);
  const model = modelFromEnv(env, provider);
  if (provider === "gemini") return geminiFromEnv({ ...env, VITE_LLM_MODEL_NAME: model }, fetchImpl);
  const timeout = Number(env.PROXY_UPSTREAM_TIMEOUT_MS);
  return new OpenRouterUpstream({
    provider,
    apiKey: provider === "openrouter" ? env.OPENROUTER_API_KEY || "" : env.BAYLEAF_API_KEY || "campus",
    baseUrl: provider === "openrouter" ? OPENROUTER_BASE_URL : BAYLEAF_BASE_URL,
    model,
    fetch: fetchImpl,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    logprobs: env.PROXY_LOGPROBS !== "0",
    reasoning: reasoningFromEnv(env),
  });
}

/** OpenRouter's `reasoning` object from PROXY_REASONING_EFFORT / PROXY_THINKING_BUDGET; null = not sent. */
export function reasoningFromEnv(env: ProviderEnv): Record<string, unknown> | null {
  const effort = env.PROXY_REASONING_EFFORT?.trim();
  if (effort) return { effort, exclude: true };
  const budget = env.PROXY_THINKING_BUDGET;
  if (budget === undefined || budget === "" || !Number.isFinite(Number(budget))) return null;
  return Number(budget) <= 0 ? { enabled: false } : { max_tokens: Number(budget), exclude: true };
}
