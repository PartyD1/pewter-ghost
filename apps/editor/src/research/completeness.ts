/**
 * Session-log completeness checker (G-18). Used in CI on scripted sessions and
 * by the dashboard on real ones. Pure; never throws.
 *
 * Errors (the log is not usable as-is):
 *  - empty log; first event is not `session`; more than one `session` event
 *  - an event fails schema validation
 *  - timestamps go backwards
 *  - a `fill.call` without a requestHash
 *  - a `ghost.show` with no later `ghost.end` (unless allowOpenGhosts), a
 *    `ghost.end` with no earlier `ghost.show`, duplicate shows/ends of one id
 *  - `play.end` without `play.start`, nested `play.start`
 *  - `outcome: "partial"` without `acceptedCells`
 * Warnings (worth a look, not fatal):
 *  - ghost.end dwellMs disagrees with end.t - show.t by more than dwellToleranceMs
 *  - a play session still open at the end of the log
 *  - place/erase event whose `tool` disagrees with its type
 */
import type { LogEvent } from "../contracts";
import { validateEvent } from "./schema";

export interface CompletenessOptions {
  /** Treat ghosts still showing at the end of the log as OK (live session snapshot). */
  allowOpenGhosts?: boolean;
  /** Validate with the strict schema (unknown fields are errors). Default false. */
  strict?: boolean;
  /** Tolerance for dwellMs vs timestamps (default 250 ms). */
  dwellToleranceMs?: number;
  /** Event types that must appear at least once (scripted sessions). */
  expectTypes?: LogEvent["type"][];
}

export interface CompletenessProblem {
  index: number;
  message: string;
}

export interface CompletenessReport {
  ok: boolean;
  errors: CompletenessProblem[];
  warnings: CompletenessProblem[];
  counts: Record<string, number>;
  sessionId?: string;
  /** Ghost ids shown but never ended. */
  openGhosts: string[];
}

export function checkCompleteness(events: readonly unknown[], opts: CompletenessOptions = {}): CompletenessReport {
  const errors: CompletenessProblem[] = [];
  const warnings: CompletenessProblem[] = [];
  const counts: Record<string, number> = {};
  const tol = opts.dwellToleranceMs ?? 250;
  const report = (): CompletenessReport => ({
    ok: errors.length === 0,
    errors,
    warnings,
    counts,
    sessionId,
    openGhosts: [...shown.keys()],
  });

  let sessionId: string | undefined;
  const shown = new Map<string, { index: number; t: number }>();
  const ended = new Set<string>();
  let playOpen: number | null = null;
  let lastT = -Infinity;

  if (!Array.isArray(events) || events.length === 0) {
    errors.push({ index: -1, message: "log is empty" });
    return report();
  }

  events.forEach((raw, i) => {
    const v = validateEvent(raw, { strict: opts.strict });
    const type =
      raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string"
        ? (raw as { type: string }).type
        : "(unknown)";
    counts[type] = (counts[type] ?? 0) + 1;
    if (!v.ok) {
      errors.push({ index: i, message: `invalid event: ${v.error}` });
    }
    const e = raw as LogEvent;
    if (!v.ok && (typeof e !== "object" || e === null)) return;

    if (i === 0 && e.type !== "session") errors.push({ index: 0, message: `first event is "${type}", expected "session"` });
    if (typeof e.t === "number") {
      if (e.t < lastT) errors.push({ index: i, message: `time goes backwards (${e.t} < ${lastT})` });
      lastT = Math.max(lastT, e.t);
    }

    switch (e.type) {
      case "session":
        if (i !== 0) errors.push({ index: i, message: "extra session event (only one allowed, first)" });
        else sessionId = e.sessionId;
        break;
      case "place":
      case "erase": {
        const want = e.type === "place" ? "paint" : "erase";
        if (e.tool !== want) warnings.push({ index: i, message: `${e.type} event with tool "${e.tool}"` });
        break;
      }
      case "fill.call":
        if (typeof e.requestHash !== "string" || e.requestHash.length === 0)
          errors.push({ index: i, message: "fill.call without requestHash" });
        break;
      case "ghost.show":
        if (shown.has(e.suggestionId) || ended.has(e.suggestionId))
          errors.push({ index: i, message: `ghost ${e.suggestionId} shown twice` });
        else shown.set(e.suggestionId, { index: i, t: e.t });
        break;
      case "ghost.end": {
        const s = shown.get(e.suggestionId);
        if (!s) {
          errors.push({
            index: i,
            message: ended.has(e.suggestionId)
              ? `ghost ${e.suggestionId} ended twice`
              : `ghost.end for ${e.suggestionId} without ghost.show`,
          });
          break;
        }
        shown.delete(e.suggestionId);
        ended.add(e.suggestionId);
        if (e.outcome === "partial" && e.acceptedCells === undefined)
          errors.push({ index: i, message: `partial ghost.end for ${e.suggestionId} without acceptedCells` });
        if (typeof e.dwellMs === "number" && Math.abs(e.t - s.t - e.dwellMs) > tol)
          warnings.push({
            index: i,
            message: `ghost ${e.suggestionId} dwellMs ${e.dwellMs} vs timestamps ${Math.round(e.t - s.t)}`,
          });
        break;
      }
      case "play.start":
        if (playOpen !== null) errors.push({ index: i, message: "play.start while already playing" });
        playOpen = i;
        break;
      case "play.end":
        if (playOpen === null) errors.push({ index: i, message: "play.end without play.start" });
        playOpen = null;
        break;
      default:
        break;
    }
  });

  if (!opts.allowOpenGhosts) {
    for (const [id, s] of shown) errors.push({ index: s.index, message: `ghost.show ${id} has no ghost.end` });
  }
  if (playOpen !== null) warnings.push({ index: playOpen, message: "play session still open at end of log" });
  for (const t of opts.expectTypes ?? []) {
    if (!counts[t]) errors.push({ index: -1, message: `expected at least one "${t}" event` });
  }
  return report();
}

/** Parse JSONL text (as written by EventLog.download / the proxy) into events. Bad lines become errors. */
export function parseJsonl(text: string): { events: unknown[]; badLines: number[] } {
  const events: unknown[] = [];
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      badLines.push(i + 1);
    }
  });
  return { events, badLines };
}
