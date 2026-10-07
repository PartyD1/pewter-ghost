/**
 * G-31 — Reference examples for the brief: "sections others have drawn here".
 *
 * Reference levels are sliced at rests into small chunks by @measure
 * (sliceLevel). Each chunk is tagged with patterns and measured numbers. At
 * request time we pick the 2-3 chunks nearest to the current window by
 * measured-number distance, keep them varied (no two from the same source
 * with the same tags), redraw them in the window's glyphs so the model reads
 * one alphabet, and stop when the token budget is spent.
 *
 * Pure: no Phaser, no file system. The seed library comes from
 * prompts/reference/*.txt via the generated prompts/bundle.ts.
 */
import {
  measuredDistance,
  parseAscii,
  sliceLevel,
  type Chunk,
  type GridLike,
  type EntityLike,
  type SliceOptions,
} from "@measure";
import type { LevelSnapshot, MeasuredNumbers } from "../contracts";
import { REFERENCE_SECTIONS } from "../../../../prompts/bundle";
import { estimateTokens } from "./window";

/** @measure ASCII glyph -> window glyph (fill/window.ts LEGEND). */
export const MEASURE_TO_WINDOW_GLYPH: Readonly<Record<string, string>> = {
  ".": ".",
  "#": "G",
  d: "D",
  B: "B",
  "=": "H",
  "?": "Q",
  c: "o",
  f: "*",
  s: "S",
  U: "U",
  F: "F",
  i: "!",
  P: "@",
};

/** Redraw @measure ASCII rows in the window's glyphs (unknown glyphs pass through). */
export function toWindowGlyphs(rows: readonly string[]): string[] {
  return rows.map((r) => [...r].map((ch) => MEASURE_TO_WINDOW_GLYPH[ch] ?? ch).join(""));
}

export interface ExampleOptions {
  /** Chunks to pick (default 2, at most 3 is sensible). */
  k?: number;
  /** Token budget for the rendered block, header included (default 400). */
  maxTokens?: number;
  /** Ignore chunks farther than this measured distance (0..1, default 0.6). */
  maxDistance?: number;
  /** Skip chunks for which this returns true (e.g. the person's own level). */
  exclude?: (c: Chunk) => boolean;
  /** Widest chunk to show; wider ones are cropped from the left edge (default 28). */
  maxCols?: number;
}

export const EXAMPLE_DEFAULTS = { k: 2, maxTokens: 400, maxDistance: 0.6, maxCols: 28 } as const;

export interface PickedExample {
  chunk: Chunk;
  distance: number;
  text: string;
}

export interface ExampleSelection {
  picked: PickedExample[];
  /** The block to append to the brief ("" when nothing fits). */
  text: string;
  tokens: number;
}

export const EXAMPLES_HEADER =
  "Sections others have drawn in levels like this one (for style and numbers; do not copy them cell for cell):";

const sameTags = (a: Chunk, b: Chunk) => a.tags.length === b.tags.length && a.tags.every((t, i) => t === b.tags[i]);

/** One chunk as prompt text, in window glyphs. */
export function renderExample(c: Chunk, distance?: number, maxCols: number = EXAMPLE_DEFAULTS.maxCols): string {
  const n = c.numbers;
  const rows = toWindowGlyphs(c.rows).map((r) => (r.length > maxCols ? r.slice(0, maxCols) : r));
  const w = Math.min(c.rect.w, maxCols);
  const head =
    `[${c.tags.join(", ") || "plain"}] ${w}x${c.rect.h}, density ${n.density.toFixed(2)}, ` +
    `difficulty ${(n.difficulty ?? 0).toFixed(2)}, coins on arcs ${Math.round(c.measures.coinsOnArcShare * 100)}%` +
    (distance === undefined ? "" : `, distance ${distance.toFixed(2)}`);
  return [head, ...rows].join("\n");
}

/**
 * Pick the nearest chunks to `target`, varied and within budget.
 * Deterministic: ties broken by chunk id.
 */
export function selectExamples(
  chunks: readonly Chunk[],
  target: MeasuredNumbers,
  opts: ExampleOptions = {},
): ExampleSelection {
  const k = Math.max(0, Math.floor(opts.k ?? EXAMPLE_DEFAULTS.k));
  const maxTokens = opts.maxTokens ?? EXAMPLE_DEFAULTS.maxTokens;
  const maxDistance = opts.maxDistance ?? EXAMPLE_DEFAULTS.maxDistance;
  const maxCols = opts.maxCols ?? EXAMPLE_DEFAULTS.maxCols;
  const ranked = chunks
    .filter((c) => !opts.exclude?.(c))
    .map((c) => ({ chunk: c, distance: measuredDistance(c.numbers, target) }))
    .filter((p) => p.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || (a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0));

  const picked: PickedExample[] = [];
  let tokens = estimateTokens(EXAMPLES_HEADER);
  for (const p of ranked) {
    if (picked.length >= k) break;
    // Variety: never two chunks from the same source with the same tags.
    if (picked.some((q) => q.chunk.source === p.chunk.source && sameTags(q.chunk, p.chunk))) continue;
    const text = renderExample(p.chunk, p.distance, maxCols);
    const cost = estimateTokens(text) + 1;
    if (tokens + cost > maxTokens) continue;
    tokens += cost;
    picked.push({ chunk: p.chunk, distance: p.distance, text });
  }
  if (!picked.length) return { picked, text: "", tokens: 0 };
  const text = [EXAMPLES_HEADER, ...picked.map((p) => p.text)].join("\n");
  return { picked, text, tokens: estimateTokens(text) };
}

/** A set of reference chunks, sliced once. */
export class ExampleLibrary {
  readonly chunks: readonly Chunk[];

  constructor(chunks: readonly Chunk[]) {
    this.chunks = [...chunks];
  }

  /** Slice named level snapshots (format v2 levels loaded by the caller). */
  static fromLevels(levels: readonly { name: string; level: LevelSnapshot }[], opts: SliceOptions = {}): ExampleLibrary {
    const chunks: Chunk[] = [];
    for (const { name, level } of levels) chunks.push(...sliceLevel(level, { ...opts, source: name }));
    return new ExampleLibrary(chunks);
  }

  /** Slice ASCII sections in @measure glyphs (prompts/reference/*.txt). */
  static fromAscii(sections: readonly { name: string; text: string }[], opts: SliceOptions = {}): ExampleLibrary {
    const chunks: Chunk[] = [];
    for (const s of sections) {
      const rows = s.text.split("\n").filter((r) => r.length > 0 && !r.startsWith(";"));
      const parsed = parseAscii(rows);
      chunks.push(...sliceLevel(parsed.grid as GridLike, parsed.entities as EntityLike[], { ...opts, source: s.name }));
    }
    return new ExampleLibrary(chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  select(target: MeasuredNumbers, opts: ExampleOptions = {}): ExampleSelection {
    return selectExamples(this.chunks, target, opts);
  }
}

let seed: ExampleLibrary | undefined;

/** The hand-made seed library (prompts/reference), sliced on first use. */
export function seedLibrary(): ExampleLibrary {
  seed ??= ExampleLibrary.fromAscii(REFERENCE_SECTIONS);
  return seed;
}
