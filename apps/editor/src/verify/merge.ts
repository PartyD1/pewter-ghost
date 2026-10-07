/**
 * Shared helpers for the verifier: read a level (live model or snapshot),
 * apply a suggestion to a COPY of it, and describe a suggestion's extent.
 *
 * Pure, no Phaser. The merge mirrors LevelModel.applySuggestion exactly
 * (removes first, then adds, then entities; an add or an entity clears any
 * entity in its cell; an entity clears a solid tile in its cell), so what the
 * verifier plays is what Tab would produce.
 */
import { gridFromCells, type SolidGrid } from "@physsim";
import {
  AUTHOR,
  SOLID_TILES,
  type Entity,
  type LevelSnapshot,
  type Point,
  type Suggestion,
} from "../contracts";

/** Anything the verifier can read a level from. */
export type LevelSource = LevelSnapshot | { snapshot(): LevelSnapshot };

/** The parts of a suggestion that change the level. */
export type SuggestionEdits = Pick<Suggestion, "adds" | "removes" | "entities">;

export function snapshotOf(level: LevelSource): LevelSnapshot {
  const maybe = level as { snapshot?: unknown };
  if (typeof maybe.snapshot === "function") return (level as { snapshot(): LevelSnapshot }).snapshot();
  return level as LevelSnapshot;
}

export const inBounds = (s: { w: number; h: number }, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < s.w && y < s.h;

/**
 * The level as it would be after accepting `s` (a fresh snapshot; the input
 * is not touched). Cells outside the level are ignored, like the model does.
 * New entity ids are `verify:<n>`.
 */
export function mergeSuggestion(snap: LevelSnapshot, s: SuggestionEdits): LevelSnapshot {
  const { w, h } = snap;
  const cells = snap.cells.slice();
  const authors = snap.authors.slice();
  const provenance: Record<number, string> = { ...snap.provenance };
  let entities: Entity[] = snap.entities.map((e) => ({ ...e }));
  const entityAuthors: Record<string, (typeof AUTHOR)[keyof typeof AUTHOR]> = { ...snap.entityAuthors };
  const clearEntitiesAt = (x: number, y: number) => {
    entities = entities.filter((e) => !(e.x === x && e.y === y));
  };
  for (const r of s.removes) {
    if (!inBounds(snap, r.x, r.y)) continue;
    const i = r.y * w + r.x;
    cells[i] = 0;
    authors[i] = AUTHOR.NONE;
    delete provenance[i];
    clearEntitiesAt(r.x, r.y);
  }
  for (const a of s.adds) {
    if (!inBounds(snap, a.x, a.y)) continue;
    const i = a.y * w + a.x;
    clearEntitiesAt(a.x, a.y);
    cells[i] = a.tile;
    authors[i] = AUTHOR.GHOST;
  }
  let n = 0;
  for (const en of s.entities) {
    if (!inBounds(snap, en.x, en.y)) continue;
    const i = en.y * w + en.x;
    clearEntitiesAt(en.x, en.y);
    if (SOLID_TILES.has(cells[i])) {
      cells[i] = 0;
      authors[i] = AUTHOR.NONE;
    }
    const id = `verify:${n++}`;
    entities.push({ id, kind: en.kind, x: en.x, y: en.y });
    entityAuthors[id] = AUTHOR.GHOST;
  }
  return {
    w,
    h,
    cells,
    authors,
    provenance,
    entities,
    entityAuthors,
    start: { ...snap.start },
    goal: snap.goal ? { ...snap.goal } : undefined,
  };
}

/** Solid map of a snapshot for the agent and the rule check. */
export function solidGridOf(snap: LevelSnapshot): SolidGrid & { solid: Uint8Array } {
  return gridFromCells(snap.cells, snap.w, snap.h);
}

export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Every distinct cell a suggestion touches (adds, removes, entities), in the given order. */
export function suggestionCells(s: SuggestionEdits): Point[] {
  const seen = new Set<string>();
  const out: Point[] = [];
  for (const p of [...s.adds, ...s.removes, ...s.entities]) {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Bounding box of a suggestion's cells, or null when it touches nothing. */
export function suggestionBounds(s: SuggestionEdits): Bounds | null {
  const cells = suggestionCells(s);
  if (cells.length === 0) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of cells) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { x0, x1, y0, y1 };
}

/** "x=41" or "x=41..43" for reasons. */
export function spanText(x0: number, x1: number): string {
  return x0 === x1 ? `x=${x0}` : `x=${x0}..${x1}`;
}

export const nowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();
