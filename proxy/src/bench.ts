/**
 * Latency benchmark: replays recorded /fill requests against one provider and
 * prints median / p90 / max latency and the timeout rate, so provider and
 * reasoning-effort choices can be compared on the same requests.
 *
 *   npx tsx proxy/src/bench.ts --provider gemini --n 20 --concurrency 3
 *   npx tsx proxy/src/bench.ts --provider bayleaf --effort low --data /path/to/proxy/.data
 *
 * Flags: --provider gemini|openrouter|bayleaf (default: as .env decides),
 * --n <requests> (default 20), --concurrency <n> (default 1), --timeout <ms>
 * (default 20000), --effort <low|medium|high> (OpenRouter/BayLeaf),
 * --data <dir> (default proxy/.data; recordings/*.jsonl are read).
 * Reads `.env` / `.env.local` like the dev proxy. Keys are never printed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFillPrompt } from "@app/fill/prompt";
import type { FillRequest } from "@app/contracts";
import { upstreamFromEnv } from "./provider";
import { UpstreamError } from "./upstream";

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.resolve(here, "..");
const projectRoot = path.resolve(proxyDir, "..");

function loadDotEnv(): void {
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
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

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export function summarize(latencies: number[], failures: number): string {
  const s = [...latencies].sort((a, b) => a - b);
  const total = latencies.length + failures;
  const f = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : "-");
  return [
    `calls: ${total} (ok ${latencies.length}, failed/timed out ${failures} = ${total ? Math.round((failures / total) * 100) : 0}%)`,
    `median ${f(percentile(s, 0.5))} | p90 ${f(percentile(s, 0.9))} | max ${f(s[s.length - 1])}`,
  ].join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Newest distinct recorded requests (no error), newest sessions first. */
function loadRequests(dataDir: string, n: number): FillRequest[] {
  const dir = path.join(dataDir, "recordings");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();
  const seen = new Set<string>();
  const out: FillRequest[] = [];
  for (const f of files) {
    for (const line of readFileSync(path.join(dir, f), "utf8").split("\n").reverse()) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { requestHash?: string; request?: FillRequest; error?: string };
        if (!r.request || !r.requestHash || r.error || seen.has(r.requestHash)) continue;
        seen.add(r.requestHash);
        out.push(r.request);
        if (out.length >= n) return out;
      } catch {
        /* skip a torn line */
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  loadDotEnv();
  const provider = arg("provider");
  if (provider) process.env.LLM_PROVIDER = provider;
  const effort = arg("effort");
  if (effort) process.env.PROXY_REASONING_EFFORT = effort;
  process.env.PROXY_UPSTREAM_TIMEOUT_MS = arg("timeout") ?? "20000";
  const n = Number(arg("n") ?? 20);
  const concurrency = Math.max(1, Number(arg("concurrency") ?? 1));
  const dataDir = path.resolve(arg("data") ?? path.join(proxyDir, ".data"));

  const upstream = upstreamFromEnv(process.env);
  const requests = loadRequests(dataDir, n);
  if (requests.length === 0) throw new Error(`no recorded requests under ${dataDir}/recordings`);
  console.log(`provider=${process.env.LLM_PROVIDER ?? "(auto)"} model=${upstream.model} effort=${process.env.PROXY_REASONING_EFFORT ?? "-"} requests=${requests.length} concurrency=${concurrency}`);

  const latencies: number[] = [];
  let failures = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < requests.length) {
      const req = requests[next++];
      const t0 = Date.now();
      try {
        const r = await upstream.generate({ prompt: renderFillPrompt(req), temperature: 0.3, samples: 1 });
        if (r.texts[0] == null) throw new Error("empty answer");
        latencies.push(Date.now() - t0);
      } catch (e) {
        failures++;
        console.log(`  failed after ${Date.now() - t0} ms: ${e instanceof UpstreamError ? e.message : e instanceof Error ? e.message : String(e)}`.replace(/key[=:]\S+/gi, "key=[redacted]"));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(summarize(latencies, failures));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
