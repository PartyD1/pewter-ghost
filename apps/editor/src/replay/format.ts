/**
 * Human wording for the session list: "Today, 2:43 PM" instead of
 * `dev.20261105214337-ltzj88`, "1 min 12 s" instead of 72000.
 */
import type { SessionListing } from "./source";

interface WhenOpts {
  timeZone?: string;
  locale?: string;
}

/** "Today, 2:43 PM" / "Yesterday, 9:10 AM" / "Nov 3, 4:05 PM" (local time unless a timeZone is given). */
export function formatWhen(ms: number, now: number = Date.now(), o: WhenOpts = {}): string {
  const locale = o.locale ?? "en-US";
  const day = (t: number) => new Intl.DateTimeFormat(locale, { timeZone: o.timeZone, year: "numeric", month: "numeric", day: "numeric" }).format(t);
  const time = new Intl.DateTimeFormat(locale, { timeZone: o.timeZone, hour: "numeric", minute: "2-digit" }).format(ms);
  if (day(ms) === day(now)) return `Today, ${time}`;
  if (day(ms) === day(now - 86_400_000)) return `Yesterday, ${time}`;
  const year = (t: number) => new Intl.DateTimeFormat(locale, { timeZone: o.timeZone, year: "numeric" }).format(t);
  const date = new Intl.DateTimeFormat(locale, { timeZone: o.timeZone, month: "short", day: "numeric", ...(year(ms) === year(now) ? {} : { year: "numeric" as const }) }).format(ms);
  return `${date}, ${time}`;
}

/** "under 1 s", "42 s", "1 min 12 s", "1 h 05 min". */
export function formatLength(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under 1 s";
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Dev-server sessions have made-up ids; those are shown by when they happened. */
export const isDevId = (id: string): boolean => id.startsWith("dev.");

/** A session worth opening: it has something to replay and lasted at least a second. */
export const isWatchable = (s: SessionListing): boolean => s.hasReplay !== false && (s.durationMs ?? Infinity) >= 1000;

export function sessionTitle(s: SessionListing, now: number = Date.now(), o: WhenOpts = {}): { title: string; sub: string } {
  const parts: string[] = [];
  if (typeof s.durationMs === "number") parts.push(formatLength(s.durationMs));
  if (typeof s.events === "number") parts.push(`${s.events} events`);
  if (isDevId(s.sessionId)) {
    return { title: s.startedAt ? formatWhen(s.startedAt, now, o) : s.sessionId, sub: parts.join(" · ") };
  }
  if (s.startedAt) parts.push(formatWhen(s.startedAt, now, o));
  return { title: s.sessionId, sub: parts.join(" · ") };
}
