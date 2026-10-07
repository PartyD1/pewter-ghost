import { describe, expect, it } from "vitest";
import { devEnabled, devLines, type DevState } from "./devOverlay";

const base: DevState = { fill: null, managerState: "idle", showNowAbove: 0.75, streak: 0, locked: false, lastEvent: null, fills: 0 };

describe("devLines", () => {
  it("says when nothing came back yet", () => {
    const l = devLines(base);
    expect(l[0]).toMatch(/fills 0 · manager idle/);
    expect(l).toContain("last answer: none yet");
  });

  it("shows answer, confidence, latency and verdict stage", () => {
    const l = devLines({
      ...base,
      fills: 3,
      managerState: "showing",
      locked: true,
      fill: { filler: "llm", mode: "auto", act: true, kind: "finish", label: "steps", confidence: 0.812, latencyMs: 640.4, verdictStage: "ok", cells: 4, attempts: 2 },
      lastEvent: 'shown "steps" (now)',
    }).join("\n");
    expect(l).toMatch(/manager showing \(locked\)/);
    expect(l).toMatch(/finish "steps" · 4 cells/);
    expect(l).toMatch(/confidence 0\.81/);
    expect(l).toMatch(/latency 640 ms/);
    expect(l).toMatch(/2 attempts/);
    expect(l).toMatch(/verdict: ok/);
    expect(l).toMatch(/last: shown "steps"/);
  });

  it("shows declines, errors and failed stages with reasons", () => {
    expect(devLines({ ...base, fill: { act: false } }).join("\n")).toMatch(/declined/);
    expect(devLines({ ...base, fill: { act: null, error: "timeout" } }).join("\n")).toMatch(/error: timeout/);
    expect(devLines({ ...base, fill: { act: true, verdictStage: "agent", reason: "gap too wide" } }).join("\n")).toMatch(/verdict: agent · gap too wide/);
  });
});

describe("devEnabled", () => {
  it("reads ?dev=1", () => {
    expect(devEnabled("?dev=1")).toBe(true);
    expect(devEnabled("?fresh=1&dev=true")).toBe(true);
    expect(devEnabled("?dev=0")).toBe(false);
    expect(devEnabled("")).toBe(false);
  });
});
