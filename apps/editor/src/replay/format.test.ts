import { describe, expect, it } from "vitest";
import { formatLength, formatWhen, isWatchable, sessionTitle } from "./format";

const utc = { timeZone: "UTC" };
const NOW = Date.UTC(2026, 10, 5, 15, 0); // Nov 5 2026, 15:00 UTC

describe("formatWhen", () => {
  it("says Today, Yesterday, then the date", () => {
    expect(formatWhen(Date.UTC(2026, 10, 5, 14, 43), NOW, utc)).toBe("Today, 2:43 PM");
    expect(formatWhen(Date.UTC(2026, 10, 4, 9, 10), NOW, utc)).toBe("Yesterday, 9:10 AM");
    expect(formatWhen(Date.UTC(2026, 9, 8, 1, 11), NOW, utc)).toBe("Oct 8, 1:11 AM");
    // A different year shows the year, so an old session never looks recent.
    expect(formatWhen(Date.UTC(2025, 11, 31, 23, 5), NOW, utc)).toBe("Dec 31, 2025, 11:05 PM");
  });
});

describe("formatLength", () => {
  it.each([
    [0, "under 1 s"],
    [400, "under 1 s"],
    [42_000, "42 s"],
    [60_000, "1 min"],
    [72_000, "1 min 12 s"],
    [3_900_000, "1 h 05 min"],
  ])("%i ms -> %s", (ms, text) => expect(formatLength(ms)).toBe(text));
});

describe("sessionTitle", () => {
  it("shows a dev session by when it happened, not by its made-up id", () => {
    const t = sessionTitle({ sessionId: "dev.20261105144300-abc", startedAt: Date.UTC(2026, 10, 5, 14, 43), durationMs: 72_000, events: 296 }, NOW, utc);
    expect(t).toEqual({ title: "Today, 2:43 PM", sub: "1 min 12 s · 296 events" });
  });
  it("shows a participant session by its id, with the date after", () => {
    const t = sessionTitle({ sessionId: "p07", startedAt: Date.UTC(2026, 10, 4, 9, 10), durationMs: 600_000, events: 5000 }, NOW, utc);
    expect(t).toEqual({ title: "p07", sub: "10 min · 5000 events · Yesterday, 9:10 AM" });
  });
  it("copes with a listing that has no details", () => {
    expect(sessionTitle({ sessionId: "p01" })).toEqual({ title: "p01", sub: "" });
  });
});

describe("isWatchable", () => {
  it("needs replay data and at least a second", () => {
    expect(isWatchable({ sessionId: "a", hasReplay: true, durationMs: 5000 })).toBe(true);
    expect(isWatchable({ sessionId: "a", hasReplay: false, durationMs: 5000 })).toBe(false);
    expect(isWatchable({ sessionId: "a", hasReplay: true, durationMs: 300 })).toBe(false);
    expect(isWatchable({ sessionId: "a" })).toBe(true); // an older server that gives no details
  });
});
