#!/usr/bin/env node
/**
 * npm run dev — start the key-holding proxy and the editor together.
 * (npm run dev:ai is the same; npm run dev:editor starts the editor alone, without AI.)
 *
 * The proxy reads .env / .env.local (copy .env.example to .env and add your key).
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

if (!env.GEMINI_API_KEY && !env.VITE_LLM_API_KEY) {
  console.error(
    "\n[dev] No model key, so no AI. Pewter Ghost needs it:\n" +
      "[dev]   cp .env.example .env   then set GEMINI_API_KEY=... in .env\n" +
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
