/**
 * levels/reference/chunks.json: the reference levels sliced at rests by
 * @measure (sliceLevel) into small tagged, measured ASCII chunks, for the
 * brief's example retrieval (apps/editor/src/fill/examples.ts, G-31).
 *
 * Pure: the caller reads/writes the file. A consumer turns the JSON back into
 * @measure Chunks with `chunksFromJson` and hands them to
 * `new ExampleLibrary(chunks)`.
 */
import { sliceLevel, type Chunk, type SliceOptions } from "@measure";
import type { LevelSnapshot } from "../../apps/editor/src/contracts";
import { LEVEL_TYPES, type LevelType } from "./source";

export const CHUNKS_VERSION = 1;

/** A chunk plus the type of the level it came from. */
export type ReferenceChunk = Chunk & { levelType: LevelType };

export interface ChunksFile {
  version: typeof CHUNKS_VERSION;
  generatedBy: string;
  /** Slice options used (defaults of sliceLevel unless set). */
  slice: Pick<SliceOptions, "minWidth" | "maxWidth" | "margin" | "keepPlain">;
  sources: { name: string; type: LevelType; chunks: number }[];
  chunks: ReferenceChunk[];
}

export const CHUNK_SLICE: ChunksFile["slice"] = { minWidth: 8, maxWidth: 32, margin: 3, keepPlain: false };

/** Slice every reference level (in the given order) into one chunk file. */
export function buildChunksFile(levels: readonly { name: string; type: LevelType; level: LevelSnapshot }[]): ChunksFile {
  const sources: ChunksFile["sources"] = [];
  const chunks: ReferenceChunk[] = [];
  for (const l of levels) {
    const cs = sliceLevel(l.level, { ...CHUNK_SLICE, source: l.name });
    sources.push({ name: l.name, type: l.type, chunks: cs.length });
    for (const c of cs) chunks.push({ ...c, levelType: l.type });
  }
  return { version: CHUNKS_VERSION, generatedBy: "levels/build.ts", slice: { ...CHUNK_SLICE }, sources, chunks };
}

/** JSON text: header fields one per line, then one chunk per line (diffable, compact). */
export function formatChunksFile(f: ChunksFile): string {
  const { chunks, ...head } = f;
  const lines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const body = chunks.map((c, i) => `    ${JSON.stringify(c)}${i < chunks.length - 1 ? "," : ""}`);
  return ["{", ...lines, `  "chunks": [`, ...body, "  ]", "}"].join("\n") + "\n";
}

/** Validate a parsed chunks.json and return its chunks. Throws on a file that is not one. */
export function chunksFromJson(data: unknown): ReferenceChunk[] {
  const f = data as Partial<ChunksFile> | null;
  if (!f || typeof f !== "object" || f.version !== CHUNKS_VERSION || !Array.isArray(f.chunks))
    throw new Error("not a levels/reference/chunks.json file (version 1)");
  for (const c of f.chunks) {
    const ok =
      c &&
      typeof c.id === "string" &&
      typeof c.source === "string" &&
      Array.isArray(c.rows) &&
      Array.isArray(c.tags) &&
      c.numbers &&
      Array.isArray(c.numbers.gapHist) &&
      c.measures &&
      (LEVEL_TYPES as readonly string[]).includes(c.levelType);
    if (!ok) throw new Error(`malformed chunk ${String((c as { id?: unknown })?.id)}`);
  }
  return f.chunks;
}
