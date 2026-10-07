/**
 * Cloudflare Worker entry. Bindings (see proxy/wrangler.toml.example):
 *   PEWTER_KV  KV namespace: recordings, logs, and tokens under `tokens/<token>`
 *   PEWTER_R2  optional R2 bucket: used for recordings/logs instead of KV when bound
 * Vars / secrets:
 *   VITE_LLM_API_KEY or GEMINI_API_KEY (secret), VITE_LLM_MODEL_NAME,
 *   PROXY_TOKENS (JSON token file), PROXY_OPEN ("1" accepts token "dev"),
 *   ALLOWED_ORIGINS (comma list; localhost always allowed),
 *   PROXY_UPSTREAM_TIMEOUT_MS, PROXY_THINKING_BUDGET, PROXY_LOGPROBS
 */
import { renderFillPrompt, parseModelAnswer } from "@app/fill/prompt";
import { geminiFromEnv, type GeminiEnv } from "./gemini";
import { createHandler, originAllowList, type ProxyHandler } from "./handler";
import {
  ChainTokenStore,
  entryToInfo,
  isWellFormedToken,
  parseTokenFile,
  StaticTokenStore,
  type TokenEntry,
  type TokenStore,
} from "./sessions";
import { ChunkedObjectStore, kvObjects, MemoryStore, r2Objects, type KVNamespaceLike, type ProxyStore, type R2BucketLike } from "./store";
import { UpstreamError, type Upstream } from "./upstream";

export interface WorkerEnv extends GeminiEnv {
  PEWTER_KV?: KVNamespaceLike;
  PEWTER_R2?: R2BucketLike;
  PROXY_TOKENS?: string;
  PROXY_OPEN?: string;
  ALLOWED_ORIGINS?: string;
}

interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

class KvTokenStore implements TokenStore {
  constructor(private readonly kv: KVNamespaceLike) {}
  async lookup(token: string) {
    if (!isWellFormedToken(token)) return null;
    const raw = await this.kv.get(`tokens/${token}`, "text");
    if (!raw) return null;
    try {
      return await entryToInfo(token, JSON.parse(raw) as TokenEntry);
    } catch {
      return null;
    }
  }
}

let cached: { env: WorkerEnv; handler: ProxyHandler } | null = null;

export function buildWorkerHandler(env: WorkerEnv): ProxyHandler {
  let upstream: Upstream;
  try {
    upstream = geminiFromEnv(env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    upstream = {
      model: env.VITE_LLM_MODEL_NAME || "unconfigured",
      generate: async () => {
        throw new UpstreamError("config", msg);
      },
    };
  }
  let store: ProxyStore;
  if (env.PEWTER_R2) store = new ChunkedObjectStore(r2Objects(env.PEWTER_R2));
  else if (env.PEWTER_KV) store = new ChunkedObjectStore(kvObjects(env.PEWTER_KV));
  else store = new MemoryStore(); // nothing bound: recordings are lost (logged below)

  const stores: TokenStore[] = [];
  let staticFile = { tokens: {} as Record<string, TokenEntry> };
  if (env.PROXY_TOKENS) {
    try {
      staticFile = parseTokenFile(env.PROXY_TOKENS);
    } catch (e) {
      console.error(`[proxy] PROXY_TOKENS unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  stores.push(new StaticTokenStore(staticFile, env.PROXY_OPEN === "1"));
  if (env.PEWTER_KV) stores.push(new KvTokenStore(env.PEWTER_KV));
  if (!env.PEWTER_R2 && !env.PEWTER_KV) console.error("[proxy] no KV/R2 binding: recordings are not persisted");

  return createHandler({
    render: renderFillPrompt,
    parse: parseModelAnswer,
    upstream,
    store,
    tokens: new ChainTokenStore(stores),
    allowOrigin: originAllowList(env.ALLOWED_ORIGINS),
    onError: (m) => console.error(`[proxy] ${m}`),
  });
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    if (!cached || cached.env !== env) cached = { env, handler: buildWorkerHandler(env) };
    return cached.handler(request, { waitUntil: (p) => ctx.waitUntil(p) });
  },
};
