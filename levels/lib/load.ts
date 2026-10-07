/**
 * Node-side loaders for the built levels (the eval suite, tests and tools).
 * The editor bundle should import the JSON directly instead, e.g.
 * `import chunks from "../../../../levels/reference/chunks.json"` and
 * `new ExampleLibrary(chunksFromJson(chunks))`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LevelSnapshot } from "../../apps/editor/src/contracts";
import { ExampleLibrary } from "../../apps/editor/src/fill/examples";
import { parseSave, type LoadResult } from "../../apps/editor/src/level/save";
import { chunksFromJson, type ReferenceChunk } from "./chunks";
import type { IndexEntry, IndexFile } from "./indexFile";
import type { LevelType } from "./source";

/** Absolute path of the levels/ directory. */
export const LEVELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse a save file under levels/ (e.g. "reference/maze-1.json") with the editor's loader. */
export function readLevelFile(rel: string, dir: string = LEVELS_DIR): LoadResult {
  return parseSave(readFileSync(join(dir, rel), "utf8"));
}

function mustLoad(rel: string, dir: string): LevelSnapshot {
  const r = readLevelFile(rel, dir);
  if (!r.ok) throw new Error(`${rel}: ${r.error}`);
  return r.snapshot;
}

export function readIndex(dir: string = LEVELS_DIR): IndexFile {
  return JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as IndexFile;
}

export interface ReferenceLevel {
  name: string;
  type: LevelType;
  title: string;
  level: LevelSnapshot;
  entry: IndexEntry;
}

/** Every reference level, optionally of one type, in index order. */
export function loadReferenceLevels(type?: LevelType, dir: string = LEVELS_DIR): ReferenceLevel[] {
  return readIndex(dir)
    .levels.filter((e) => e.kind === "reference" && (!type || e.type === type))
    .map((e) => ({ name: e.name, type: e.type!, title: e.title, level: mustLoad(e.file, dir), entry: e }));
}

/** A test fixture by name, e.g. "unbeatable-gap". */
export function loadFixture(name: string, dir: string = LEVELS_DIR): LevelSnapshot {
  return mustLoad(`fixtures/${name}.json`, dir);
}

/** levels/reference/chunks.json as @measure Chunks (plus their level type). */
export function loadReferenceChunks(dir: string = LEVELS_DIR): ReferenceChunk[] {
  return chunksFromJson(JSON.parse(readFileSync(join(dir, "reference", "chunks.json"), "utf8")));
}

/** The reference chunks as an example library for the brief (G-31). */
export function referenceExampleLibrary(dir: string = LEVELS_DIR): ExampleLibrary {
  return new ExampleLibrary(loadReferenceChunks(dir));
}
