import { describe, expect, it } from "vitest";
import type { LogEvent } from "../contracts";
import { eventSchemas, isLogEvent, LOG_EVENT_TYPES, validateEvent } from "./schema";
import { scriptedSession } from "./__fixtures__/scriptedSession";

describe("LogEvent schemas", () => {
  it("cover every event type in the contract", () => {
    expect(new Set(LOG_EVENT_TYPES)).toEqual(
      new Set(["session", "place", "erase", "fill.call", "ghost.show", "ghost.end", "patrol", "play.start", "play.end", "undo", "redo", "save"]),
    );
    expect(Object.keys(eventSchemas)).toHaveLength(12);
  });

  it("accept every event in the scripted session (strict)", () => {
    const events = scriptedSession();
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(LOG_EVENT_TYPES));
    for (const e of events) expect(validateEvent(e, { strict: true })).toEqual({ ok: true, event: e });
  });

  const bad: [string, unknown, RegExp][] = [
    ["not an object", 42, /.+/],
    ["unknown type", { type: "teleport", t: 1 }, /type/],
    ["missing t", { type: "play.start" }, /t/],
    ["negative t", { type: "play.start", t: -1 }, /t/],
    ["string t", { type: "play.start", t: "1" }, /t/],
    ["bad author", { type: "place", t: 1, x: 0, y: 0, tile: 1, author: 7, stroke: "s", tool: "paint" }, /author/],
    ["fractional x", { type: "place", t: 1, x: 0.5, y: 0, tile: 1, author: 1, stroke: "s", tool: "paint" }, /x/],
    ["bad entity tile", { type: "place", t: 1, x: 0, y: 0, tile: "entity:dragon", author: 1, stroke: "s", tool: "paint" }, /tile/],
    ["confidence > 1", { type: "ghost.show", t: 1, suggestionId: "g", kind: "fix", confidence: 1.5, shownBecause: "now", cells: 1, label: "" }, /confidence/],
    ["bad shownBecause", { type: "ghost.show", t: 1, suggestionId: "g", kind: "fix", confidence: 0.5, shownBecause: "whim", cells: 1, label: "" }, /shownBecause/],
    ["bad outcome", { type: "ghost.end", t: 1, suggestionId: "g", outcome: "ignored", dwellMs: 1 }, /outcome/],
    ["fill.call act missing", { type: "fill.call", t: 1, requestHash: "h", mode: "auto", superseded: false, latencyMs: 1 }, /act/],
    ["fill.call bad verdict", { type: "fill.call", t: 1, requestHash: "h", mode: "auto", superseded: false, latencyMs: 1, act: true, verdictStage: "vibes" }, /verdictStage/],
    ["session no config", { type: "session", t: 0, sessionId: "s", commit: "", promptVersion: "", briefVersion: "", model: "", filler: "llm" }, /config/],
    ["session bad filler", { type: "session", t: 0, sessionId: "s", commit: "", promptVersion: "", briefVersion: "", model: "", filler: "gpt", config: {} }, /filler/],
    ["undo bad what", { type: "undo", t: 1, what: "everything" }, /what/],
    ["save empty id", { type: "save", t: 1, snapshotId: "" }, /snapshotId/],
    ["play.end deaths float", { type: "play.end", t: 1, reachedGoal: false, deaths: 1.5 }, /deaths/],
  ];
  it.each(bad)("reject %s", (_name, ev, re) => {
    const r = validateEvent(ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
    expect(isLogEvent(ev)).toBe(false);
  });

  it("loose mode keeps extra fields; strict mode rejects them", () => {
    const e = { type: "play.start", t: 3, extra: "future field" };
    const loose = validateEvent(e);
    expect(loose.ok).toBe(true);
    if (loose.ok) expect((loose.event as unknown as Record<string, unknown>).extra).toBe("future field");
    expect(validateEvent(e, { strict: true }).ok).toBe(false);
  });

  it("error messages name the event type", () => {
    const r = validateEvent({ type: "ghost.end", t: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.startsWith("ghost.end: ")).toBe(true);
  });

  it("types line up with the contract", () => {
    const e: LogEvent = { type: "redo", t: 0, what: "own" };
    expect(isLogEvent(e)).toBe(true);
  });
});
