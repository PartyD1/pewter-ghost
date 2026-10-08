/**
 * Reconciling a speculative answer with the level as it is when the answer
 * arrives (plan §8 timing budget, "Reconciliation": "If the person drew on
 * the suggestion's cells since the request, drop it. If they are still
 * drawing the same pattern, apply.").
 *
 * Every placement fires a model call and older calls keep running (up to
 * config.maxInFlight), so answers arrive 2-6 s after their request and out of
 * order. Before verification the fill loop checks each one against what
 * changed since its request, in this order:
 *
 *  1. too old: the request was built more than config.maxAnswerAgeMs ago ->
 *     drop "stale: too old".
 *  2. cells: for every cell the answer touches, compare the level at request
 *     time with the level now.
 *       - unchanged -> keep the cell;
 *       - the person has since put exactly what the answer proposes there
 *         (same tile, erased for a removal, same entity kind) -> trim it off:
 *         they are continuing the same pattern;
 *       - anything else (another tile, an erase of a proposed tile, ...) ->
 *         drop the whole answer "stale: cells drawn".
 *     If every cell was trimmed -> drop "stale: all cells drawn" (the answer
 *     was right, but the person got there first).
 *  3. newer shown: an answer to a NEWER request whose cells overlap this one
 *     (bounding boxes grown by config.cooldownMarginTiles) was already
 *     verified and offered -> drop "stale: newer shown". An older answer
 *     never replaces a newer one; a newer answer replaces an older one only
 *     through the SuggestionManager's normal rules.
 *
 * 1 and 3 are checked again after verification (it can take a send-back),
 * just before the offer. Pure, no Phaser: cells are read through CellReader,
 * which LevelModel and `snapshotReader(snapshot)` both satisfy.
 */
import type { EntityKind, LevelSnapshot, Point, Suggestion } from "../contracts";
import { boxesOverlap, suggestionBox, type Box } from "../suggest/geometry";

/** fill.call `reason` for an answer dropped by reconciliation (logged with superseded: true). */
export const STALE = {
  tooOld: "stale: too old",
  cellsDrawn: "stale: cells drawn",
  allDrawn: "stale: all cells drawn",
  newerShown: "stale: newer shown",
} as const;
export type StaleReason = (typeof STALE)[keyof typeof STALE];

/** What reconciliation reads from a level (LevelModel fits). */
export interface CellReader {
  tileAt(x: number, y: number): number;
  entitiesAt(x: number, y: number): readonly { kind: EntityKind }[];
}

/** A CellReader over a snapshot (the level as it was when a request was built). */
export function snapshotReader(s: LevelSnapshot): CellReader {
  const byCell = new Map<number, { kind: EntityKind }[]>();
  for (const e of s.entities) {
    const i = e.y * s.w + e.x;
    const list = byCell.get(i);
    if (list) list.push(e);
    else byCell.set(i, [e]);
  }
  const inside = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < s.w && y < s.h;
  return {
    // 0 outside the level, like LevelModel.tileAt.
    tileAt: (x, y) => (inside(x, y) ? s.cells[y * s.w + x] : 0),
    entitiesAt: (x, y) => (inside(x, y) ? byCell.get(y * s.w + x) ?? [] : []),
  };
}

const kindsAt = (r: CellReader, x: number, y: number): string =>
  r
    .entitiesAt(x, y)
    .map((e) => e.kind)
    .sort()
    .join(",");

type CellFate = "keep" | "done" | "conflict";

/** One add: the tile is what matters (accepting clears any entity in the cell). */
function addFate(then: CellReader, now: CellReader, x: number, y: number, tile: number): CellFate {
  const after = now.tileAt(x, y);
  if (after === then.tileAt(x, y)) return "keep";
  return after === tile ? "done" : "conflict";
}

function removeFate(then: CellReader, now: CellReader, x: number, y: number): CellFate {
  const after = now.tileAt(x, y);
  if (after === then.tileAt(x, y)) return "keep";
  return after === 0 ? "done" : "conflict";
}

function entityFate(then: CellReader, now: CellReader, x: number, y: number, kind: EntityKind): CellFate {
  if (now.tileAt(x, y) === then.tileAt(x, y) && kindsAt(now, x, y) === kindsAt(then, x, y)) return "keep";
  return now.entitiesAt(x, y).some((e) => e.kind === kind) ? "done" : "conflict";
}

export interface CellsReconcile {
  /** The answer, minus the cells already drawn as proposed; null when dropped. */
  suggestion: Suggestion | null;
  /** Items (adds, removes, entities) trimmed because the person drew exactly them. */
  trimmed: number;
  /** Cells drawn with something else since the request (non-empty means dropped). */
  conflicts: Point[];
  reason?: StaleReason;
}

