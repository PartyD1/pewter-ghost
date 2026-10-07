import { describe, expect, it } from "vitest";
import { makeSuggestion } from "../suggest/testUtils";
import { GhostHistory } from "./history";

describe("GhostHistory", () => {
  it("is undefined before anything was shown", () => {
    expect(new GhostHistory().summary()).toBeUndefined();
  });

  it("counts shows and outcomes and keeps recent items", () => {
    const h = new GhostHistory(2);
    const a = makeSuggestion({ label: "steps" });
    const b = makeSuggestion({ label: "pit", kind: "extend" });
    const c = makeSuggestion({ label: "gap", kind: "fix" });
    expect(h.recordShow(a)).toBe(1);
    h.recordEnd(a, "accepted", 2, 100.4);
    expect(h.recordShow(b)).toBe(2);
    h.recordEnd(b, "esc", undefined, 200, ["pit"]);
    h.recordShow(c);
    h.recordEnd(c, "partial", 1, 300);
    const s = h.summary()!;
    expect(s.shown).toBe(3);
    expect(s.outcomes).toEqual({ accepted: 1, esc: 1, partial: 1 });
    expect(s.recent.map((i) => i.label)).toEqual(["pit", "gap"]);
    expect(s.recent[1]).toMatchObject({ kind: "fix", outcome: "partial", acceptedCells: 1, cells: 2, t: 300 });
    expect(s.recent[0].acceptedCells).toBeUndefined();
    expect(h.lastGhosts(5)).toEqual([
      { kind: "extend", label: "pit", outcome: "esc", patterns: ["pit"] },
      { kind: "fix", label: "gap", outcome: "partial" },
    ]);
    expect(h.lastGhosts(1)).toHaveLength(1);
    h.reset();
    expect(h.summary()).toBeUndefined();
  });

  it("returns copies", () => {
    const h = new GhostHistory();
    const a = makeSuggestion();
    h.recordShow(a);
    h.recordEnd(a, "timeout", undefined, 1);
    h.summary()!.recent[0].label = "changed";
    expect(h.summary()!.recent[0].label).toBe(a.label);
  });
});
