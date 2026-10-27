import { describe, expect, it } from "vitest";
import type { FillRequest, JevRequest, LogEvent, TimingEvent, VerifiedSuggestion } from "../../contracts";
import type { TimerApi } from "../../verify/patrol";
import { FakeClock } from "../fakeClock";
import { SuggestionManager } from "../SuggestionManager";
import { erase, makeSuggestion, paint, testConfig } from "../testUtils";
import { CdhfTimer } from "../timers/CdhfTimer";
import { JevTimer } from "../timers/JevTimer";
import type { TimerContext } from "../timers/Timer";
import type { GhostConfig } from "../config";
import { acceptLabel, ActivityTracker } from "./activity";
import { contextFeatures, fullFeatures, FULL_FEATURES } from "./features";
import { JevPoller, jevRequestFrom, type JevAnswer, type JevClient } from "./jev";
import { jevRequestProblem, parseJevVerdict, renderJevPrompt } from "./jevPrompt";
import { auc, entropyBits, predict, PRIOR_WEIGHTS, train, trainCdhf, type CdhfWeights } from "./model";
import { TimingPolicy } from "./policy";

const ctx = (cfg: GhostConfig, now: number): TimerContext => ({ showNowAbove: 0.6, showAtPauseAbove: 0, config: cfg, now, idleMs: 0 });

/** Timers driven by hand. */
class ManualTimers implements TimerApi {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clear(h: unknown): void {
    this.pending.delete(h as number);
  }
  /** Run every pending timer of this delay once. */
  fire(ms?: number): void {
    for (const [id, t] of [...this.pending]) {
      if (ms !== undefined && t.ms !== ms) continue;
      this.pending.delete(id);
      t.fn();
    }
  }
}

const fillRequest = (): FillRequest => ({
  grid: "   0123\n 0 ....\n 1 ##..\n",
  origin: { x: 10, y: 4 },
  size: { w: 24, h: 12 },
  recent: [{ dt: 120, x: 2, y: 1, tile: "block", tool: "paint" }],
  frontier: { x: 3, y: 1, idleMs: 400 },
  knight: { maxGapStand: 4, maxGapRun: 7, maxRise: 3 },
  measured: { density: 0.1, gapHist: [0, 0, 0, 0, 0], verticality: 0, rewardSpacing: 0, pressure: 0 },
  brief: "",
  briefVersion: "b",
  lastGhosts: [],
  mode: "auto",
});

describe("ActivityTracker", () => {
  it("counts the person's placements in 2 s / 10 s windows and the erase share", () => {
    const c = new FakeClock(0);
    const a = new ActivityTracker(() => c.now());
    a.placement(paint(1000, 1, 1));
    a.placement(paint(9000, 2, 1));
    a.placement(erase(9500, 2, 1));
    a.placement(paint(9600, 3, 1, 1, "s", 2)); // ghost: ignored
    const s = a.snapshot(10_000);
    expect(s).toMatchObject({ idleMs: 500, placements2s: 2, placements10s: 3, lastPlacement: { x: 2, y: 1 } });
    expect(s.eraseShare).toBeCloseTo(1 / 3);
    expect(a.snapshot(25_000).placements10s).toBe(0);
  });

  it("tracks dismissals since the last accept and a smoothed keep rate", () => {
    const c = new FakeClock(0);
    const a = new ActivityTracker(() => c.now());
    expect(a.snapshot().acceptRate5).toBe(0.5);
    a.ghostShown();
    expect(a.snapshot().ghostShowing).toBe(true);
    a.ghostEnded("esc", 100);
    a.ghostEnded("drawn-over", 200);
    a.ghostEnded("replaced", 300); // not a decision
    expect(a.snapshot(400)).toMatchObject({ dismissRun: 2, sinceGhostMs: 100, ghostShowing: false });
    expect(a.snapshot().acceptRate5).toBeCloseTo(0.5 / 3);
    a.ghostEnded("accepted", 500);
    expect(a.snapshot().dismissRun).toBe(0);
  });

  it("labels outcomes like the paper: kept 1, rejected 0, undecided null", () => {
    expect(["accepted", "partial", "esc", "drawn-over", "timeout", "replaced", "pending"].map((o) => acceptLabel(o as never))).toEqual([
      1, 1, 0, 0, 0, null, null,
    ]);
  });
});

