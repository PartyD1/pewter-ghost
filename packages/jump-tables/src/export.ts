/**
 * Regenerate packages/jump-tables/src/tables.json from the jump solver.
 *
 *   npx tsx packages/jump-tables/src/export.ts          # write tables.json
 *   npx tsx packages/jump-tables/src/export.ts --check  # exit 1 if stale
 *
 * See build.ts for what is derived and how it compares with the audit's
 * caps.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTables, serializeTables } from "./build";

export const TABLES_PATH = fileURLToPath(
  new URL("./tables.json", import.meta.url),
);

function main(argv: string[]): number {
  const t0 = Date.now();
  const tables = buildTables();
  const text = serializeTables(tables);
  const ms = Date.now() - t0;
  const d = tables.limits[tables.designTier];
  const summary =
    `${tables.designTier}: maxGapStand=${d.maxGapStand} maxGapRun=${d.maxGapRun} ` +
    `maxRise=${d.maxRise}; ${tables.arcs.entries.length} arcs; built in ${ms} ms`;

  if (argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(TABLES_PATH, "utf8");
    } catch {
      /* missing counts as stale */
    }
    if (current !== text) {
      console.error(
        `tables.json is stale; run npx tsx packages/jump-tables/src/export.ts (${summary})`,
      );
      return 1;
    }
    console.log(`tables.json is up to date (${summary})`);
    return 0;
  }

  writeFileSync(TABLES_PATH, text);
  console.log(
    `wrote ${TABLES_PATH} (${(text.length / 1024).toFixed(1)} KB) — ${summary}`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
