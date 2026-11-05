/**
 * What the replay page needs to know about a session without downloading it:
 * how long it is, when it happened, and whether it holds replay data at all.
 * Computed from the log's JSONL (cheap parse, no schema validation) or, with a
 * Firestore backend, read straight from the stored summary.
 */
import { isSafeSessionId, logKey, type ProxyStore } from "./store";

export interface SessionSummary {
  sessionId: string;
  /** Events in the log. */
  events: number;
  /** Last event time minus first, in ms (0 for a log with one event). */
  durationMs: number;
  /** Wall clock (epoch ms) when the session began, when known. */
  startedAt?: number;
  /** True when the log has a level snapshot or pointer input: something a replay can show. */
  hasReplay: boolean;
  filler?: string;
  /** Size of the log text in bytes (characters; logs are ASCII-heavy JSON). */
  bytes: number;
}

/** `dev.20261008011127-iqje83` -> epoch ms of 2026-10-08 01:11:27 UTC. Other ids: undefined. */
export function idTimestamp(sessionId: string): number | undefined {
  const m = /^dev\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(sessionId);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? t : undefined;
}

/** What one stretch of log text contains: enough to build or update a summary. */
export interface LogScan {
  events: number;
  /** Earliest event time and latest event end (a pointer batch ends at its last sample), in ms. */
  minT: number;
  maxT: number;
  hasReplay: boolean;
  filler?: string;
  startedAt?: number;
}

export function scanLog(text: string): LogScan {
  let events = 0;
  let minT = Infinity;
  let maxT = -Infinity;
  let hasReplay = false;
  let filler: string | undefined;
  let startedAt: number | undefined;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e: { type?: unknown; t?: unknown; dt?: unknown; filler?: unknown; startedAt?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e.type !== "string" || typeof e.t !== "number") continue;
    events++;
    let end = e.t;
    if (e.type === "pointer.path" && Array.isArray(e.dt) && typeof e.dt[e.dt.length - 1] === "number") end += e.dt[e.dt.length - 1] as number;
    minT = Math.min(minT, e.t);
    maxT = Math.max(maxT, end);
    if (e.type === "snapshot" || e.type === "pointer.path") hasReplay = true;
    if (e.type === "session") {
      if (typeof e.filler === "string") filler = e.filler;
      if (typeof e.startedAt === "number") startedAt = e.startedAt;
    }
  }
  return { events, minT, maxT, hasReplay, filler, startedAt };
}

export function summarizeLog(sessionId: string, text: string): SessionSummary {
  const s = scanLog(text);
  return {
    sessionId,
    events: s.events,
    durationMs: s.events ? Math.max(0, Math.round(s.maxT - s.minT)) : 0,
    startedAt: s.startedAt ?? idTimestamp(sessionId),
    hasReplay: s.hasReplay,
    filler: s.filler,
    bytes: text.length,
  };
}

const sessionIdOf = (key: string): string | null => {
  if (!key.startsWith("logs/") || !key.endsWith(".jsonl") || key.endsWith(".rejected.jsonl")) return null;
  const id = key.slice("logs/".length, -".jsonl".length);
  return isSafeSessionId(id) ? id : null;
};

/**
 * Newest first. Reads at most `limit` logs (the highest ids, which for dev
 * sessions are the newest), so a long history is not downloaded to draw a list.
 */
export async function listSessionSummaries(store: ProxyStore, limit = 60): Promise<{ sessions: SessionSummary[]; total: number }> {
  const ids = (await store.list("logs/")).map(sessionIdOf).filter((x): x is string => x !== null);
  const pick = [...ids].sort().reverse().slice(0, limit);
  const out: SessionSummary[] = [];
  for (let i = 0; i < pick.length; i += 8) {
    const batch = await Promise.all(pick.slice(i, i + 8).map(async (id) => summarizeLog(id, (await store.read(logKey(id))) ?? "")));
    out.push(...batch);
  }
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (a.sessionId < b.sessionId ? 1 : -1));
  return { sessions: out, total: ids.length };
}
