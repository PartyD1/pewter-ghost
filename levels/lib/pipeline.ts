/**
 * Source text -> checked level: snapshot, save JSON (format v2), agent
 * verdict, type numbers and fit, lint. Shared by build.ts and the tests.
 */
import { measureLevel } from "@measure";
import type { LevelSnapshot } from "../../apps/editor/src/contracts";
import { serializeSave } from "../../apps/editor/src/level/save";
import { lintLevel } from "./lint";
import { parseLevelSource, sourceToSnapshot, type LevelSource } from "./source";
import { fitType, typeNumbers, type TypeFit, type TypeNumbers } from "./types";
import { verifyBeatable, type BeatOptions, type BeatResult } from "./verify";

export const SAVE_APP = "pewter-ghost levels/build.ts";

export interface BuiltLevel {
  source: LevelSource;
  snapshot: LevelSnapshot;
  /** The save file text (format v2, no timestamp, so builds are reproducible). */
  json: string;
  /** Path relative to levels/: reference/<name>.json or fixtures/<name>.json. */
  out: string;
  numbers: TypeNumbers;
  fit?: TypeFit;
  lint: string[];
  beat?: BeatResult;
  /** Problems that fail the build (wrong verdict, type misfit, lint on a reference). */
  errors: string[];
}

export function outPath(src: Pick<LevelSource, "kind" | "name">): string {
  return `${src.kind === "reference" ? "reference" : "fixtures"}/${src.name}.json`;
}

export function saveText(snap: LevelSnapshot): string {
  return serializeSave(snap, { savedAt: null, app: SAVE_APP });
}

export interface BuildOptions extends BeatOptions {
  /** Run the playtest agent (default true). */
  verify?: boolean;
}

/** Parse, build and check one source. Throws LevelSourceError on a malformed source. */
export function buildLevel(text: string, file?: string, opts: BuildOptions = {}): BuiltLevel {
  const source = parseLevelSource(text, file);
  const snapshot = sourceToSnapshot(source);
  const numbers = typeNumbers(snapshot, measureLevel(snapshot));
  const fit = source.type ? fitType(source.type, numbers) : undefined;
  const lint = lintLevel(snapshot);
  const errors: string[] = [];
  if (source.kind === "reference") {
    errors.push(...lint.map((l) => `lint: ${l}`));
    if (fit && !fit.ok)
      for (const f of fit.failures)
        errors.push(`type: ${f.id}: ${f.key} = ${f.value} outside [${f.min ?? "-inf"}, ${f.max ?? "inf"}] (${f.text})`);
  }
  let beat: BeatResult | undefined;
  if (opts.verify !== false) {
    beat = verifyBeatable(snapshot, opts);
    const want = source.expect === "unbeatable" ? false : true;
    if (beat.beatable !== want) {
      const where = beat.blockedAt ? ` (furthest standing cell ${beat.blockedAt.x},${beat.blockedAt.y})` : "";
      errors.push(
        want
          ? `agent: not beatable from (${beat.from.x},${beat.from.y}) to the ${beat.goalKind}${where}${beat.timedOut ? ", timed out" : ""}`
          : "agent: expected unbeatable, but the agent found a route",
      );
    } else if (!want && beat.timedOut) errors.push("agent: timed out before proving the level unbeatable");
  }
  return { source, snapshot, json: saveText(snapshot), out: outPath(source), numbers, fit, lint, beat, errors };
}
