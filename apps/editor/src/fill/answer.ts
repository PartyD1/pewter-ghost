/**
 * ModelAnswer (window-relative, tile names) -> Suggestion (level coordinates,
 * TileIds). Pure and defensive: the model can return anything that passed the
 * schema, so every cell is checked here and the ones that cannot be placed are
 * dropped with a reason (the validator, G-15, judges what is left).
 *
 * Rules
 *  - Coordinates must be finite; non-integers are rounded to the nearest cell.
 *  - Cells outside the request's window are dropped (never clamped: a clamped
 *    tile lands somewhere the model did not mean).
 *  - Unknown tile names / entity kinds are dropped.
 *  - Duplicate cells: the first add / remove / entity wins.
 *  - A remove on a cell that is also an add is redundant (the add replaces the
 *    cell) and dropped; removes are kept only for kind "fix".
 *  - An entity on a cell that the suggestion makes solid is dropped.
 *  - confidence is clamped to [0, 1] (NaN -> 0); label is trimmed to 80 chars.
 *  - act: false, or nothing left after dropping, gives no suggestion.
 *  - anchor: for a fix the first remove (the fix point), else the first add,
 *    else the first entity, else the first remove.
 */
import {
  TILE_BY_NAME,
  type EntityKind,
  type FillRequest,
  type FillerName,
  type ModelAnswer,
  type Point,
  type Suggestion,
  type TileId,
  type TileName,
} from "../contracts";
import { isEntityKind } from "../level/entities";

export interface AnswerMeta {
  filler: FillerName;
  requestHash: string;
  latencyMs: number;
  /** Model attempts (default 1). */
  attempts?: number;
  /** Explicit id; otherwise one is generated. */
  id?: string;
  /** Id generator (default nextSuggestionId). */
  idGen?: (meta: { filler: FillerName; requestHash: string }) => string;
}

export type DropReason =
  | "not-finite"
  | "outside-window"
  | "unknown-tile"
  | "unknown-entity"
  | "duplicate"
  | "remove-under-add"
  | "remove-not-fix"
  | "entity-in-solid";

export interface DroppedItem {
  what: "add" | "remove" | "entity";
  /** Window-relative as the model gave it. */
  x: number;
  y: number;
  reason: DropReason;
}

export interface AnswerConversion {
  suggestion: Suggestion | null;
  dropped: DroppedItem[];
  /** Why there is no suggestion. */
  empty?: "declined" | "nothing-left";
}

let idCounter = 0;

/** Default id: "<filler>-<n>-<first 8 hex of requestHash>" (n counts per page load). */
export function nextSuggestionId(meta: { filler: FillerName; requestHash: string }): string {
  idCounter++;
  const h = (meta.requestHash || "nohash").slice(0, 8);
  return `${meta.filler}-${idCounter.toString(36)}-${h}`;
}

/** Test helper: restart the default id counter. */
export function resetSuggestionIds(): void {
  idCounter = 0;
}

const key = (x: number, y: number) => `${x},${y}`;

