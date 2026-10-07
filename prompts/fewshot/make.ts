/**
 * Writes prompts/fewshot/<n>-<id>.json from scenarios.ts, then rebuilds
 * prompts/bundle.ts.   npx tsx prompts/fewshot/make.ts
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFewShot, SCENARIOS, type FewShot } from "./scenarios";
import { writeBundle } from "../build";

const here = path.dirname(fileURLToPath(import.meta.url));

/** File name and JSON text for every few-shot, in order. */
export function fewShotFiles(): { name: string; text: string; shot: FewShot }[] {
  return SCENARIOS.map((make, i) => {
    const shot = buildFewShot(make());
    return { name: `${i + 1}-${shot.id}.json`, text: JSON.stringify(shot, null, 2) + "\n", shot };
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  mkdirSync(here, { recursive: true });
  for (const f of readdirSync(here)) if (f.endsWith(".json")) unlinkSync(path.join(here, f));
  for (const f of fewShotFiles()) {
    writeFileSync(path.join(here, f.name), f.text);
    console.log(`wrote prompts/fewshot/${f.name}`);
  }
  writeBundle();
  console.log("wrote prompts/bundle.ts");
}