/** Same rule as fill/answer.ts: a fix's first removal, else the first add, entity, removal. */
function anchorOf(s: Pick<Suggestion, "kind" | "adds" | "removes" | "entities">, fallback: Point): Point {
  if (s.kind === "fix" && s.removes.length) return { ...s.removes[0] };
  if (s.adds.length) return { x: s.adds[0].x, y: s.adds[0].y };
  if (s.entities.length) return { x: s.entities[0].x, y: s.entities[0].y };
  if (s.removes.length) return { ...s.removes[0] };
  return { ...fallback };
}

/**
 * Step 2 above: compare every cell of `s` between the level at request time
 * (`then`) and now. Never mutates `s`.
 */
export function reconcileCells(s: Suggestion, then: CellReader, now: CellReader): CellsReconcile {
  const conflicts: Point[] = [];
  let trimmed = 0;
  const keep = <T extends { x: number; y: number }>(items: readonly T[], fate: (c: T) => CellFate): T[] =>
    items.filter((c) => {
      const f = fate(c);
      if (f === "conflict") conflicts.push({ x: c.x, y: c.y });
      else if (f === "done") trimmed++;
      return f === "keep";
    });
  const adds = keep(s.adds, (c) => addFate(then, now, c.x, c.y, c.tile));
  const removes = keep(s.removes, (c) => removeFate(then, now, c.x, c.y));
  const entities = keep(s.entities, (c) => entityFate(then, now, c.x, c.y, c.kind));

  if (conflicts.length) return { suggestion: null, trimmed, conflicts, reason: STALE.cellsDrawn };
  if (trimmed === 0) return { suggestion: s, trimmed, conflicts };
  if (adds.length + removes.length + entities.length === 0) {
    return { suggestion: null, trimmed, conflicts, reason: STALE.allDrawn };
  }
  const kept = { kind: s.kind, adds, removes, entities };
  const anchorKept = [...adds, ...removes, ...entities].some((c) => c.x === s.anchor.x && c.y === s.anchor.y);
  return {
    suggestion: { ...s, adds, removes, entities, anchor: anchorKept ? { ...s.anchor } : anchorOf(kept, s.anchor) },
    trimmed,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// Offers: the "newer shown" rule
// ---------------------------------------------------------------------------

interface OfferEntry {
  seq: number;
  box: Box;
  at: number;
}

/**
 * The answers the loop verified and offered (shown or held by the manager),
 * keyed by the sequence number of their request, so a late answer to an
 * older request can tell that a newer one already covers its area.
 */
export class OfferLedger {
  private entries: OfferEntry[] = [];

  constructor(private readonly cap = 32) {}

  get size(): number {
    return this.entries.length;
  }

  record(seq: number, s: Suggestion, at: number): void {
    this.entries.push({ seq, box: suggestionBox(s), at });
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
  }

  /** Was an answer to a request newer than `seq`, overlapping `s` (with `margin` tiles), offered? */
  newerOverlapping(seq: number, s: Suggestion, margin: number): boolean {
    const box = suggestionBox(s);
    return this.entries.some((e) => e.seq > seq && boxesOverlap(e.box, box, margin));
  }

  /**
   * Forget offers made before `t`. Safe with t = now - maxAnswerAgeMs: any
   * answer older than such an offer is itself older than maxAnswerAgeMs.
   */
  prune(t: number): void {
    if (this.entries.length) this.entries = this.entries.filter((e) => e.at >= t);
  }

  clear(): void {
    this.entries = [];
  }
}

// ---------------------------------------------------------------------------
// The whole check
// ---------------------------------------------------------------------------

export interface AnswerContext {
  /** Request sequence number (higher = built later). */
  seq: number;
  /** When the request was built (session clock). */
  requestedAt: number;
  /** Now (session clock). */
  now: number;
  ledger: OfferLedger;
  maxAgeMs: number;
  /** Tiles a newer offer's box is grown by when testing overlap (config.cooldownMarginTiles). */
  margin: number;
}

/** Steps 1 and 3 (age, newer shown): the checks repeated just before an offer. */
export function freshness(s: Suggestion, c: AnswerContext): StaleReason | null {
  if (c.now - c.requestedAt > c.maxAgeMs) return STALE.tooOld;
  if (c.ledger.newerOverlapping(c.seq, s, c.margin)) return STALE.newerShown;
  return null;
}

/** All three steps for an answer that just arrived: drop, trim, or keep as is. */
export function reconcileAnswer(s: Suggestion, then: CellReader, now: CellReader, c: AnswerContext): CellsReconcile {
  if (c.now - c.requestedAt > c.maxAgeMs) return { suggestion: null, trimmed: 0, conflicts: [], reason: STALE.tooOld };
  const cells = reconcileCells(s, then, now);
  if (!cells.suggestion) return cells;
  const stale = freshness(cells.suggestion, c);
  return stale ? { ...cells, suggestion: null, reason: stale } : cells;
}