export function clampConfidence(c: unknown): number {
  const n = typeof c === "number" ? c : Number(c);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function cleanLabel(label: unknown): string {
  const s = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
  return s.length > 80 ? s.slice(0, 79).trimEnd() + "…" : s;
}

/** Convert with a full report of what was dropped. */
export function convertModelAnswer(
  answer: ModelAnswer,
  request: Pick<FillRequest, "origin" | "size" | "mode">,
  meta: AnswerMeta,
): AnswerConversion {
  const dropped: DroppedItem[] = [];
  if (!answer || !answer.act) return { suggestion: null, dropped, empty: "declined" };

  const { origin, size } = request;
  const cell = (what: DroppedItem["what"], p: { x: unknown; y: unknown }): Point | null => {
    const rx = Number(p.x);
    const ry = Number(p.y);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
      dropped.push({ what, x: rx, y: ry, reason: "not-finite" });
      return null;
    }
    const x = Math.round(rx);
    const y = Math.round(ry);
    if (x < 0 || y < 0 || x >= size.w || y >= size.h) {
      dropped.push({ what, x: rx, y: ry, reason: "outside-window" });
      return null;
    }
    return { x, y };
  };

  const isFix = answer.kind === "fix";
  const adds: Suggestion["adds"] = [];
  const addKeys = new Set<string>();
  for (const a of answer.adds ?? []) {
    const p = cell("add", a);
    if (!p) continue;
    const tile = Object.prototype.hasOwnProperty.call(TILE_BY_NAME, a.tile)
      ? (TILE_BY_NAME[a.tile as TileName] as TileId)
      : undefined;
    if (tile === undefined) {
      dropped.push({ what: "add", x: a.x, y: a.y, reason: "unknown-tile" });
      continue;
    }
    const k = key(p.x, p.y);
    if (addKeys.has(k)) {
      dropped.push({ what: "add", x: a.x, y: a.y, reason: "duplicate" });
      continue;
    }
    addKeys.add(k);
    adds.push({ x: p.x + origin.x, y: p.y + origin.y, tile });
  }

  const removes: Point[] = [];
  const removeKeys = new Set<string>();
  for (const r of answer.removes ?? []) {
    const p = cell("remove", r);
    if (!p) continue;
    const k = key(p.x, p.y);
    if (!isFix) {
      dropped.push({ what: "remove", x: r.x, y: r.y, reason: "remove-not-fix" });
      continue;
    }
    if (addKeys.has(k)) {
      dropped.push({ what: "remove", x: r.x, y: r.y, reason: "remove-under-add" });
      continue;
    }
    if (removeKeys.has(k)) {
      dropped.push({ what: "remove", x: r.x, y: r.y, reason: "duplicate" });
      continue;
    }
    removeKeys.add(k);
    removes.push({ x: p.x + origin.x, y: p.y + origin.y });
  }

  const entities: Suggestion["entities"] = [];
  const entKeys = new Set<string>();
  for (const e of answer.entities ?? []) {
    const p = cell("entity", e);
    if (!p) continue;
    if (!isEntityKind(e.kind)) {
      dropped.push({ what: "entity", x: e.x, y: e.y, reason: "unknown-entity" });
      continue;
    }
    const k = key(p.x, p.y);
    if (addKeys.has(k)) {
      dropped.push({ what: "entity", x: e.x, y: e.y, reason: "entity-in-solid" });
      continue;
    }
    if (entKeys.has(k)) {
      dropped.push({ what: "entity", x: e.x, y: e.y, reason: "duplicate" });
      continue;
    }
    entKeys.add(k);
    entities.push({ kind: e.kind as EntityKind, x: p.x + origin.x, y: p.y + origin.y });
  }

  if (adds.length + removes.length + entities.length === 0) return { suggestion: null, dropped, empty: "nothing-left" };

  const anchor: Point =
    isFix && removes.length ? { ...removes[0] }
    : adds.length ? { x: adds[0].x, y: adds[0].y }
    : entities.length ? { x: entities[0].x, y: entities[0].y }
    : { ...removes[0] };

  const id = meta.id ?? (meta.idGen ?? nextSuggestionId)({ filler: meta.filler, requestHash: meta.requestHash });
  const suggestion: Suggestion = {
    id,
    kind: answer.kind,
    adds,
    removes,
    entities,
    confidence: clampConfidence(answer.confidence),
    label: cleanLabel(answer.label),
    anchor,
    requestHash: meta.requestHash,
    filler: meta.filler,
    latencyMs: Math.max(0, Math.round(meta.latencyMs)),
    mode: request.mode,
    verified: false,
    attempts: meta.attempts ?? 1,
  };
  const guess = typeof answer.levelGuess === "string" ? answer.levelGuess.trim() : "";
  if (guess) suggestion.levelGuess = guess.slice(0, 60);
  return { suggestion, dropped };
}

/** Convert a model answer to a Suggestion in level coordinates, or null (declined / nothing usable). */
export function modelAnswerToSuggestion(
  answer: ModelAnswer,
  request: Pick<FillRequest, "origin" | "size" | "mode">,
  meta: AnswerMeta,
): Suggestion | null {
  return convertModelAnswer(answer, request, meta).suggestion;
}
