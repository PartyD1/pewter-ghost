import { describe, expect, it } from "vitest";
import { ConfidenceTimer } from "./ConfidenceTimer";
import { JevTimer, JevTimerNotConfiguredError } from "./JevTimer";
import type { TimerContext } from "./Timer";
import { makeSuggestion, testConfig } from "../testUtils";

const ctx = (over: Partial<TimerContext> = {}): TimerContext => ({
  showNowAbove: 0.75,
  showAtPauseAbove: 0.4,
  config: testConfig(),
  now: 0,
  idleMs: 0,
  ...over,
});

describe("ConfidenceTimer", () => {
  const timer = new ConfidenceTimer();

  it.each([
    [0.95, "now"],
    [0.75, "now"],
    [0.74, "pause"],
    [0.4, "pause"],
    [0.39, "longPause"],
    [0, "longPause"],
  ] as const)("confidence %s -> %s", (confidence, when) => {
    expect(timer.decide(makeSuggestion({ confidence }), ctx()).when).toBe(when);
  });

  it("uses the session threshold from the context, not the config", () => {
    const s = makeSuggestion({ confidence: 0.78 });
    expect(timer.decide(s, ctx({ showNowAbove: 0.8 })).when).toBe("pause");
  });

  it("treats a non-finite confidence as low", () => {
    expect(timer.decide(makeSuggestion({ confidence: NaN }), ctx()).when).toBe("longPause");
  });

  it("a model-initiated fix waits for a pause even when confident", () => {
    const fix = makeSuggestion({ kind: "fix", confidence: 0.99 });
    expect(timer.decide(fix, ctx())).toEqual({ when: "pause", why: "model-fix-waits-for-pause" });
    const low = makeSuggestion({ kind: "fix", confidence: 0.1 });
    expect(timer.decide(low, ctx()).when).toBe("longPause");
  });

  it("a patrol fix shows now regardless of confidence", () => {
    const fix = makeSuggestion({ kind: "fix", mode: "patrol", confidence: 0.1 });
    expect(timer.decide(fix, ctx()).when).toBe("now");
  });
});

describe("JevTimer", () => {
  it("throws 'not configured'", () => {
    const t = new JevTimer();
    expect(t.name).toBe("jev");
    expect(() => t.decide(makeSuggestion(), ctx())).toThrow(JevTimerNotConfiguredError);
    expect(() => t.decide(makeSuggestion(), ctx())).toThrow("JevTimer not configured");
  });
});