describe("features and the logistic model", () => {
  it("builds a finite vector for every feature name", () => {
    const a = new ActivityTracker(() => 0).snapshot(5000);
    const f = fullFeatures(makeSuggestion({ confidence: 0.8 }), a);
    for (const k of FULL_FEATURES) expect(Number.isFinite(f[k])).toBe(true);
    expect(f.confidence).toBeCloseTo(0.3);
    expect(contextFeatures(a, "tidy").tidy).toBe(1);
  });

  it("the prior rewards confidence and a pause, punishes erasing and a dismiss run", () => {
    const base = { idleSec: 2, confidence: 0 };
    const p = predict(PRIOR_WEIGHTS.full, base);
    expect(predict(PRIOR_WEIGHTS.full, { ...base, confidence: 0.4 })).toBeGreaterThan(p);
    expect(predict(PRIOR_WEIGHTS.full, { ...base, idleSec: 6 })).toBeGreaterThan(p);
    expect(predict(PRIOR_WEIGHTS.full, { ...base, eraseShare: 1 })).toBeLessThan(p);
    expect(predict(PRIOR_WEIGHTS.full, { ...base, dismissRun: 3 })).toBeLessThan(p);
  });

  it("entropy is 1 bit at 0.5 and 0 at the ends", () => {
    expect(entropyBits(0.5)).toBeCloseTo(1);
    expect(entropyBits(0)).toBe(0);
    expect(entropyBits(1)).toBe(0);
    expect(entropyBits(0.12)).toBeCloseTo(0.529, 2);
  });

  it("train recovers the sign of a separating feature; auc scores it", () => {
    const ex = Array.from({ length: 60 }, (_, i) => ({ f: { confidence: (i % 10) / 10 - 0.5 }, y: (i % 10 >= 5 ? 1 : 0) as 0 | 1 }));
    const m = train(ex, ["confidence"]);
    expect(m.w.confidence).toBeGreaterThan(1);
    const scores = ex.map((e) => predict(m, e.f));
    expect(auc(scores, ex.map((e) => e.y))).toBe(1);
    expect(auc([0.1, 0.2], [1, 1])).toBeNaN();
    const w = trainCdhf(ex, "t");
    expect(w).toMatchObject({ version: "t", trainedOn: 60 });
    expect(Object.keys(w.full.w)).toEqual([...FULL_FEATURES]);
  });
});

describe("CdhfTimer", () => {
  const always = (bias: number): CdhfWeights => ({ version: "x", trainedOn: 0, context: { bias, w: {} }, full: { bias, w: {} } });

  it("shows now at or above cdhfShowAbove and holds below it", () => {
    const a = new ActivityTracker(() => 0);
    const cfg = testConfig({ cdhfShowAbove: 0.5 });
    const hi = new CdhfTimer((n) => a.snapshot(n), () => always(2));
    const lo = new CdhfTimer((n) => a.snapshot(n), () => always(-2));
    expect(hi.decide(makeSuggestion(), ctx(cfg, 0))).toEqual({ when: "now", why: "cdhf>=show" });
    expect(lo.decide(makeSuggestion(), ctx(cfg, 0))).toEqual({ when: "request", why: "cdhf<show" });
    expect(lo.decide(makeSuggestion({ kind: "fix", mode: "patrol" }), ctx(cfg, 0)).when).toBe("now");
  });

  it("a ghost held mid-drag shows at the pause where it becomes likely (manager re-asks every tick)", () => {
    const clock = new FakeClock(10_000);
    const policy = new TimingPolicy({ config: () => cfg, clock: () => clock.now(), log: () => {} });
    const cfg = testConfig({ timing: "cdhf", cdhfShowAbove: 0.3 });
    const m = new SuggestionManager({ clock, config: cfg, timer: policy });
    // A fast drag: twenty placements in the last 2 s.
    for (let i = 0; i < 20; i++) {
      const ev = paint(8000 + i * 100, i, 15);
      policy.placement(ev);
      m.onPlacement(ev);
    }
    const s = makeSuggestion({ confidence: 0.4, kind: "extend", adds: [{ x: 40, y: 15, tile: 1 }] });
    expect(m.offer(s, { requestedAt: clock.now() })).toEqual({ status: "held", when: "request" });
    clock.advance(4000);
    m.tick();
    expect(m.shown?.id).toBe(s.id);
    expect(m.shownBecause).toBe("now");
  });
});

