/**
 * Save format v2 (G-08) and import of old Pewter (v1) saves.
 *
 * v2 is human-readable JSON:
 *   {
 *     version: 2, w, h,
 *     grid:    string[h]  one char per cell: "0" empty or the tile id (1,4,5,6,7)
 *     authors: string[h]  one char per cell: "0" none, "1" person, "2" ghost
 *     provenance: { "<cellIndex>": "<suggestionId>" },
 *     entities: Entity[], entityAuthors: { id: author },
 *     start, goal?, history?, playSettings?, savedAt?, app?
 *   }
 *
 * Loading never throws and never mutates the model on bad input: it returns
 * { ok: false, error } with a message fit for the person.
 */
import { z } from "zod";
import {
  AUTHOR,
  LEVEL_H,
  LEVEL_W,
  TILE,
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

/** Player spawn of old Pewter: pixel (100, 100) with 16 px tiles. */
export const V1_START = { x: 6, y: 6 } as const;
const V1_TILE_PX = 16;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Game-feel settings stored with the level (G-37). Multipliers, 1 = default. */
export interface PlaySettings {
  gravityScale?: number;
  speedScale?: number;
  jumpScale?: number;
  enemyAggression?: number;
}

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
  playSettings?: PlaySettings;
  savedAt?: string;
  app?: string;
}

export interface SaveExtras {
  history?: SuggestionHistorySummary;
  playSettings?: PlaySettings;
  /** ISO time; defaults to now. Pass null to omit (golden files). */
  savedAt?: string | null;
  app?: string;
}

export type LoadResult =
  | {
      ok: true;
      snapshot: LevelSnapshot;
      /** The file as v2 (migrated when it was v1). */
      file: SaveFileV2;
      /** 1 when the input was an old Pewter save. */
      migratedFrom?: 1;
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
const multiplier = z.number().finite().min(0.1).max(10);

const entitySchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(ENTITY_KINDS as [EntityKind, ...EntityKind[]]),
  x: int.min(0),
  y: int.min(0),
  patrol: z.tuple([int, int]).optional(),
  text: z.string().max(500).optional(),
});

export const playSettingsSchema = z
  .object({
    gravityScale: multiplier.optional(),
    speedScale: multiplier.optional(),
    jumpScale: multiplier.optional(),
    enemyAggression: z.number().finite().min(0).max(10).optional(),
  })
  .strict();

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
  playSettings: playSettingsSchema.optional(),
  savedAt: z.string().max(64).optional(),
  app: z.string().max(100).optional(),
});

