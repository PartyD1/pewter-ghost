import { describe, expect, it } from "vitest";
import type { LogEvent } from "../contracts";
import { checkCompleteness, parseJsonl } from "./completeness";
import { EventLog } from "./log";
import { scriptedSession } from "./__fixtures__/scriptedSession";

const messages = (r: ReturnType<typeof checkCompleteness>) => r.errors.map((e) => e.message).join(" | ");

describe("checkCompleteness", () => {
  it("passes the scripted session, replayed through EventLog and JSONL", () => {
    const log = new EventLog({ sessionId: "p01", autoStart: false });
    for (const e of scriptedSession()) log.log(e);
    const { events, badLines } = parseJsonl(log.toJsonl());
    expect(badLines).toEqual([]);
    const r = checkCompleteness(events, {
      strict: true,
      expectTypes: ["session", "place", "fill.call", "ghost.show", "ghost.end", "play.start", "play.end", "save"],
    });
    expect(messages(r)).toBe("");
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.sessionId).toBe("p01");
    expect(r.counts["fill.call"]).toBe(4);
    expect(r.openGhosts).toEqual([]);
  });

  it("empty log", () => {
    expect(checkCompleteness([]).ok).toBe(false);
  });

  it("session must come first and only once", () => {
    const s = scriptedSession();
    const swapped = [s[1], s[0], ...s.slice(2)];
    expect(messages(checkCompleteness(swapped))).toMatch(/first event is "place"/);
    expect(messages(checkCompleteness([...s, { ...s[0], t: 99999 }]))).toMatch(/extra session/);
  });

  it("every ghost.show needs a ghost.end", () => {
    const s = scriptedSession().filter((e) => !(e.type === "ghost.end" && e.suggestionId === "g3"));
    const r = checkCompleteness(s);
    expect(messages(r)).toMatch(/ghost.show g3 has no ghost.end/);
    expect(r.openGhosts).toEqual(["g3"]);
    expect(checkCompleteness(s, { allowOpenGhosts: true }).ok).toBe(true);
  });

  it("ghost.end without show, double end, double show", () => {
    const base = scriptedSession();
    const orphan: LogEvent = { type: "ghost.end", t: 30000, suggestionId: "zz", outcome: "timeout", dwellMs: 0 };
    expect(messages(checkCompleteness([...base, orphan]))).toMatch(/without ghost.show/);
    const again: LogEvent = { type: "ghost.end", t: 30000, suggestionId: "g1", outcome: "esc", dwellMs: 0 };
    expect(messages(checkCompleteness([...base, again]))).toMatch(/ended twice/);
    const reshow: LogEvent = { type: "ghost.show", t: 30000, suggestionId: "g1", kind: "fix", confidence: 1, shownBecause: "now", cells: 1, label: "" };
    expect(messages(checkCompleteness([...base, reshow]))).toMatch(/shown twice/);
  });

  it("every fill.call has a hash", () => {
    const s = scriptedSession().map((e) => (e.type === "fill.call" && e.t === 1900 ? { ...e, requestHash: "" } : e));
    expect(messages(checkCompleteness(s))).toMatch(/fill.call without requestHash/);
  });

  it("partial outcomes need acceptedCells", () => {
    const s = scriptedSession().map((e) => (e.type === "ghost.end" && e.outcome === "partial" ? { ...e, acceptedCells: undefined } : e));
    expect(messages(checkCompleteness(s))).toMatch(/partial ghost.end/);
  });

  it("time must not go backwards", () => {
    const s = scriptedSession();
    s.push({ type: "save", t: 5, snapshotId: "late" });
    expect(messages(checkCompleteness(s))).toMatch(/backwards/);
  });

  it("play pairing", () => {
    const s = scriptedSession();
    expect(messages(checkCompleteness([...s, { type: "play.end", t: 30000, reachedGoal: false, deaths: 0 }]))).toMatch(/without play.start/);
    expect(messages(checkCompleteness([...s, { type: "play.start", t: 30000 }, { type: "play.start", t: 30001 }]))).toMatch(/already playing/);
    const open = checkCompleteness([...s, { type: "play.start", t: 30000 }]);
    expect(open.ok).toBe(true);
    expect(open.warnings[0].message).toMatch(/still open/);
  });

  it("invalid events are errors; strict flags unknown fields", () => {
    const s: unknown[] = [...scriptedSession(), { type: "save", t: 30000 }];
    expect(messages(checkCompleteness(s))).toMatch(/invalid event: save/);
    const extra: unknown[] = [...scriptedSession(), { type: "play.start", t: 30000, extra: 1 }];
    expect(checkCompleteness(extra).ok).toBe(true);
    expect(checkCompleteness(extra, { strict: true }).ok).toBe(false);
    expect(checkCompleteness([null, 3, "x"]).ok).toBe(false);
  });

  it("warns on dwell mismatch and tool/type mismatch", () => {
    const s = scriptedSession().map((e) => {
      if (e.type === "ghost.end" && e.suggestionId === "g1") return { ...e, dwellMs: 50 };
      if (e.type === "erase") return { ...e, tool: "paint" as const };
      return e;
    });
    const r = checkCompleteness(s);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/dwellMs 50/);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/erase event with tool "paint"/);
  });

  it("expectTypes flags missing event types", () => {
    const s = scriptedSession().filter((e) => e.type !== "save");
    expect(messages(checkCompleteness(s, { expectTypes: ["save"] }))).toMatch(/expected at least one "save"/);
  });
});

describe("parseJsonl", () => {
  it("skips blank lines and reports bad ones", () => {
    expect(parseJsonl('{"a":1}\n\nnope\r\n{"b":2}\n')).toEqual({ events: [{ a: 1 }, { b: 2 }], badLines: [3] });
  });
});
