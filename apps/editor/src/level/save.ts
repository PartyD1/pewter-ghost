/**
 * Save format v2 (G-08).
 *
 * v2 is human-readable JSON:
 *   {
 *     version: 2, w, h,
 *     grid:    string[h]  one char per cell: "0" empty or the tile id (1,4,5,6,7)
 *     authors: string[h]  one char per cell: "0" none, "1" person, "2" ghost
 *     provenance: { "<cellIndex>": "<suggestionId>" },
 *     entities: Entity[], entityAuthors: { id: author },
 *     start, goal?, history?, savedAt?, app?
 *   }
 *
 * Loading never throws and never mutates the model on bad input: it returns
 * { ok: false, error } with a message fit for the person.
 */
import { z } from "zod";
import {
  type Author,
  type Entity,
  type EntityKind,
  type GhostOutcome,
  type LevelSnapshot,
  type SuggestionKind,
} from "../contracts";
import { ENTITY_KINDS } from "./entities";
import type { LevelModel } from "./LevelModel";
import { checkSnapshot, MAX_ENTITIES, MAX_LEVEL_DIM } from "./snapshot";

export const SAVE_VERSION = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuggestionHistoryItem {
  id: string;
  kind: SuggestionKind;
  label: string;
  outcome: GhostOutcome;
  /** Cells shown in the ghost. */
  cells?: number;
  /** Cells kept when accepted (partial accept may keep fewer). */
  acceptedCells?: number;
  filler?: string;
  t?: number;
}

/** A short summary of the session's suggestions, saved with the level. */
export interface SuggestionHistorySummary {
  shown: number;
  /** Count per outcome. */
  outcomes: Partial<Record<GhostOutcome, number>>;
  /** Most recent items (capped). */
  recent: SuggestionHistoryItem[];
}

export interface SaveFileV2 {
  version: 2;
  w: number;
  h: number;
  grid: string[];
  authors: string[];
  provenance: Record<string, string>;
  entities: Entity[];
  entityAuthors: Record<string, Author>;
  start: { x: number; y: number };
  goal?: { x: number; y: number };
  history?: SuggestionHistorySummary;
  savedAt?: string;
  app?: string;
}

export interface SaveExtras {
  history?: SuggestionHistorySummary;
  /** ISO time; defaults to now. Pass null to omit (golden files). */
  savedAt?: string | null;
  app?: string;
}

export type LoadResult =
  | {
      ok: true;
      snapshot: LevelSnapshot;
      file: SaveFileV2;
      warnings: string[];
    }
  | { ok: false; error: string };

export const MAX_HISTORY_ITEMS = 200;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const int = z.number().int();
const point = z.object({ x: int.min(0), y: int.min(0) });
const authorSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const outcomeSchema = z.enum(["accepted", "partial", "esc", "drawn-over", "replaced", "timeout", "pending"]);

const entitySchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(ENTITY_KINDS as [EntityKind, ...EntityKind[]]),
  x: int.min(0),
  y: int.min(0),
  patrol: z.tuple([int, int]).optional(),
  text: z.string().max(500).optional(),
});

const historySchema = z.object({
  shown: int.min(0),
  outcomes: z.partialRecord(outcomeSchema, int.min(0)),
  recent: z
    .array(
      z.object({
        id: z.string().max(200),
        kind: z.enum(["finish", "extend", "fix"]),
        label: z.string().max(200),
        outcome: outcomeSchema,
        cells: int.min(0).optional(),
        acceptedCells: int.min(0).optional(),
        filler: z.string().max(40).optional(),
        t: z.number().finite().optional(),
      }),
    )
    .max(MAX_HISTORY_ITEMS),
});

