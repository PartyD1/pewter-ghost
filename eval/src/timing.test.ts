import { describe, expect, it } from "vitest";
import type { LogEvent, TimingPolicyName } from "../../apps/editor/src/contracts";
import { isLogEvent } from "../../apps/editor/src/research/schema";
import type { SessionLog } from "./logs";
import { analyseTiming, chooseT2, counterfactuals, policyStats, sessionPolicy, splitBySession, timingExamples, timingMarkdown } from "./timing";

/**
 * A session of n automatic ghosts. Ghost i has confidence c_i; it is kept
 * exactly when c_i >= 0.5 (so confidence separates perfectly, and trained
 * CDHF weights should too).
 */
function session(id: string, policy: TimingPolicyName, n: number, o: { jev?: boolean; requested?: boolean } = {}): SessionLog {
  const ev: LogEvent[] = [
    { type: "session", t: 0, sessionId: id, commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "llm", config: { timing: policy } },
  ];
  let t = 1000;
  for (let i = 0; i < n; i++) {
    const c = ((i * 7) % 10) / 10;
    const sid = `${id}-g${i}`;
    ev.push({ type: "fill.call", t, requestHash: "a".repeat(64), mode: "auto", superseded: false, latencyMs: 900, act: true, confidence: c });
    if (o.jev) ev.push({ type: "timing", t: t + 100, policy: "jev", stage: "jev", decision: c >= 0.5 ? "suggest" : "wait", p: c, latencyMs: 400 });
    if (policy === "cdhf" && i % 3 === 0) ev.push({ type: "timing", t: t + 150, policy: "cdhf", stage: "gate", decision: "skip", p: 0.05, mode: "auto" });
    ev.push({ type: "ghost.show", t: t + 200, suggestionId: sid, kind: "extend", confidence: c, shownBecause: "now", cells: 4, label: "x" });
    ev.push({
      type: "timing",
      t: t + 200,
      policy,
      stage: "show",
      decision: "show",
      p: 0.4,
      suggestionId: sid,
      mode: "auto",
      features: { idleSec: 1, confidence: c - 0.5, cells: 0.4 },
      why: o.requested && i === 0 ? "requested" : "now",
    });
    ev.push({ type: "ghost.end", t: t + 2200, suggestionId: sid, outcome: c >= 0.5 ? "accepted" : "drawn-over", dwellMs: 2000 });
    t += 6000;
  }
  for (const e of ev) expect(isLogEvent(e, { strict: true })).toBe(true);
  return { sessionId: id, events: ev, recordings: [], bad: 0 };
}

describe("timing comparison", () => {
  it("reads the policy from the session config (llm when absent)", () => {
    const s = session("a", "jev", 1);
    expect(sessionPolicy(s)).toBe("jev");
    expect(sessionPolicy({ ...s, events: s.events.slice(1) })).toBe("llm");
  });

  it("live stats per policy: kept, keep rate, calls including Jev polls, gated calls", () => {
    const stats = policyStats([session("a", "llm", 10), session("b", "jev", 10, { jev: true }), session("c", "cdhf", 9)]);
    expect(stats.map((s) => s.policy)).toEqual(["llm", "cdhf", "jev"]);
    const [llm, cdhf, jev] = stats;
    expect(llm).toMatchObject({ sessions: 1, shown: 10, kept: 5, rejected: 5, fillCalls: 10, jevPolls: 0 });
    expect(llm.keepRate).toBe(0.5);
    expect(llm.callsPerKept).toBe(2);
    expect(jev).toMatchObject({ jevPolls: 10, jevErrors: 0 });
    expect(jev.callsPerKept).toBe(4);
    expect(cdhf.gated).toBe(3);
    expect(llm.minutes).toBeGreaterThan(0.9);
  });

  it("examples: automatic shows with a decided outcome; requested shows are left out", () => {
    const ex = timingExamples([session("a", "llm", 10, { requested: true }), session("b", "jev", 4, { jev: true })]);
    expect(ex).toHaveLength(13);
    expect(ex.every((e) => e.y === (e.confidence >= 0.5 ? 1 : 0))).toBe(true);
    expect(ex.filter((e) => e.jevP !== undefined)).toHaveLength(4);
  });

  it("splits by session deterministically", () => {
    const xs = Array.from({ length: 200 }, (_, i) => ({ sessionId: `s${i % 20}` }));
    const a = splitBySession(xs);
    expect(splitBySession(xs)).toEqual(a);
    const trainIds = new Set(a.train.map((x) => x.sessionId));
    expect(trainIds.size).toBe(14);
    expect(a.test.some((x) => trainIds.has(x.sessionId))).toBe(false);
    const one = splitBySession([{ sessionId: "only" }]);
    expect([one.train.length, one.test.length]).toEqual([1, 0]);
    const two = splitBySession([{ sessionId: "a" }, { sessionId: "b" }]);
    expect([two.train.length, two.test.length]).toEqual([1, 1]);
  });

  it("counterfactual and the paper's threshold choice", () => {
    const cf = counterfactuals([0.1, 0.2, 0.3, 0.9], [0, 0, 1, 1], [0.25, 0.5]);
    expect(cf[0]).toMatchObject({ t2: 0.25, hidden: 0.5, hiddenRejected: 1, keepAfter: 1 });
    expect(cf[1]).toMatchObject({ hidden: 0.75 });
    expect(cf[1].hiddenRejected).toBeCloseTo(2 / 3);
    expect(chooseT2(cf, 0.9)?.t2).toBe(0.25);
    expect(chooseT2(cf, 1.01)).toBeNull();
  });

  it("trains on logged features and beats nothing worse than the LLM's confidence here", () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(`p${i}`, i % 2 ? "llm" : "cdhf", 10));
    const a = analyseTiming(sessions, { train: true, version: "trained-test" });
    expect(a.examples).toBe(120);
    expect(a.train + a.test).toBe(120);
    expect(a.train).toBe(80); // 8 of 12 sessions
    expect(a.scorer).toBe("trained");
    expect(a.auc.confidence).toBe(1);
    expect(a.auc.trained).toBe(1);
    expect(a.weights?.version).toBe("trained-test");
    expect(a.weights!.full.w.confidence).toBeGreaterThan(0);
    expect(a.chosen).not.toBeNull();
    const md = timingMarkdown(a);
    expect(md).toContain("| llm |");
    expect(md).toContain("Suggested cdhfShowAbove");
  });

  it("without --train (or too few ghosts) scores the prior only", () => {
    const a = analyseTiming([session("a", "llm", 4)], { train: true });
    expect(a.scorer).toBe("prior");
    expect(a.weights).toBeUndefined();
    expect(timingMarkdown(analyseTiming([]))).toContain("No sessions.");
  });
});
