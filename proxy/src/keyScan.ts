/**
 * "0 keys in dist/" check (G-09 measure). Scans a build output directory for
 * Google API key patterns and for the literal configured key. Prints only
 * file names and a masked hint, never the key.
 *
 *   npx tsx proxy/src/keyScan.ts [dist]     # exit 1 when anything is found
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KEY_PATTERNS: RegExp[] = [/AIza[0-9A-Za-z_-]{35}/g];

export interface KeyHit {
  file: string;
  kind: "pattern" | "configured-key";
  masked: string;
}

export function scanText(text: string, file: string, configuredKey?: string): KeyHit[] {
  const hits: KeyHit[] = [];
  for (const re of KEY_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, "g"))) hits.push({ file, kind: "pattern", masked: mask(m[0]) });
  }
  if (configuredKey && configuredKey.length >= 8 && text.includes(configuredKey))
    hits.push({ file, kind: "configured-key", masked: mask(configuredKey) });
  return hits;
}

export async function scanDir(dir: string, configuredKey?: string): Promise<KeyHit[]> {
  const hits: KeyHit[] = [];
  async function walk(d: string): Promise<void> {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) {
        const buf = await fs.readFile(p);
        hits.push(...scanText(buf.toString("latin1"), path.relative(dir, p), configuredKey));
      }
    }
  }
  await walk(dir);
  return hits;
}

function mask(k: string): string {
  return `${k.slice(0, 4)}…(${k.length} chars)`;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dir = path.resolve(process.argv[2] ?? "dist");
  scanDir(dir, process.env.VITE_LLM_API_KEY || process.env.GEMINI_API_KEY)
    .then((hits) => {
      for (const h of hits) console.error(`key material in ${h.file}: ${h.kind} ${h.masked}`);
      if (hits.length) process.exit(1);
      console.log(`no keys found in ${dir}`);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    });
}
