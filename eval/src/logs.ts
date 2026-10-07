/**
 * Session logs and recordings for the dashboard (G-29), calibration labels
 * (G-27) and export (G-38).
 *
 * Logs: proxy/.data/logs/<sessionId>.jsonl, one LogEvent per line (the
 * proxy writes only validated events; *.rejected.jsonl files are skipped).
 * Recordings: proxy/.data/recordings/<sessionId>.jsonl (contract Recording).
 *
 * Joining a ghost to the answer behind it: suggestion ids are
 * "<filler>-<n>-<first 8 hex of requestHash>" (fill/answer.ts), so the
 * ghost's id names the recording whose answer it showed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  GhostOutcome,
  LogEvent,
  Point,
  Recording,
  Suggestion,
  SuggestionKind,
} from "../../apps/editor/src/contracts";
import { isLogEvent } from "../../apps/editor/src/research/schema";
import { convertModelAnswer } from "../../apps/editor/src/fill/answer";
import { validateSuggestion } from "../../apps/editor/src/verify/validate";
import { suggestionCells } from "../../apps/editor/src/verify/merge";
import { isRecording, levelFromRequest } from "./cases";

export interface SessionLog {
  sessionId: string;
  events: LogEvent[];
  recordings: Recording[];
  /** Lines that were not valid events. */
  bad: number;
}

/** Parse a JSONL log (bad lines counted, not thrown). */
export function parseLog(text: string): { events: LogEvent[]; bad: number } {
  const events: LogEvent[] = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isLogEvent(v)) events.push(v);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { events, bad };
}

export function parseRecordings(text: string): Recording[] {
  const out: Recording[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isRecording(v)) out.push(v);
    } catch {
      /* skip */
    }
  }
  return out;
}

function jsonlFiles(p: string): string[] {
  if (!existsSync(p)) return [];
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p)
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".rejected.jsonl"))
    .sort()
    .map((f) => path.join(p, f));
}

const sessionIdOf = (file: string) => path.basename(file).replace(/\.jsonl$/, "");

/** Load logs (files or dirs) and the recordings that go with them. */
export function loadSessions(logPaths: readonly string[], recordingPaths: readonly string[] = []): SessionLog[] {
  const recs = new Map<string, Recording[]>();
  for (const f of recordingPaths.flatMap(jsonlFiles))
    for (const r of parseRecordings(readFileSync(f, "utf8"))) {
      const l = recs.get(r.sessionId) ?? [];
      l.push(r);
      recs.set(r.sessionId, l);
    }
  const out: SessionLog[] = [];
  for (const f of logPaths.flatMap(jsonlFiles)) {
    const { events, bad } = parseLog(readFileSync(f, "utf8"));
    const head = events.find((e) => e.type === "session") as Extract<LogEvent, { type: "session" }> | undefined;
    const sessionId = head?.sessionId ?? sessionIdOf(f);
    out.push({ sessionId, events, recordings: recs.get(sessionId) ?? [], bad });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ghosts
// ---------------------------------------------------------------------------

/** First 8 hex of the request hash a suggestion id was made from. */
export function hashPrefixOf(suggestionId: string): string | undefined {
  const m = /-([0-9a-f]{8})$/.exec(suggestionId);
  return m ? m[1] : undefined;
}

export interface GhostRecord {
  sessionId: string;
  suggestionId: string;
  kind: SuggestionKind;
  confidence: number;
  label: string;
  shownAt: number;
  endedAt?: number;
  outcome: GhostOutcome;
  dwellMs?: number;
  cells: number;
  /** The recording behind the ghost (joined by id). */
  recording?: Recording;
  /** Level cells of the ghost (from the recording). */
  levelCells?: Point[];
  /** Pattern tags of the ghost (validator on the window level). */
  tags?: string[];
  /** A person edit inside the ghost's cells within 60 s of accepting it. */
  repaired?: boolean;
}

export const ACCEPTED: ReadonlySet<GhostOutcome> = new Set(["accepted", "partial"]);

/** The ghost's suggestion rebuilt from its recording (level coordinates). */
export function suggestionFromRecording(r: Recording, id = "joined"): Suggestion | null {
  if (!r.answer) return null;
  return convertModelAnswer(r.answer, r.request, { filler: "llm", requestHash: r.requestHash, latencyMs: r.latencyMs, id }).suggestion;
}

/** Ghosts of a session with outcomes, joined to recordings, tagged, and hand repair checked. */
export function ghostsOf(s: SessionLog, o: { repairWindowMs?: number; tag?: boolean } = {}): GhostRecord[] {
  const repairWindow = o.repairWindowMs ?? 60_000;
  const byPrefix = new Map<string, Recording>();
  for (const r of s.recordings) byPrefix.set(r.requestHash.slice(0, 8), r);
  const ghosts = new Map<string, GhostRecord>();
  for (const e of s.events) {
    if (e.type === "ghost.show") {
      const g: GhostRecord = {
        sessionId: s.sessionId,
        suggestionId: e.suggestionId,
        kind: e.kind,
        confidence: e.confidence,
        label: e.label,
        shownAt: e.t,
        outcome: "pending",
        cells: e.cells,
      };
      const p = hashPrefixOf(e.suggestionId);
      const rec = p ? byPrefix.get(p) : undefined;
      if (rec) {
        g.recording = rec;
        const sug = suggestionFromRecording(rec, e.suggestionId);
        if (sug) {
          g.levelCells = suggestionCells(sug);
          if (o.tag !== false) {
            try {
              g.tags = [...(validateSuggestion(levelFromRequest(rec.request), sug, { act: true }).tags ?? [])];
            } catch {
              g.tags = undefined;
            }
          }
        }
      }
      ghosts.set(e.suggestionId, g);
    } else if (e.type === "ghost.end") {
      const g = ghosts.get(e.suggestionId);
      if (!g) continue;
      g.outcome = e.outcome;
      g.endedAt = e.t;
      g.dwellMs = e.dwellMs;
    }
  }
  const list = [...ghosts.values()];
  // Hand repair: a person place/erase inside an accepted ghost's cells within the window.
  const edits = s.events.filter((e): e is Extract<LogEvent, { type: "place" | "erase" }> => (e.type === "place" || e.type === "erase") && e.author === 1);
  for (const g of list) {
    if (!ACCEPTED.has(g.outcome) || !g.levelCells || g.endedAt === undefined) continue;
    const cells = new Set(g.levelCells.map((p) => `${p.x},${p.y}`));
    const t0 = g.endedAt;
    g.repaired = edits.some((e) => e.t > t0 && e.t <= t0 + repairWindow && cells.has(`${e.x},${e.y}`));
  }
  return list.sort((a, b) => a.shownAt - b.shownAt);
}

/** requestHash -> accepted? for every ghost joined to a recording (calibration labels). */
export function acceptanceByRequest(sessions: readonly SessionLog[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const s of sessions)
    for (const g of ghostsOf(s, { tag: false }))
      if (g.recording && g.outcome !== "pending") out.set(g.recording.requestHash, ACCEPTED.has(g.outcome));
  return out;
}
