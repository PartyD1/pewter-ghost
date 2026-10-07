/**
 * Dev proxy: node:http on port 8787 (PROXY_PORT), files under proxy/.data.
 *
 *   npm run proxy                    # tokens from proxy/.data/tokens.json
 *   PROXY_OPEN=1 npm run proxy       # also accept the token "dev"
 *
 * Env: VITE_LLM_API_KEY (or GEMINI_API_KEY), VITE_LLM_MODEL_NAME,
 * PROXY_UPSTREAM_TIMEOUT_MS, PROXY_THINKING_BUDGET, PROXY_LOGPROBS=0,
 * PROXY_ALLOWED_ORIGINS (comma list, localhost always allowed), PROXY_HOST.
 * `.env` / `.env.local` at the project root are loaded if present. The key is
 * never printed.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFillPrompt, parseModelAnswer } from "@app/fill/prompt";
import { geminiFromEnv } from "./gemini";
import { createHandler, originAllowList } from "./handler";
import { FileStore } from "./node/fileStore";
import { FileTokenStore } from "./node/fileTokens";
import { startServer } from "./node/nodeAdapter";
import { UpstreamError, type Upstream } from "./upstream";

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, "..");
const projectRoot = path.resolve(proxyDir, "..");
export const DATA_DIR = path.join(proxyDir, ".data");

function loadDotEnv(): void {
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  // .env.local first: loadEnvFile never overrides variables that are already set.
  for (const name of [".env.local", ".env"]) {
    const p = path.join(projectRoot, name);
    if (existsSync(p)) {
      try {
        loader(p);
      } catch {
        /* ignore malformed env files */
      }
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = process.env;
  const log = (m: string) => console.error(`[proxy] ${m}`);
  let upstream: Upstream;
  try {
    upstream = geminiFromEnv(env);
  } catch (e) {
    // Still serve /session and /log without a key; /fill reports the problem.
    const msg = e instanceof Error ? e.message : String(e);
    log(`WARNING: ${msg}; /fill will fail until VITE_LLM_API_KEY is set`);
    upstream = {
      model: env.VITE_LLM_MODEL_NAME || "unconfigured",
      generate: async () => {
        throw new UpstreamError("config", msg);
      },
    };
  }
  const open = env.PROXY_OPEN === "1";
  const tokensFile = path.join(DATA_DIR, "tokens.json");
  const handler = createHandler({
    render: renderFillPrompt,
    parse: parseModelAnswer,
    upstream,
    store: new FileStore(DATA_DIR),
    tokens: new FileTokenStore(tokensFile, open, log),
    allowOrigin: originAllowList(env.PROXY_ALLOWED_ORIGINS),
    onError: log,
  });
  const port = Number(env.PROXY_PORT) || 8787;
  const host = env.PROXY_HOST || "127.0.0.1";
  await startServer(handler, port, host, { onError: log });
  log(`listening on http://${host}:${port}  model=${upstream.model}  tokens=${path.relative(projectRoot, tokensFile)}${open ? "  OPEN (token 'dev' accepted)" : ""}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[proxy] failed to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
