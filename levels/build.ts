/**
 * Build the reference and fixture levels from their readable sources.
 *
 *   npx tsx levels/build.ts             build all, verify, write JSON, index and chunks
 *   npx tsx levels/build.ts --check     build and verify, write nothing; exit 1 when a
 *                                       file on disk is stale or a level fails
 *   npx tsx levels/build.ts --report    also print every level's type numbers
 *   npx tsx levels/build.ts parkour-1   only these levels (no index/chunks written)
 *   --no-verify                         skip the playtest agent (fast; for drafting)
 *
 * Inputs:  levels/src/*.txt (format in levels/lib/source.ts and levels/README.md)
 * Outputs: levels/reference/<name>.json, levels/fixtures/<name>.json (save format v2),
 *          levels/index.json (verdicts and numbers),
 *          levels/reference/chunks.json (@measure slices for fill/examples.ts).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChunksFile, formatChunksFile } from "./lib/chunks";
import { buildIndex, formatIndex } from "./lib/indexFile";
import { buildLevel, type BuiltLevel } from "./lib/pipeline";
import { LevelSourceError } from "./lib/source";

const ROOT = dirname(fileURLToPath(import.meta.url));

interface Args {
  check: boolean;
  report: boolean;
  verify: boolean;
  only: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { check: false, report: false, verify: true, only: [] };
  for (const s of argv) {
    if (s === "--check") a.check = true;
    else if (s === "--report") a.report = true;
    else if (s === "--no-verify") a.verify = false;
    else if (s.startsWith("--")) throw new Error(`unknown flag ${s}`);
    else a.only.push(s.replace(/\.txt$/, ""));
  }
  return a;
}

function writeIfChanged(rel: string, text: string, check: boolean, stale: string[]): void {
  const p = join(ROOT, rel);
  const old = existsSync(p) ? readFileSync(p, "utf8") : null;
  if (old === text) return;
  if (check) {
    stale.push(rel);
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  console.log(`wrote ${rel}`);
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const srcDir = join(ROOT, "src");
  let files = readdirSync(srcDir)
    .filter((f) => f.endsWith(".txt"))
    .sort();
  if (args.only.length) {
    const missing = args.only.filter((n) => !files.includes(`${n}.txt`));
    if (missing.length) throw new Error(`no source for ${missing.join(", ")}`);
    files = files.filter((f) => args.only.includes(f.replace(/\.txt$/, "")));
  }

  const built: BuiltLevel[] = [];
  let failed = 0;
  for (const f of files) {
    let b: BuiltLevel;
    try {
      b = buildLevel(readFileSync(join(srcDir, f), "utf8"), f, { verify: args.verify });
    } catch (e) {
      if (e instanceof LevelSourceError) {
        console.error(`FAIL ${e.message}`);
        failed++;
        continue;
      }
      throw e;
    }
    built.push(b);
    const s = b.source;
    const verdict = b.beat
      ? b.beat.beatable
        ? `beatable in ${b.beat.seconds}s (${b.beat.ms} ms)`
        : `not beatable${b.beat.exhausted ? " (exhausted)" : ""}${b.beat.timedOut ? " (timed out)" : ""}`
      : "not verified";
    const label = `${s.kind === "reference" ? s.type : "fixture"}`.padEnd(14);
    console.log(`${b.errors.length ? "FAIL" : "ok  "} ${s.name.padEnd(22)} ${label} ${verdict}`);
    for (const e of b.errors) console.log(`       ${e}`);
    if (args.report) {
      const n = b.numbers as unknown as Record<string, number>;
      console.log(
        "       " +
          Object.keys(n)
            .map((k) => `${k}=${fmt(n[k])}`)
            .join(" "),
      );
    }
    if (b.errors.length) failed++;
  }

  const stale: string[] = [];
  for (const b of built) writeIfChanged(b.out, b.json, args.check, stale);
  if (!args.only.length && args.verify) {
    const refs = built.filter((b) => b.source.kind === "reference");
    writeIfChanged("index.json", formatIndex(buildIndex(built)), args.check, stale);
    const chunks = buildChunksFile(refs.map((b) => ({ name: b.source.name, type: b.source.type!, level: b.snapshot })));
    writeIfChanged("reference/chunks.json", formatChunksFile(chunks), args.check, stale);
    console.log(`${refs.length} reference level(s), ${built.length - refs.length} fixture(s), ${chunks.chunks.length} chunk(s)`);
  }
  if (stale.length) console.error(`stale (run npx tsx levels/build.ts): ${stale.join(", ")}`);
  if (failed) console.error(`${failed} level(s) failed`);
  return failed || stale.length ? 1 : 0;
}

process.exitCode = main();