describe("JevTimer", () => {
  const cfg = testConfig({ jevMaxAgeMs: 3000 });
  it("shows on a fresh 'suggest', holds on 'wait', a stale verdict or none", () => {
    let v: { suggest: boolean; p: number; why: string; at: number } | null = null;
    const t = new JevTimer(() => v);
    expect(t.decide(makeSuggestion(), ctx(cfg, 1000)).why).toBe("jev-no-verdict");
    v = { suggest: true, p: 0.8, why: "paused", at: 0 };
    expect(t.decide(makeSuggestion(), ctx(cfg, 1000))).toEqual({ when: "now", why: "jev-suggest" });
    expect(t.decide(makeSuggestion(), ctx(cfg, 3001)).when).toBe("request");
    v = { ...v, suggest: false };
    expect(t.decide(makeSuggestion(), ctx(cfg, 1000))).toEqual({ when: "request", why: "jev-wait" });
    expect(t.decide(makeSuggestion({ kind: "fix", mode: "patrol" }), ctx(cfg, 1000)).when).toBe("now");
  });
});

describe("Jev prompt", () => {
  it("parses strictly, clamps p and trims why", () => {
    expect(parseJevVerdict({ suggest: true, p: 3, why: "  x  " })).toEqual({ suggest: true, p: 1, why: "x" });
    expect(parseJevVerdict({ suggest: false })).toEqual({ suggest: false, p: 0, why: "" });
    expect(parseJevVerdict({ suggest: "yes" })).toBeNull();
    expect(parseJevVerdict([])).toBeNull();
  });

  it("renders the held ghost and activity, and checks request shape", () => {
    const a = new ActivityTracker(() => 0).snapshot(1200);
    const held = makeSuggestion({ label: "close the box", anchor: { x: 12, y: 5 } });
    const r = jevRequestFrom(fillRequest(), a, held, false);
    expect(r.held).toMatchObject({ label: "close the box", anchor: { x: 2, y: 1 }, cells: 2 });
    const p = renderJevPrompt(r);
    expect(p.user).toContain('held ghost: finish "close the box"');
    expect(p.user).toContain("idle 1200 ms");
    expect(p.promptVersion).toMatch(/^jev\.v1-[0-9a-f]{8}$/);
    expect(jevRequestProblem(r)).toBeNull();
    expect(jevRequestProblem({ ...r, showing: "no" })).toMatch(/showing/);
    expect(jevRequestProblem({ ...r, activity: { ...r.activity, idleMs: "x" } })).toMatch(/idleMs/);
  });
});

describe("JevPoller", () => {
  function setup(answer: (req: JevRequest) => JevAnswer | Promise<JevAnswer>, over: Partial<GhostConfig> = {}) {
    const clock = new FakeClock(5000);
    const timers = new ManualTimers();
    const events: LogEvent[] = [];
    const cfg = testConfig({ timing: "jev", ...over });
    const state = { held: null as VerifiedSuggestion | null, showing: false, active: true, nudges: 0, sent: [] as JevRequest[] };
    const client: JevClient = {
      when: async (req) => {
        state.sent.push(req);
        return answer(req);
      },
    };
    const activity = new ActivityTracker(() => clock.now());
    activity.placement(paint(4800, 1, 1));
    const poller = new JevPoller({
      client,
      config: () => cfg,
      clock: () => clock.now(),
      timers,
      log: (e) => events.push(e),
      activity: (n) => activity.snapshot(n),
      request: fillRequest,
      held: () => state.held,
      showing: () => state.showing,
      active: () => state.active,
      nudge: () => state.nudges++,
    });
    return { poller, clock, timers, events, state, cfg };
  }

  it("stores the verdict with its send time, logs it, and nudges when nothing is held", async () => {
    const { poller, events, state } = setup(() => ({ verdict: { suggest: true, p: 0.7, why: "paused" }, latencyMs: 300 }));
    await poller.poll();
    expect(poller.verdict).toEqual({ suggest: true, p: 0.7, why: "paused", at: 5000 });
    expect(state.sent[0].activity.idleMs).toBe(200);
    expect(state.nudges).toBe(1);
    expect(events).toEqual([expect.objectContaining({ type: "timing", policy: "jev", stage: "jev", decision: "suggest", p: 0.7 })]);
  });

  it("does not nudge while a ghost is held, and names it in the log", async () => {
    const { poller, events, state } = setup(() => ({ verdict: { suggest: true, p: 0.9, why: "" }, latencyMs: 1 }));
    state.held = makeSuggestion({ id: "g7" });
    await poller.poll();
    expect(state.nudges).toBe(0);
    expect((events[0] as TimingEvent).suggestionId).toBe("g7");
  });

  it("skips when the policy is not jev, when halted, or long idle with nothing to show", async () => {
    const a = setup(() => ({ verdict: { suggest: false, p: 0, why: "" }, latencyMs: 1 }), { timing: "llm" });
    await a.poller.poll();
    expect(a.state.sent).toHaveLength(0);
    const b = setup(() => ({ verdict: null, latencyMs: 1 }));
    b.state.active = false;
    await b.poller.poll();
    expect(b.state.sent).toHaveLength(0);
    const c = setup(() => ({ verdict: null, latencyMs: 1 }), { jevIdleStopMs: 1000 });
    c.clock.advance(5000);
    await c.poller.poll();
    expect(c.state.sent).toHaveLength(0);
  });

  it("logs a failed poll as an error and keeps the old verdict", async () => {
    let n = 0;
    const { poller, events } = setup(() =>
      n++ === 0 ? { verdict: { suggest: false, p: 0.1, why: "" }, latencyMs: 1 } : { verdict: null, latencyMs: 1, error: "http 500" },
    );
    await poller.poll();
    await poller.poll();
    expect(poller.verdict?.suggest).toBe(false);
    expect(events[1]).toMatchObject({ stage: "jev", decision: "error", why: "http 500" });
  });

  it("polls on its interval once started and stops cleanly", async () => {
    const { poller, timers, state, cfg } = setup(() => ({ verdict: { suggest: false, p: 0, why: "" }, latencyMs: 1 }));
    poller.start();
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([cfg.jevIntervalMs]);
    timers.fire(cfg.jevIntervalMs);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.sent).toHaveLength(1);
    poller.stop();
    expect(timers.pending.size).toBe(0);
  });
});

