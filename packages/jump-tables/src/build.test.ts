/**
 * Regeneration test (G-05): the checked-in tables.json must be exactly what
 * the exporter produces from the current solver and physics. If this fails
 * after a change under apps/editor/src/player/, run
 *   npx tsx packages/jump-tables/src/export.ts
 * and commit the new tables.json together with the physics change.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTables, serializeTables, DY_MAX, DY_MIN, RUNWAYS } from "./build";
import { TIERS, type JumpTables } from "./types";

const TABLES_PATH = fileURLToPath(new URL("./tables.json", import.meta.url));

describe("tables.json regeneration", () => {
  let built: JumpTables;
  let text: string;

  // The full build is ~10 s of solver time; do it once for the file.
  beforeAll(() => {
    built = buildTables();
    text = serializeTables(built);
  }, 180_000);

  it("rebuilding in memory reproduces tables.json byte for byte", () => {
    const onDisk = readFileSync(TABLES_PATH, "utf8");
    if (text !== onDisk) {
      // Point at the first differing line instead of dumping 140 KB.
      const a = text.split("\n");
      const b = onDisk.split("\n");
      const i = a.findIndex((line, k) => line !== b[k]);
      expect.fail(
        `tables.json is stale at line ${i + 1}:\n  built:   ${a[i]?.slice(0, 200)}\n  on disk: ${b[i]?.slice(0, 200)}\n` +
          "Run: npx tsx packages/jump-tables/src/export.ts",
      );
    }
    expect(JSON.parse(onDisk)).toEqual(built);
  });

  it("serialization round-trips and is deterministic", () => {
    expect(JSON.parse(text)).toEqual(built);
    expect(serializeTables(JSON.parse(text) as JumpTables)).toBe(text);
  });

  it("has the documented shape", () => {
    expect(built.runways).toEqual([...RUNWAYS]);
    expect(built.dyMin).toBe(DY_MIN);
    expect(built.dyMax).toBe(DY_MAX);
    for (const tier of TIERS) {
      expect(built.reach[tier]).toHaveLength(RUNWAYS.length);
      for (const row of built.reach[tier])
        expect(row).toHaveLength(DY_MAX - DY_MIN + 1);
      for (const row of built.reachRaw[tier])
        expect(row).toHaveLength(DY_MAX - DY_MIN + 1);
    }
    expect(built.impossible).toHaveLength(RUNWAYS.length);
  });
});
