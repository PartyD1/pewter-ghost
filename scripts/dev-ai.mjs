#!/usr/bin/env node
/**
 * npm run dev — start the key-holding proxy and the editor together.
 * (npm run dev:ai is the same; npm run dev:editor starts the editor alone, without AI.)
 *
 * The proxy reads .env / .env.local (copy .env.example to .env and add your key).
 * Pick the model provider with LLM_PROVIDER in .env, or for one run:
 *   npm run dev -- bayleaf        (or openrouter, gemini)
 * In development the editor uses the proxy's built-in "dev" token automatically,
 * so http://localhost:5173/ has AI suggestions with no URL parameters.
 *
 * Pewter Ghost without the AI is not the product, so this refuses to start
 * without a model key.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const env = { ...process.env };
// Same files and order the proxy uses; loadEnvFile never overrides variables already set.
for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  try {
    const before = { ...process.env };
    process.loadEnvFile(f);
    for (const [k, v] of Object.entries(process.env)) if (!(k in before)) env[k] = v;
  } catch {
    console.error(`[dev] Could not read ${f}; check its format (KEY=value per line).`);
  }
}
env.PROXY_OPEN ??= "1";
env.PROXY_THINKING_BUDGET ??= "0";

const PROVIDERS = ["gemini", "openrouter", "bayleaf"];
const cli = process.argv.slice(2).map((a) => a.replace(/^--(provider=)?/, "").toLowerCase());
const unknown = cli.find((a) => !PROVIDERS.includes(a));
if (unknown) {
  console.error(`[dev] Unknown option "${unknown}". Use one of: ${PROVIDERS.join(", ")}.`);
  process.exit(1);
}
if (cli.length) env.LLM_PROVIDER = cli[cli.length - 1];
if (env.LLM_PROVIDER && !PROVIDERS.includes(env.LLM_PROVIDER.trim().toLowerCase())) {
  console.error(`[dev] LLM_PROVIDER="${env.LLM_PROVIDER}" is not one of: ${PROVIDERS.join(", ")}.`);
  process.exit(1);
}
// Same rule as proxy/src/provider.ts: the named provider, else the first with a key.
const provider =
  env.LLM_PROVIDER?.trim().toLowerCase() ||
  (env.GEMINI_API_KEY || env.VITE_LLM_API_KEY ? "gemini" : env.OPENROUTER_API_KEY ? "openrouter" : env.BAYLEAF_API_KEY ? "bayleaf" : "gemini");
const hasKey =
  provider === "gemini" ? !!(env.GEMINI_API_KEY || env.VITE_LLM_API_KEY) : provider === "openrouter" ? !!env.OPENROUTER_API_KEY : true;
console.error(`[dev] Model provider: ${provider}`);
if (provider === "bayleaf" && !env.BAYLEAF_API_KEY)
  console.error('[dev] No BAYLEAF_API_KEY, so using "campus" (works only on the UCSC network; sign in at https://api.bayleaf.dev/login for a key).');

if (!hasKey) {
  console.error(
    "\n[dev] No model key, so no AI. Pewter Ghost needs it:\n" +
      `[dev]   cp .env.example .env   then set ${provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY"}=... in .env\n` +
      "[dev]   (or pick another provider: npm run dev -- bayleaf | openrouter | gemini)\n" +
      "[dev]   npm run dev\n" +
      "[dev] (npm run dev:editor starts the editor alone, without AI, for debugging.)\n",
  );
  process.exit(1);
}

const kids = [];
function run(name, cmd, args) {
  const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) if (l) out.write(`[${name}] ${l}\n`);
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.error(`[${name}] exited with code ${code}`);
    for (const k of kids) if (k !== p && k.exitCode === null) k.kill();
    process.exit(code ?? 0);
  });
  kids.push(p);
}

run("proxy", "npx", ["tsx", "proxy/src/dev.ts"]);
run("editor", "npx", ["vite"]);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const k of kids) k.kill(); process.exit(0); });
