#!/usr/bin/env node
/**
 * npm run dev:ai — start the key-holding proxy and the editor together.
 *
 * The proxy reads .env / .env.local (copy .env.example to .env and add your key).
 * In development the editor uses the proxy's built-in "dev" token automatically,
 * so http://localhost:5173/ has AI suggestions with no URL parameters.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const env = { ...process.env };
env.PROXY_OPEN ??= "1";
env.PROXY_THINKING_BUDGET ??= "0";

if (!existsSync(".env") && !existsSync(".env.local") && !env.GEMINI_API_KEY && !env.VITE_LLM_API_KEY) {
  console.error("\n[dev:ai] No model key found. Copy .env.example to .env and set GEMINI_API_KEY.\n" +
    "[dev:ai] The editor will still run, but without AI suggestions.\n");
}

const kids = [];
function run(name, cmd, args) {
  const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const tag = (line) => (line ? `[${name}] ${line}\n` : "");
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) out.write(tag(l));
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
