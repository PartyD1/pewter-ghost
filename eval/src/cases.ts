/**
 * Loading, rebuilding and reconstructing eval cases.
 *
 *  - loadCases(paths): JSONL files of either EvalCase lines (eval/data) or the
 *    proxy's Recording lines (proxy/.data/recordings); directories are read
 *    for *.jsonl. Recordings become cases grouped by session in time order.
 *  - buildCaseRequest(state, opts): the ONE place a request is built from a
 *    level + stream state (seed generation and window-size rebuilds use it,
 *    so a rebuild with the recorded settings reproduces the stored request).
 *  - requestFor(case, config): the request a config sees (rebuilt when the
 *    window, summary or examples differ and the case can be rebuilt).
 *  - levelFor(case): the level the answer is verified against (the stored
 *    level, or one reconstructed from the window text for recordings).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  AUTHOR,
  LEVEL_H,
  LEVEL_W,
  TILE,
  type Entity,
  type EntityKind,
  type FillMode,
  type FillRequest,
  type GhostHistoryItem,
  type LevelSnapshot,
  type PlacementEvent,
  type Point,
  type Recording,
  type VerdictStage,
} from "../../apps/editor/src/contracts";
import { LevelModel } from "../../apps/editor/src/level/LevelModel";
import { parseSave, snapshotToSave, type SaveFileV2 } from "../../apps/editor/src/level/save";
import { PlacementStream } from "../../apps/editor/src/fill/stream";
import { buildFillRequest, gridRows } from "../../apps/editor/src/fill/window";
import { requestHashSync } from "../../apps/editor/src/fill/hash";
import { buildBrief, measureRequestWindow } from "../../apps/editor/src/fill/brief";
import { seedLibrary, type ExampleLibrary } from "../../apps/editor/src/fill/examples";
import type { BlockedInfo, EvalCase, RecordedAnswer, RunConfig, StreamState } from "./types";

// ---------------------------------------------------------------------------
// Building requests from a level + stream state
// ---------------------------------------------------------------------------

export interface CaseState {
  level: LevelSnapshot;
  stream: StreamState;
  mode: FillMode;
  lastGhosts?: GhostHistoryItem[];
  lastGuess?: string;
  previousFailure?: { reason: string; stage: VerdictStage };
  /** Patrol: where the agent got stuck (LEVEL coordinates). */
  blockedAt?: Point;
}

export interface BuildOptions {
  cols?: number;
  rows?: number;
  summary?: boolean;
  examples?: boolean;
  historyCount?: number;
}

/** Default window and history of the seed set (the live defaults in suggest/config). */
export const SEED_DEFAULTS = { cols: 24, rows: 12, historyCount: 5 } as const;

let library: ExampleLibrary | undefined;

/** Rebuild the model and stream from a state. */
export function restore(state: CaseState): { model: LevelModel; stream: PlacementStream } {
  const model = LevelModel.fromSnapshot(state.level);
  const stream = new PlacementStream({ clock: () => state.stream.now, recentCount: state.stream.recentCount });
  stream.setGrid(model);
  for (const e of state.stream.placements) stream.push(e);
  return { model, stream };
}

/** Build the FillRequest the app would send in this state (real window builder, brief and measures). */
export function buildCaseRequest(state: CaseState, opts: BuildOptions = {}): FillRequest {
  const { model, stream } = restore(state);
  const historyCount = opts.historyCount ?? SEED_DEFAULTS.historyCount;
  const brief = buildBrief({
    level: state.level,
    frontierX: stream.last?.x,
    focusX: state.blockedAt?.x,
    lastGhosts: state.lastGhosts,
    lastGuess: state.lastGuess,
    historyCount,
    examples: opts.examples ? { library: (library ??= seedLibrary()) } : undefined,
  });
  return buildFillRequest(model, stream, {
    now: state.stream.now,
    mode: state.mode,
    blockedAt: state.blockedAt,
    previousFailure: state.previousFailure,
    lastGhosts: state.lastGhosts,
    brief: brief.text,
    briefVersion: brief.version,
    measure: measureRequestWindow,
    cols: opts.cols ?? SEED_DEFAULTS.cols,
    rows: opts.rows ?? SEED_DEFAULTS.rows,
    summary: opts.summary ?? true,
    recentCount: state.stream.recentCount,
    historyCount,
  });
}

/** The case's state, if it carries a level and stream. */
export function caseState(c: EvalCase): CaseState | null {
  if (!c.level || !c.stream) return null;
  const loaded = parseSave(c.level);
  if (!loaded.ok) return null;
  return {
    level: loaded.snapshot,
    stream: c.stream,
    mode: c.request.mode,
    lastGhosts: c.request.lastGhosts,
    lastGuess: c.lastGuess,
    previousFailure: c.request.previousFailure,
    blockedAt: c.blocked?.blockedAt,
  };
}

/** Can the case be rebuilt (for another window size)? */
export const canRebuild = (c: EvalCase): boolean => !!c.level && !!c.stream;

