/**
 * Semantic checks for a LevelSnapshot, shared by the model (fromSnapshot),
 * the save loader and the share-code decoder.
 *
 * Errors make the snapshot unusable (wrong lengths, unknown tiles, duplicate
 * ids, out-of-bounds start). Inconsistencies the model can repair safely are
 * normalised and reported as warnings (author on an empty cell, provenance on a
 * non-ghost cell, two entities on one cell, ...).
 */
import {
  AUTHOR,
  SOLID_TILES,
  type Author,
  type Entity,
  type LevelSnapshot,
  type Point,
} from "../contracts";
import { cloneEntity, computePatrol, isEnemyKind, isEntityKind } from "./entities";

/** Hard cap on level dimensions accepted from files and share codes. */
export const MAX_LEVEL_DIM = 4096;
export const MAX_LEVEL_CELLS = 1 << 20;
export const MAX_ENTITIES = 10000;

export type SnapshotCheck =
  | { ok: true; snapshot: LevelSnapshot; warnings: string[] }
  | { ok: false; error: string };

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const isAuthor = (n: unknown): n is Author =>
  n === AUTHOR.NONE || n === AUTHOR.PERSON || n === AUTHOR.GHOST;

function inBounds(p: Point | undefined, w: number, h: number): boolean {
  return !!p && isInt(p.x) && isInt(p.y) && p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
}

/**
 * Validate and normalise. Never mutates the input; the returned snapshot is a
 * fresh deep copy.
 */
export function checkSnapshot(input: LevelSnapshot): SnapshotCheck {
  const warnings: string[] = [];
  const { w, h } = input;
  if (!isInt(w) || !isInt(h) || w < 1 || h < 1 || w > MAX_LEVEL_DIM || h > MAX_LEVEL_DIM)
    return { ok: false, error: `level size ${String(w)}x${String(h)} is not valid` };
  const n = w * h;
  if (n > MAX_LEVEL_CELLS) return { ok: false, error: `level has too many cells (${n})` };
  if (!Array.isArray(input.cells) || input.cells.length !== n)
    return { ok: false, error: `cells must have ${n} entries, got ${input.cells?.length}` };
  if (!Array.isArray(input.authors) || input.authors.length !== n)
    return { ok: false, error: `authors must have ${n} entries, got ${input.authors?.length}` };

  const cells = new Array<number>(n);
  const authors = new Array<number>(n);
  let emptyAuthored = 0;
  for (let i = 0; i < n; i++) {
    const t = input.cells[i];
    if (t !== 0 && !SOLID_TILES.has(t))
      return { ok: false, error: `unknown tile ${String(t)} at x=${i % w} y=${Math.floor(i / w)}` };
    const a = input.authors[i];
    if (!isAuthor(a))
      return { ok: false, error: `unknown author ${String(a)} at x=${i % w} y=${Math.floor(i / w)}` };
    cells[i] = t;
    if (t === 0 && a !== AUTHOR.NONE) {
      emptyAuthored++;
      authors[i] = AUTHOR.NONE;
    } else authors[i] = a;
  }
  if (emptyAuthored) warnings.push(`cleared author on ${emptyAuthored} empty cell(s)`);

  const provenance: Record<number, string> = {};
  let droppedProv = 0;
  for (const [k, v] of Object.entries(input.provenance ?? {})) {
    const i = Number(k);
    if (!isInt(i) || i < 0 || i >= n) return { ok: false, error: `provenance key ${k} is outside the level` };
    if (typeof v !== "string" || v.length === 0)
      return { ok: false, error: `provenance for cell ${k} must be a suggestion id` };
    if (authors[i] !== AUTHOR.GHOST) {
      droppedProv++;
      continue;
    }
    provenance[i] = v;
  }
  if (droppedProv) warnings.push(`dropped provenance on ${droppedProv} cell(s) not authored by Ghost`);

  if (!Array.isArray(input.entities)) return { ok: false, error: "entities must be a list" };
  if (input.entities.length > MAX_ENTITIES) return { ok: false, error: "too many entities" };
  const entities: Entity[] = [];
  const entityAuthors: Record<string, Author> = {};
  const ids = new Set<string>();
  const occupied = new Set<number>();
  for (const e of input.entities) {
    if (!e || typeof e.id !== "string" || e.id.length === 0)
      return { ok: false, error: "entity without an id" };
    if (ids.has(e.id)) return { ok: false, error: `duplicate entity id ${e.id}` };
    ids.add(e.id);
    if (!isEntityKind(e.kind)) return { ok: false, error: `entity ${e.id} has unknown kind ${String(e.kind)}` };
    if (!inBounds(e, w, h)) return { ok: false, error: `entity ${e.id} is outside the level` };
    if (e.text !== undefined && typeof e.text !== "string")
      return { ok: false, error: `entity ${e.id} text must be a string` };
    const ci = e.y * w + e.x;
    if (occupied.has(ci)) {
      warnings.push(`dropped entity ${e.id}: another entity already occupies x=${e.x} y=${e.y}`);
      continue;
    }
    occupied.add(ci);
    const c = cloneEntity(e);
    delete c.patrol; // derived; recomputed below
    entities.push(c);
    const a = input.entityAuthors?.[e.id];
    if (a === undefined) entityAuthors[e.id] = AUTHOR.PERSON;
    else if (!isAuthor(a)) return { ok: false, error: `entity ${e.id} has unknown author ${String(a)}` };
    else entityAuthors[e.id] = a;
  }
  const strayAuthors = Object.keys(input.entityAuthors ?? {}).filter((id) => !ids.has(id));
  if (strayAuthors.length) warnings.push(`ignored authors for ${strayAuthors.length} unknown entity id(s)`);

  if (!inBounds(input.start, w, h)) return { ok: false, error: "start is missing or outside the level" };
  if (input.goal !== undefined && input.goal !== null && !inBounds(input.goal, w, h))
    return { ok: false, error: "goal is outside the level" };

  const snapshot: LevelSnapshot = {
    w,
    h,
    cells,
    authors,
    provenance,
    entities,
    entityAuthors,
    start: { x: input.start.x, y: input.start.y },
  };
  if (input.goal) snapshot.goal = { x: input.goal.x, y: input.goal.y };
  derivePatrols(snapshot);
  return { ok: true, snapshot, warnings };
}

/** Set (or clear) every enemy's derived patrol span from the snapshot's grid. Mutates `snap`. */
export function derivePatrols(snap: LevelSnapshot): LevelSnapshot {
  const reader = {
    w: snap.w,
    h: snap.h,
    isSolid: (x: number, y: number) =>
      x >= 0 && y >= 0 && x < snap.w && y < snap.h && SOLID_TILES.has(snap.cells[y * snap.w + x]),
  };
  for (const e of snap.entities) {
    const p = isEnemyKind(e.kind) ? computePatrol(reader, e.x, e.y) : undefined;
    if (p) e.patrol = p;
    else delete e.patrol;
  }
  return snap;
}

/** An empty level of the given size with the default start. */
export function emptySnapshot(w: number, h: number, start: Point): LevelSnapshot {
  return {
    w,
    h,
    cells: new Array<number>(w * h).fill(0),
    authors: new Array<number>(w * h).fill(0),
    provenance: {},
    entities: [],
    entityAuthors: {},
    start: { ...start },
  };
}