const saveV2Schema = z.object({
  version: z.literal(2),
  w: int.min(1).max(MAX_LEVEL_DIM),
  h: int.min(1).max(MAX_LEVEL_DIM),
  grid: z.array(z.string().regex(/^[014567]*$/, "grid rows may only contain 0,1,4,5,6,7")),
  authors: z.array(z.string().regex(/^[012]*$/, "author rows may only contain 0,1,2")),
  provenance: z.record(z.string().regex(/^\d+$/, "provenance keys are cell indices"), z.string().min(1).max(200)),
  entities: z.array(entitySchema).max(MAX_ENTITIES),
  entityAuthors: z.record(z.string(), authorSchema),
  start: point,
  goal: point.optional(),
  history: historySchema.optional(),
  savedAt: z.string().max(64).optional(),
  app: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Build the v2 save object for a snapshot. */
export function snapshotToSave(snap: LevelSnapshot, extras: SaveExtras = {}): SaveFileV2 {
  const grid: string[] = [];
  const authors: string[] = [];
  for (let y = 0; y < snap.h; y++) {
    let g = "";
    let a = "";
    for (let x = 0; x < snap.w; x++) {
      g += String(snap.cells[y * snap.w + x]);
      a += String(snap.authors[y * snap.w + x]);
    }
    grid.push(g);
    authors.push(a);
  }
  const provenance: Record<string, string> = {};
  for (const k of Object.keys(snap.provenance).map(Number).sort((a, b) => a - b))
    provenance[String(k)] = snap.provenance[k];
  const file: SaveFileV2 = {
    version: 2,
    w: snap.w,
    h: snap.h,
    grid,
    authors,
    provenance,
    entities: snap.entities.map((e) => {
      const c: Entity = { id: e.id, kind: e.kind, x: e.x, y: e.y };
      if (e.patrol) c.patrol = [e.patrol[0], e.patrol[1]];
      if (e.text !== undefined) c.text = e.text;
      return c;
    }),
    entityAuthors: { ...snap.entityAuthors },
    start: { ...snap.start },
  };
  if (snap.goal) file.goal = { ...snap.goal };
  if (extras.history) file.history = capHistory(extras.history);
  if (extras.savedAt !== null) file.savedAt = extras.savedAt ?? new Date().toISOString();
  if (extras.app) file.app = extras.app;
  return file;
}

/** Build the v2 save object for the live model. */
export function toSaveFile(model: LevelModel, extras: SaveExtras = {}): SaveFileV2 {
  return snapshotToSave(model.snapshot(), extras);
}

/** JSON text for the live model. Rows stay one per line so diffs stay readable. */
export function serializeSave(model: LevelModel | LevelSnapshot, extras: SaveExtras = {}): string {
  const snap = "snapshot" in model ? model.snapshot() : model;
  return formatSave(snapshotToSave(snap, extras));
}

/** Pretty JSON with grid/author rows one per line and compact entities. */
export function formatSave(file: SaveFileV2): string {
  const lines: string[] = ["{"];
  const entries = Object.entries(file).filter(([, v]) => v !== undefined);
  entries.forEach(([k, v], idx) => {
    const comma = idx < entries.length - 1 ? "," : "";
    let body: string;
    if ((k === "grid" || k === "authors" || k === "entities") && Array.isArray(v)) {
      body = v.length
        ? "[\n" + v.map((r) => "    " + JSON.stringify(r)).join(",\n") + "\n  ]"
        : "[]";
    } else body = JSON.stringify(v);
    lines.push(`  ${JSON.stringify(k)}: ${body}${comma}`);
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

function capHistory(h: SuggestionHistorySummary): SuggestionHistorySummary {
  return {
    shown: h.shown,
    outcomes: { ...h.outcomes },
    recent: h.recent.slice(-MAX_HISTORY_ITEMS).map((i) => ({ ...i })),
  };
}

/** Summarise a list of ghost outcomes for the save file. */
export function summariseHistory(items: readonly SuggestionHistoryItem[]): SuggestionHistorySummary {
  const outcomes: Partial<Record<GhostOutcome, number>> = {};
  for (const i of items) outcomes[i.outcome] = (outcomes[i.outcome] ?? 0) + 1;
  return { shown: items.length, outcomes, recent: items.slice(-MAX_HISTORY_ITEMS).map((i) => ({ ...i })) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function zodMessage(err: z.ZodError): string {
  const first = err.issues.slice(0, 3).map((i) => {
    const path = i.path.length ? i.path.map(String).join(".") : "file";
    return `${path}: ${i.message}`;
  });
  const more = err.issues.length > 3 ? ` (+${err.issues.length - 3} more)` : "";
  return first.join("; ") + more;
}

/**
 * Parse a save (JSON text or an already-parsed value). Accepts v2 only.
 * Never throws.
 */
export function parseSave(input: string | unknown): LoadResult {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { ok: false, error: `This file is not valid JSON (${(err as Error).message}).` };
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, error: "This file is not a Pewter level." };
  const version = (data as { version?: unknown }).version;
  try {
    if (version === 2) return parseV2(data);
    if (typeof version === "number" && version > SAVE_VERSION)
      return { ok: false, error: `This level was saved by a newer Pewter (format ${version}).` };
    return { ok: false, error: "This file is not a Pewter level (no known version)." };
  } catch (err) {
    // Defensive: no input should reach here, but a load must never throw.
    return { ok: false, error: `Could not read this level: ${(err as Error).message}` };
  }
}

function parseV2(data: unknown): LoadResult {
  const parsed = saveV2Schema.safeParse(data);
  if (!parsed.success) return { ok: false, error: `This level file is damaged: ${zodMessage(parsed.error)}` };
  const f = parsed.data;
  if (f.grid.length !== f.h) return { ok: false, error: `grid has ${f.grid.length} rows; expected ${f.h}` };
  if (f.authors.length !== f.h) return { ok: false, error: `authors has ${f.authors.length} rows; expected ${f.h}` };
  const n = f.w * f.h;
  const cells = new Array<number>(n);
  const authors = new Array<number>(n);
  for (let y = 0; y < f.h; y++) {
    const g = f.grid[y];
    const a = f.authors[y];
    if (g.length !== f.w) return { ok: false, error: `grid row ${y} has ${g.length} cells; expected ${f.w}` };
    if (a.length !== f.w) return { ok: false, error: `authors row ${y} has ${a.length} cells; expected ${f.w}` };
    for (let x = 0; x < f.w; x++) {
      cells[y * f.w + x] = g.charCodeAt(x) - 48;
      authors[y * f.w + x] = a.charCodeAt(x) - 48;
    }
  }
  const provenance: Record<number, string> = {};
  for (const [k, v] of Object.entries(f.provenance)) provenance[Number(k)] = v;
  const snap: LevelSnapshot = {
    w: f.w,
    h: f.h,
    cells,
    authors,
    provenance,
    entities: f.entities as Entity[],
    entityAuthors: f.entityAuthors as Record<string, Author>,
    start: f.start,
  };
  if (f.goal) snap.goal = f.goal;
  const checked = checkSnapshot(snap);
  if (!checked.ok) return { ok: false, error: `This level file is damaged: ${checked.error}` };
  const file = snapshotToSave(checked.snapshot, {
    history: f.history as SuggestionHistorySummary | undefined,
    savedAt: f.savedAt ?? null,
    app: f.app,
  });
  return { ok: true, snapshot: checked.snapshot, file, warnings: checked.warnings };
}

/**
 * Parse and, only on success, load into the model (clearing its history).
 * On failure the model is untouched.
 */
export function loadSaveInto(model: LevelModel, input: string | unknown): LoadResult {
  const res = parseSave(input);
  if (!res.ok) return res;
  if (res.snapshot.w !== model.w || res.snapshot.h !== model.h)
    return {
      ok: false,
      error: `This level is ${res.snapshot.w}x${res.snapshot.h}; the editor uses ${model.w}x${model.h}.`,
    };
  try {
    const more = model.load(res.snapshot);
    return { ...res, warnings: [...res.warnings, ...more] };
  } catch (err) {
    return { ok: false, error: `Could not load this level: ${(err as Error).message}` };
  }
}

/** Suggested download name, e.g. pewter-level_2026-10-07_14-03-22.json */
export function saveFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `pewter-level_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(
    now.getMinutes(),
  )}-${p(now.getSeconds())}.json`;
}