/** Does `cfg` need a request different from the recorded one? */
export function needsRebuild(c: EvalCase, cfg: Pick<RunConfig, "window" | "summary" | "examples">): boolean {
  if (cfg.window && (cfg.window.cols !== c.request.size.w || cfg.window.rows !== c.request.size.h)) return true;
  if (cfg.summary !== undefined && cfg.summary !== (c.request.summary !== undefined)) return true;
  if (cfg.examples) return true;
  return false;
}

/**
 * The request this config sends. Returns null when the config needs a
 * rebuild the case cannot do (recordings have no full level). Summary-off on
 * a recording just drops the field.
 */
export function requestFor(c: EvalCase, cfg: Pick<RunConfig, "window" | "summary" | "examples">): FillRequest | null {
  if (!needsRebuild(c, cfg)) return c.request;
  const st = caseState(c);
  if (!st) {
    const sizeChanged = cfg.window && (cfg.window.cols !== c.request.size.w || cfg.window.rows !== c.request.size.h);
    if (sizeChanged || cfg.examples || cfg.summary === true) return null;
    const { summary: _drop, ...rest } = c.request;
    return rest;
  }
  return buildCaseRequest(st, {
    cols: cfg.window?.cols ?? c.request.size.w,
    rows: cfg.window?.rows ?? c.request.size.h,
    summary: cfg.summary ?? c.request.summary !== undefined,
    examples: cfg.examples,
  });
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const GLYPH_TILE: Record<string, { tile: number; author: number }> = {
  G: { tile: TILE.GRASS, author: AUTHOR.PERSON },
  D: { tile: TILE.DIRT, author: AUTHOR.PERSON },
  B: { tile: TILE.BLOCK, author: AUTHOR.PERSON },
  H: { tile: TILE.GRASS_HALF, author: AUTHOR.PERSON },
  Q: { tile: TILE.QUESTION, author: AUTHOR.PERSON },
  X: { tile: TILE.BLOCK, author: AUTHOR.PERSON },
  g: { tile: TILE.GRASS, author: AUTHOR.GHOST },
  d: { tile: TILE.DIRT, author: AUTHOR.GHOST },
  b: { tile: TILE.BLOCK, author: AUTHOR.GHOST },
  h: { tile: TILE.GRASS_HALF, author: AUTHOR.GHOST },
  q: { tile: TILE.QUESTION, author: AUTHOR.GHOST },
  x: { tile: TILE.BLOCK, author: AUTHOR.GHOST },
};
const GLYPH_ENTITY: Record<string, EntityKind> = {
  o: "coin",
  "*": "fruit",
  S: "slime",
  U: "ultraslime",
  F: "flag",
  "!": "sign",
};

/**
 * A level reconstructed from a request's window text: the window's tiles and
 * entities at `origin`, everything outside empty. The start is the '@' glyph
 * or, failing that, the leftmost standable cell of the window. Good enough for
 * the validator and the agent, which only look at the section around the
 * answer; the brief's screen measures would differ (outside is unknown).
 */
export function levelFromRequest(req: Pick<FillRequest, "grid" | "origin" | "size">): LevelSnapshot {
  const rows = gridRows(req.grid);
  const w = Math.max(LEVEL_W, req.origin.x + req.size.w);
  const h = Math.max(LEVEL_H, req.origin.y + req.size.h);
  const cells = new Array<number>(w * h).fill(0);
  const authors = new Array<number>(w * h).fill(0);
  const provenance: Record<number, string> = {};
  const entities: Entity[] = [];
  const entityAuthors: Record<string, 0 | 1 | 2> = {};
  let start: Point | undefined;
  rows.forEach((row, wy) => {
    [...row].forEach((g, wx) => {
      const x = req.origin.x + wx;
      const y = req.origin.y + wy;
      if (x >= w || y >= h) return;
      const i = y * w + x;
      const t = GLYPH_TILE[g];
      if (t) {
        cells[i] = t.tile;
        authors[i] = t.author;
        if (t.author === AUTHOR.GHOST) provenance[i] = "recorded";
        return;
      }
      const k = GLYPH_ENTITY[g];
      if (k) {
        const id = `r${entities.length + 1}`;
        entities.push({ id, kind: k, x, y });
        entityAuthors[id] = AUTHOR.PERSON;
        return;
      }
      if (g === "@") start = { x, y };
    });
  });
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] !== 0;
  if (!start) {
    outer: for (let x = req.origin.x; x < req.origin.x + req.size.w && x < w; x++)
      for (let y = req.origin.y; y + 1 < Math.min(h, req.origin.y + req.size.h); y++)
        if (!solid(x, y) && solid(x, y + 1)) {
          start = { x, y };
          break outer;
        }
  }
  start ??= { x: Math.min(w - 1, req.origin.x), y: Math.max(0, Math.min(h - 1, req.origin.y)) };
  const snap: LevelSnapshot = { w, h, cells, authors, provenance, entities, entityAuthors, start };
  // fromSnapshot normalises (enemy patrol spans) and validates.
  return LevelModel.fromSnapshot(snap).snapshot();
}