describe("TimingPolicy", () => {
  function setup(over: Partial<GhostConfig>) {
    const clock = new FakeClock(20_000);
    const events: LogEvent[] = [];
    const cfg = testConfig(over);
    const policy = new TimingPolicy({ config: () => cfg, clock: () => clock.now(), log: (e) => events.push(e) });
    return { policy, clock, events, cfg };
  }

  it("llm delegates to ConfidenceTimer (the default, unchanged behaviour)", () => {
    const { policy, cfg } = setup({});
    expect(cfg.timing).toBe("llm");
    expect(policy.name).toBe("timing:llm");
    expect(policy.decide(makeSuggestion({ confidence: 0.9 }), { ...ctx(cfg, 0), showNowAbove: 0.75 }).why).toBe("confidence>=showNow");
  });

  it("cdhf gate skips auto calls when stage 1 is sure of a reject, never requests or patrol", () => {
    const sure: CdhfWeights = { version: "x", trainedOn: 0, context: { bias: -5, w: {} }, full: { bias: 0, w: {} } };
    const { policy, events } = setup({ timing: "cdhf", cdhfWeights: sure });
    expect(policy.gate("auto")).toBe(false);
    expect(policy.gate("tidy")).toBe(false);
    expect(policy.gate("requested")).toBe(true);
    expect(policy.gate("patrol")).toBe(true);
    expect(policy.stats.gated).toBe(2);
    expect(events[0]).toMatchObject({ type: "timing", policy: "cdhf", stage: "gate", decision: "skip", mode: "auto" });
    expect((events[0] as TimingEvent).features).toHaveProperty("idleSec");
  });

  it("cdhf gate lets an uncertain prediction through (entropy above t_r)", () => {
    const unsure: CdhfWeights = { version: "x", trainedOn: 0, context: { bias: -2.2, w: {} }, full: { bias: 0, w: {} } };
    const { policy } = setup({ timing: "cdhf", cdhfWeights: unsure, cdhfGateBelow: 0.12, cdhfGateEntropy: 0.3 });
    expect(policy.gate("auto")).toBe(true); // p ~ 0.10, entropy ~ 0.47 bits
    const llm = setup({ cdhfWeights: unsure });
    expect(llm.policy.gate("auto")).toBe(true);
  });

  it("logs every show with features and the CDHF p, under every policy", () => {
    const { policy, events } = setup({ timing: "llm" });
    const s = makeSuggestion({ id: "g1", confidence: 0.7 });
    policy.listeners.onShow!(s, "pause", 21_000);
    expect(events[0]).toMatchObject({ type: "timing", policy: "llm", stage: "show", suggestionId: "g1", why: "pause", mode: "auto" });
    const e = events[0] as TimingEvent;
    expect(e.p).toBeGreaterThan(0);
    expect(e.features!.confidence).toBeCloseTo(0.2);
    policy.listeners.onEnd!(s, "esc", 100, undefined, 21_100);
    expect(policy.activity.snapshot().dismissRun).toBe(1);
  });

  it("ignores malformed weights from an override and falls back to the prior", () => {
    const { policy } = setup({ cdhfWeights: { nope: 1 } as never });
    expect(policy.weights()).toBe(PRIOR_WEIGHTS);
  });
});
