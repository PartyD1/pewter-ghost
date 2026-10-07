/**
 * Rule-checked generation: every chunk handed out passes @physsim's rule
 * check (jump tables, design tier) from the chunk's start to its last column.
 * chunkgen.py's geometry already stays inside the ladder, so almost every
 * seed passes; the check catches the rest (e.g. a step up right after a
 * platform piece leaves no headroom) and the next seed is tried.
 */
import { checkRules, type RuleOptions, type RuleVerdict, type SolidGrid } from "@physsim";
import type { Point } from "../../../apps/editor/src/contracts";
import { generateChunk, type GenerateOptions, type GeneratedChunk } from "./generator";

/** The chunk as a @physsim grid (shares the mask). */
export function chunkGrid(c: Pick<GeneratedChunk, "w" | "h" | "grid">): SolidGrid {
  return { w: c.w, h: c.h, solid: c.grid };
}

/** Where the knight starts in a chunk: standing on the first column's surface. */
export function chunkStart(c: Pick<GeneratedChunk, "ground">): Point {
  return { x: 0, y: c.ground - 1 };
}

/** Rule check from the chunk's start to any standing cell in its last column. */
export function checkChunk(c: GeneratedChunk, opts: RuleOptions = {}): RuleVerdict {
  return checkRules(chunkGrid(c), chunkStart(c), { x0: c.w - 1, x1: c.w - 1 }, opts);
}

export interface ValidChunkOptions extends GenerateOptions {
  /** Seeds tried before giving up (default 32). */
  maxTries?: number;
  rules?: RuleOptions;
  /** Extra acceptance test run after the rule check (e.g. the caller's merged-level check). */
  accept?: (c: GeneratedChunk) => boolean;
}

export interface ValidChunk {
  chunk: GeneratedChunk;
  verdict: RuleVerdict;
  /** Seeds tried, including the one that passed (1 = the first seed). */
  tries: number;
}

/** The k-th seed in the retry sequence for a base seed (k = 0 is the base itself). */
export const retrySeed = (seed: number, k: number): number => (k === 0 ? seed : (seed + k * 7919) % 2147483647);

/** Generate from `seed`, moving to the next seed until a chunk passes the rule check. Null if none did. */
export function generateValidChunk(opts: ValidChunkOptions = {}): ValidChunk | null {
  const tries = Math.max(1, Math.floor(opts.maxTries ?? 32));
  const base = Math.abs(Math.floor(opts.seed ?? 0));
  for (let k = 0; k < tries; k++) {
    const chunk = generateChunk({ ...opts, seed: retrySeed(base, k) });
    const verdict = checkChunk(chunk, opts.rules);
    if (!verdict.ok) continue;
    if (opts.accept && !opts.accept(chunk)) continue;
    return { chunk, verdict, tries: k + 1 };
  }
  return null;
}