/** The level an answer to this case is judged against. */
export function levelFor(c: EvalCase): LevelSnapshot {
  if (c.level) {
    const r = parseSave(c.level);
    if (r.ok) return r.snapshot;
  }
  return levelFromRequest(c.request);
}

/** Compact level for storage in a case. */
export function packLevel(snap: LevelSnapshot): SaveFileV2 {
  return snapshotToSave(snap, { savedAt: null });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function isRequest(v: unknown): v is FillRequest {
  return (
    isObj(v) &&
    typeof v.grid === "string" &&
    isObj(v.origin) &&
    isObj(v.size) &&
    typeof v.mode === "string" &&
    Array.isArray(v.recent) &&
    Array.isArray(v.lastGhosts)
  );
}

/** Is this JSON line an EvalCase (vs a Recording)? */
export function isEvalCase(v: unknown): v is EvalCase {
  return isObj(v) && typeof v.id === "string" && (v.source === "seed" || v.source === "recording") && isRequest(v.request);
}

export function isRecording(v: unknown): v is Recording {
  return isObj(v) && typeof v.sessionId === "string" && typeof v.requestHash === "string" && isRequest(v.request);
}

/** Recorded answer fields of a Recording. */
export function recordedOf(r: Recording): RecordedAnswer {
  const out: RecordedAnswer = {
    answer: r.answer,
    latencyMs: r.latencyMs,
    model: r.model,
    promptVersion: r.promptVersion,
  };
  if (r.answers) out.answers = r.answers;
  if (r.logprob !== undefined) out.logprob = r.logprob;
  if (r.error) out.error = r.error;
  if (r.temperature !== undefined) out.temperature = r.temperature;
  if (r.samples) out.samples = r.samples;
  if (r.raw) out.raw = r.raw;
  return out;
}

/** Recordings -> cases, grouped by session and ordered by time. */
export function casesFromRecordings(recs: readonly Recording[]): EvalCase[] {
  const bySession = new Map<string, Recording[]>();
  for (const r of recs) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }
  const out: EvalCase[] = [];
  for (const [sessionId, list] of [...bySession].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.t.localeCompare(b.t));
    list.forEach((r, seq) => {
      out.push({
        id: `${sessionId}#${seq}`,
        source: "recording",
        sessionId,
        seq,
        t: r.t,
        request: r.request,
        requestHash: r.requestHash,
        recorded: recordedOf(r),
      });
    });
  }
  return out;
}

export interface LoadReport {
  cases: EvalCase[];
  files: string[];
  badLines: { file: string; line: number }[];
}

/** Expand files and directories to *.jsonl files (sorted). */
export function listJsonl(inputs: readonly string[]): string[] {
  const files: string[] = [];
  for (const p of inputs) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (f.endsWith(".jsonl")) files.push(path.join(p, f));
    } else files.push(p);
  }
  return files;
}

/** Parse JSONL text into case lines and recording lines. */
export function parseCaseLines(text: string, file = "<text>"): { cases: EvalCase[]; recordings: Recording[]; bad: { file: string; line: number }[] } {
  const cases: EvalCase[] = [];
  const recordings: Recording[] = [];
  const bad: { file: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      bad.push({ file, line: i + 1 });
      return;
    }
    if (isEvalCase(v)) cases.push(v);
    else if (isRecording(v)) recordings.push(v);
    else bad.push({ file, line: i + 1 });
  });
  return { cases, recordings, bad };
}

/** Load every case from the given files / directories. Duplicate ids keep the first. */
export function loadCases(inputs: readonly string[]): LoadReport {
  const files = listJsonl(inputs);
  const cases: EvalCase[] = [];
  const recordings: Recording[] = [];
  const badLines: LoadReport["badLines"] = [];
  for (const f of files) {
    const r = parseCaseLines(readFileSync(f, "utf8"), f);
    cases.push(...r.cases);
    recordings.push(...r.recordings);
    badLines.push(...r.bad);
  }
  cases.push(...casesFromRecordings(recordings));
  const seen = new Set<string>();
  const unique = cases.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  return { cases: unique, files, badLines };
}

/** Filter cases: by family, tag, mode or id substring; then limit. */
export function filterCases(
  cases: readonly EvalCase[],
  f: { family?: string; tag?: string; mode?: FillMode; match?: string; limit?: number } = {},
): EvalCase[] {
  let out = cases.filter(
    (c) =>
      (!f.family || c.family === f.family) &&
      (!f.tag || (c.tags ?? []).includes(f.tag)) &&
      (!f.mode || c.request.mode === f.mode) &&
      (!f.match || c.id.includes(f.match)),
  );
  if (f.limit !== undefined && f.limit >= 0) out = out.slice(0, f.limit);
  return out;
}

/** Hash a request as the app does. */
export const hashRequest = (req: FillRequest): string => requestHashSync(req);

/** Keep the last n placement events (n = recentCount + 1 so the first dt survives a rebuild). */
export function streamState(events: readonly PlacementEvent[], now: number, recentCount: number): StreamState {
  return { placements: events.slice(-(recentCount + 1)).map((e) => ({ ...e })), now, recentCount };
}

export type { BlockedInfo };