/** Old Pewter save: tile layers as sparse lists plus enemies in pixels. */
const v1TileSchema = z.object({ x: z.number(), y: z.number(), index: z.number() });
const saveV1Schema = z
  .object({
    version: z.literal(1).optional(),
    groundTiles: z.array(v1TileSchema).optional(),
    collectablesTiles: z.array(v1TileSchema).optional(),
    enemies: z
      .array(
        z
          .object({
            kind: z.string(),
            spawnX: z.number(),
            spawnY: z.number(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

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
  if (extras.playSettings) file.playSettings = { ...extras.playSettings };
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
 * Parse a save (JSON text or an already-parsed value). Accepts v2 and old
 * Pewter v1 saves. Never throws.
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
    if (version === 1 || (version === undefined && "groundTiles" in data)) return importV1(data);
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
    playSettings: f.playSettings,
    savedAt: f.savedAt ?? null,
    app: f.app,
  });
  return { ok: true, snapshot: checked.snapshot, file, warnings: checked.warnings };
}

const V1_TERRAIN = new Set<number>([TILE.BLOCK, TILE.GRASS_HALF, TILE.DIRT, TILE.GRASS, TILE.QUESTION]);
const V1_ENTITY: Record<number, EntityKind> = { 2: "coin", 3: "fruit", 8: "ultraslime", 9: "slime" };

/**
 * Convert an old Pewter save (tile layers + pixel enemies) to v2. Every tile
 * and entity gets author = PERSON. Bad entries are skipped with a warning
 * instead of wiping the level (the old loader's bug). Never throws.
 */
export function importV1(data: unknown, size: { w: number; h: number } = { w: LEVEL_W, h: LEVEL_H }): LoadResult {
  const parsed = saveV1Schema.safeParse(data);
  if (!parsed.success) return { ok: false, error: `This old Pewter save is damaged: ${zodMessage(parsed.error)}` };
  const v1 = parsed.data;
  const { w, h } = size;
  const n = w * h;
  const cells = new Array<number>(n).fill(0);
  const authors = new Array<number>(n).fill(0);
  const entities: Entity[] = [];
  const entityAuthors: Record<string, Author> = {};
  const warnings: string[] = [];
  const occupied = new Map<number, string>();
  let outside = 0;
  const unknown = new Map<number, number>();
  let nextId = 0;

  const inLevel = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < w && y < h;
  const addEntity = (kind: EntityKind, x: number, y: number): boolean => {
    const i = y * w + x;
    const there = occupied.get(i);
    if (there) {
      const other = entities.find((e) => e.id === there)!;
      if (other.kind !== kind) warnings.push(`skipped ${kind} at x=${x} y=${y}: a ${other.kind} is already there`);
      return false;
    }
    const id = `e${++nextId}`;
    entities.push({ id, kind, x, y });
    entityAuthors[id] = AUTHOR.PERSON;
    occupied.set(i, id);
    return true;
  };

  const tiles = [...(v1.groundTiles ?? []), ...(v1.collectablesTiles ?? [])];
  // Terrain first so entities placed on solid cells can be detected.
  for (const t of tiles) {
    if (t.index < 0) continue; // -1 = empty in Phaser
    if (!V1_TERRAIN.has(t.index)) continue;
    if (!inLevel(t.x, t.y)) {
      outside++;
      continue;
    }
    cells[t.y * w + t.x] = t.index;
    authors[t.y * w + t.x] = AUTHOR.PERSON;
  }
  for (const t of tiles) {
    if (t.index <= 0 || V1_TERRAIN.has(t.index)) continue;
    const kind = V1_ENTITY[t.index];
    if (!kind) {
      unknown.set(t.index, (unknown.get(t.index) ?? 0) + 1);
      continue;
    }
    if (!inLevel(t.x, t.y)) {
      outside++;
      continue;
    }
    if (cells[t.y * w + t.x] !== 0) {
      warnings.push(`skipped ${kind} at x=${t.x} y=${t.y}: the cell is solid`);
      continue;
    }
    addEntity(kind, t.x, t.y);
  }
  for (const e of v1.enemies ?? []) {
    const kind: EntityKind | undefined = e.kind === "Slime" ? "slime" : e.kind === "UltraSlime" ? "ultraslime" : undefined;
    if (!kind) {
      warnings.push(`skipped a "${String(e.kind).slice(0, 40)}" enemy: custom enemies are not supported`);
      continue;
    }
    const x = Math.floor(e.spawnX / V1_TILE_PX);
    const y = Math.floor(e.spawnY / V1_TILE_PX);
    if (!inLevel(x, y)) {
      outside++;
      continue;
    }
    if (cells[y * w + x] !== 0) {
      warnings.push(`skipped ${kind} at x=${x} y=${y}: the cell is solid`);
      continue;
    }
    // Enemies also present as tiles 8/9 at the same cell are the same enemy.
    addEntity(kind, x, y);
  }
  if (outside) warnings.push(`skipped ${outside} item(s) outside the ${w}x${h} level`);
  for (const [idx, count] of unknown) warnings.push(`skipped ${count} tile(s) with unknown index ${idx}`);

  const start = { x: Math.min(V1_START.x, w - 1), y: Math.min(V1_START.y, h - 1) };
  const snap: LevelSnapshot = { w, h, cells, authors, provenance: {}, entities, entityAuthors, start };
  if (cells[start.y * w + start.x] !== 0) warnings.push("the old start cell is solid; move the start");
  const checked = checkSnapshot(snap);
  if (!checked.ok) return { ok: false, error: `Could not convert this old Pewter save: ${checked.error}` };
  return {
    ok: true,
    snapshot: checked.snapshot,
    file: snapshotToSave(checked.snapshot, { savedAt: null }),
    migratedFrom: 1,
    warnings: [...warnings, ...checked.warnings],
  };
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
