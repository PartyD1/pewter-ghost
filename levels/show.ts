/**
 * Print a level from its source with the playtest agent's route drawn in.
 *
 *   npx tsx levels/show.ts parkour-1            whole level
 *   npx tsx levels/show.ts maze-2 80 160        columns 80..159 only
 *
 * '*' marks the cells the knight's body centre passes through; the header
 * gives the verdict and the patterns @measure finds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeWindow, fullRect } from "@measure";
import { LEVELS_DIR } from "./lib/load";
import { parseLevelSource, snapshotRows, sourceToSnapshot } from "./lib/source";
import { verifyBeatable } from "./lib/verify";

const [name, a, b] = process.argv.slice(2);
if (!name) {
  console.error("usage: npx tsx levels/show.ts <name> [x0 x1]");
  process.exit(2);
}
const src = parseLevelSource(readFileSync(join(LEVELS_DIR, "src", `${name}.txt`), "utf8"), `${name}.txt`);
const snap = sourceToSnapshot(src);
const r = verifyBeatable(snap);
const rows = snapshotRows(snap).map((row) => row.split(""));
for (const p of r.path) if (rows[p.y]?.[p.x] === ".") rows[p.y][p.x] = "*";
const x0 = Math.max(0, Number(a ?? 0));
const x1 = Math.min(snap.w, Number(b ?? snap.w));
const tags = analyzeWindow(snap, snap.entities, fullRect(snap)).patterns;
console.log(
  `${src.name} (${src.type ?? src.kind}) "${src.title}": ` +
    (r.beatable ? `beatable in ${r.seconds}s` : `not beatable, furthest ${JSON.stringify(r.blockedAt)}`) +
    ` | patterns: ${tags.join(", ")}`,
);
const ruler = Array.from({ length: x1 - x0 }, (_, i) => ((x0 + i) % 10 === 0 ? String(((x0 + i) / 10) % 10) : " ")).join("");
console.log(ruler);
for (const row of rows) console.log(row.slice(x0, x1).join(""));
