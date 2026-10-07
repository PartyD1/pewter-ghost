/**
 * Token script (G-09/G-33). Manages proxy/.data/tokens.json and prints launcher URLs.
 *
 *   npx tsx proxy/src/tokens-cli.ts add --condition llm [--count 3] [--label pilot]
 *        [--session p01] [--overrides '{"showNowAbove":0.8}'] [--expires 2026-12-31]
 *        [--editor http://localhost:5173/]
 *   npx tsx proxy/src/tokens-cli.ts list
 *   npx tsx proxy/src/tokens-cli.ts revoke <token>
 *   npx tsx proxy/src/tokens-cli.ts export      # JSON for the worker's PROXY_TOKENS
 *
 * Session tokens are not the model key; printing them is fine.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONDITIONS, generateToken, type Condition, type TokenEntry, type TokenFile } from "./sessions";
import { readTokenFileOrEmpty } from "./node/fileTokens";
import { isSafeSessionId } from "./store";

export interface CliResult {
  file: TokenFile;
  out: string[];
  changed: boolean;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Pure command logic (tested); main() does the file IO. */
export function runTokenCommand(argv: string[], file: TokenFile, mint: () => string = () => generateToken()): CliResult {
  const [cmd, ...args] = argv;
  const out: string[] = [];
  const next: TokenFile = { tokens: { ...file.tokens } };
  switch (cmd) {
    case "add": {
      const condition = (flag(args, "condition") ?? "llm") as Condition;
      if (!CONDITIONS.includes(condition)) throw new Error(`--condition must be one of ${CONDITIONS.join(", ")}`);
      const count = Number(flag(args, "count") ?? "1");
      if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("--count must be 1..500");
      const label = flag(args, "label");
      const session = flag(args, "session");
      if (session !== undefined && (!isSafeSessionId(session) || count > 1)) throw new Error("--session must be a safe id and needs --count 1");
      const overridesRaw = flag(args, "overrides");
      let overrides: Record<string, unknown> | undefined;
      if (overridesRaw) {
        const o = JSON.parse(overridesRaw) as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("--overrides must be a JSON object");
        overrides = o as Record<string, unknown>;
      }
      const expires = flag(args, "expires");
      if (expires !== undefined && Number.isNaN(Date.parse(expires))) throw new Error("--expires must be a date");
      const editor = flag(args, "editor") ?? "http://localhost:5173/";
      for (let i = 0; i < count; i++) {
        const token = mint();
        const entry: TokenEntry = { condition };
        if (session) entry.sessionId = session;
        if (label) entry.label = count > 1 ? `${label}-${i + 1}` : label;
        if (overrides) entry.overrides = overrides;
        if (expires) entry.expiresAt = expires;
        next.tokens[token] = entry;
        const u = new URL(editor);
        u.searchParams.set("token", token);
        out.push(`${token}\t${condition}\t${entry.label ?? ""}\t${u.toString()}`);
      }
      return { file: next, out, changed: true };
    }
    case "list": {
      for (const [t, e] of Object.entries(file.tokens))
        out.push(`${t}\t${e.condition ?? "llm"}\t${e.label ?? ""}\t${e.sessionId ?? ""}${e.disabled ? "\t(revoked)" : ""}`);
      if (out.length === 0) out.push("(no tokens)");
      return { file, out, changed: false };
    }
    case "revoke": {
      const t = args[0];
      if (!t || !next.tokens[t]) throw new Error("unknown token");
      next.tokens[t] = { ...next.tokens[t], disabled: true };
      out.push(`revoked ${t}`);
      return { file: next, out, changed: true };
    }
    case "export":
      out.push(JSON.stringify(file));
      return { file, out, changed: false };
    default:
      throw new Error("usage: tokens-cli.ts add|list|revoke|export (see file header)");
  }
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const target = process.env.PROXY_TOKENS_FILE ?? path.resolve(here, "..", ".data", "tokens.json");
  const file = await readTokenFileOrEmpty(target);
  const res = runTokenCommand(process.argv.slice(2), file);
  if (res.changed) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(res.file, null, 2) + "\n", "utf8");
    await fs.rename(tmp, target);
  }
  for (const line of res.out) console.log(line);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
