import { AgentClient } from "@physsim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHOR, TILE, type FillRequest, type Filler, type LogEvent, type Suggestion, type VerifiedSuggestion } from "./contracts";
import { starterSnapshot } from "./editor/newLevel";
import { FillerRegistry, StubFiller, sleep } from "./fill/Filler";
import { LevelModel } from "./level/LevelModel";
import { checkCompleteness } from "./research/completeness";
import { validateEvent } from "./research/schema";
import { FakeClock, type Clock } from "./suggest/fakeClock";
import { DEFAULT_CONFIG, resetConfig, type GhostConfig } from "./suggest/config";
import { SuggestionManager } from "./suggest/SuggestionManager";
import {
  FillLoop,
  PewterApp,
  SessionLog,
  buildRegistry,
  resolveConfig,
  sessionEvent,
  urlOverrides,
  type FillLoopOptions,
  type FillOutcome,
  type GhostSink,
} from "./session";

const cfgWith = (over: Partial<GhostConfig> = {}): GhostConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  fillDebounceMs: 0,
  // drawStairs paints in one tick; most tests are about one coalesced call.
  // The leading-edge timing has its own tests below.
  fillLeadingEdge: false,
  ...over,
});

function starterModel(clock?: () => number): LevelModel {
  const m = new LevelModel(clock ? { clock } : {});
  m.load(starterSnapshot({ w: m.w, h: m.h }));
  return m;
}

/** Three rising steps off the start platform (ground at y=15, platform x 0..11). */
function drawStairs(m: LevelModel): void {
  for (const [x, y] of [
    [12, 14],
    [13, 13],
    [14, 12],
  ]) {
    m.beginStroke();
    m.paintTile(x, y, TILE.GRASS);
    m.endStroke();
  }
}

/** A ghost sink backed by a real SuggestionManager, like GhostSession. */
function managerSink(cfg: () => GhostConfig, listeners = {}, clock?: Clock) {
  const offers: VerifiedSuggestion[] = [];
  const reports: unknown[] = [];
  const manager = new SuggestionManager({ config: cfg, listeners, clock });
  const sink: GhostSink = {
    offer: (s, o) => {
      offers.push(s);
      return manager.offer(s, o);
    },
    reportFill: (i) => reports.push(i),
  };
  return { sink, offers, reports, manager };
}

function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("config resolution (G-33)", () => {
  it("reads filler, proxy and callTimeoutMs from the URL and ignores junk", () => {
    expect(urlOverrides("?filler=stub&dev=1&token=abc")).toEqual({ filler: "stub" });
    expect(urlOverrides("?filler=gpt&proxy=javascript:alert(1)&callTimeoutMs=-5")).toEqual({});
    expect(urlOverrides("?filler=none&proxy=http://127.0.0.1:9000/&callTimeoutMs=4000")).toEqual({
      filler: "none",
      proxyUrl: "http://127.0.0.1:9000",
      callTimeoutMs: 4000,
    });
  });

  it("defaults <- URL <- proxy session overrides; a local fallback session changes nothing", () => {
    const url = { filler: "stub" as const, callTimeoutMs: 3000 };
    const local = resolveConfig(url, { fromProxy: false, overrides: { filler: "llm" } });
    expect(local.filler).toBe("stub");
    expect(local.callTimeoutMs).toBe(3000);
    expect(local.pauseMs).toBe(DEFAULT_CONFIG.pauseMs);
    const remote = resolveConfig(url, { fromProxy: true, overrides: { filler: "none", pauseMs: 1200 } });
    expect(remote.filler).toBe("none");
    expect(remote.pauseMs).toBe(1200);
    expect(remote.callTimeoutMs).toBe(3000);
    expect(DEFAULT_CONFIG.filler).toBe("llm"); // never mutated
  });

  it("registers the LLM filler only with a token; unknown fillers run as none", () => {
    const noTok = buildRegistry(cfgWith({ filler: "llm" }), { sessionId: "s", token: null });
    expect(noTok.activeName).toBe("none");
    expect(noTok.has("stub")).toBe(true);
    const tok = buildRegistry(cfgWith({ filler: "llm" }), { sessionId: "s", token: "t" });
    expect(tok.activeName).toBe("llm");
    expect(buildRegistry(cfgWith({ filler: "algo" }), { sessionId: "s", token: "t" }).activeName).toBe("none");
    expect(buildRegistry(cfgWith({ filler: "none" }), { sessionId: "s", token: "t" }).activeName).toBe("none");
  });
});

describe("SessionLog", () => {
  it("buffers until open, then writes the session event first", () => {
    const sl = new SessionLog();
    sl.log({ type: "undo", t: 1, what: "own" });
    sl.log({ type: "play.start", t: 2 });
    expect(sl.pendingCount).toBe(2);
    const got: LogEvent[] = [];
    const ev = sessionEvent({ sessionId: "abc", filler: "stub", t: 0, commit: "test" }, cfgWith());
    sl.open({ log: (e) => got.push(e) }, ev);
    sl.log({ type: "play.end", t: 3, reachedGoal: false, deaths: 0 });
    expect(got.map((e) => e.type)).toEqual(["session", "undo", "play.start", "play.end"]);
    expect(validateEvent(got[0]).ok).toBe(true);
    expect(JSON.stringify(got[0])).not.toMatch(/token/i);
  });

  it("drops (and counts) events past the pre-session cap", () => {
    const sl = new SessionLog(2);
    for (let i = 0; i < 5; i++) sl.log({ type: "play.start", t: i });
    expect(sl.pendingCount).toBe(2);
    expect(sl.dropped).toBe(3);
  });
});

describe("FillLoop", () => {
  let model: LevelModel;
  let agent: AgentClient;
  let log: LogEvent[];
  let cfg: GhostConfig;
  let loop: FillLoop | null;
  let outcomes: FillOutcome[];

  beforeEach(() => {
    resetConfig();
    model = starterModel();
    agent = new AgentClient({ worker: null });
    log = [];
    outcomes = [];
    cfg = cfgWith();
    loop = null;
  });
  afterEach(() => {
    loop?.dispose();
    agent.dispose();
  });

  function makeLoop(filler: Filler | null, opts: { patrol?: boolean; clock?: () => number; agent?: FillLoopOptions["agent"] } = {}) {
    const registry = new FillerRegistry();
    registry.register(new StubFiller());
    if (filler) registry.register(filler);
    cfg.filler = filler ? (filler.name as GhostConfig["filler"]) : "none";
    const l = new FillLoop({
      model,
      agent: opts.agent ?? agent,
      registry,
      log: (e) => log.push(e),
      config: () => cfg,
      clock: opts.clock,
      patrol: opts.patrol ?? false,
      onOutcome: (o) => outcomes.push(o),
    });
    l.refresh();
    loop = l;
    return l;
  }

  it("stub: three stair steps -> a verified ghost reaches the manager; everything is logged", async () => {
    const l = makeLoop(new StubFiller());
    const shown: VerifiedSuggestion[] = [];
    const { sink, offers, reports, manager } = managerSink(() => cfg, { onShow: (s: VerifiedSuggestion) => shown.push(s) });
    l.setGhost(sink);
    drawStairs(model);
    await waitFor(() => offers.length > 0);
    const s = offers[offers.length - 1];
    expect(s.verified).toBe(true);
    expect(s.filler).toBe("stub");
    expect(s.adds.map((a) => [a.x, a.y])).toEqual([
      [15, 11],
      [16, 10],
      [17, 9],
    ]);
    expect(s.path && s.path.length).toBeGreaterThan(1);
    // Confidence 0.8 >= showNowAbove 0.75: shown at once.
    expect(manager.shown?.id).toBe(s.id);
    expect(shown.length).toBe(1);
    expect(reports.length).toBeGreaterThan(0);

    const places = log.filter((e) => e.type === "place");
    expect(places).toHaveLength(3);
    expect(places.every((e) => e.type === "place" && e.author === AUTHOR.PERSON)).toBe(true);
    const calls = log.filter((e): e is Extract<LogEvent, { type: "fill.call" }> => e.type === "fill.call");
    const ok = calls.filter((c) => c.verdictStage === "ok");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok[ok.length - 1].requestHash).toBe(s.requestHash);
    for (const c of calls) {
      expect(c.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(validateEvent(c).ok).toBe(true);
    }
  });

  it("none = human-only: placements are logged, no calls, no ghosts, no patrol", async () => {
    const l = makeLoop(null, { patrol: true });
    const { sink, offers } = managerSink(() => cfg);
    l.setGhost(sink);
    expect(l.activeFiller).toBe("none");
    drawStairs(model);
    expect(await l.request()).toBeNull();
    await sleep(30);
    expect(offers).toHaveLength(0);
    expect(log.filter((e) => e.type === "fill.call")).toHaveLength(0);
    expect(log.filter((e) => e.type === "place")).toHaveLength(3);
    expect(l.patrol.running).toBe(false);
  });

  it("a failed answer is sent back once and both calls are logged with their verdicts", async () => {
    // A filler that always proposes an enemy with no floor under it (fails the validator).
    let calls = 0;
    const bad: Filler = {
      name: "llm",
      async fill(req: FillRequest): Promise<Suggestion> {
        calls++;
        return {
          id: `bad${calls}`,
          kind: "extend",
          adds: [],
          removes: [],
          entities: [{ kind: "slime", x: 16, y: 3 }],
          confidence: 0.9,
          label: "a slime in the sky",
          anchor: { x: 16, y: 3 },
          requestHash: `${req.previousFailure ? "b" : "a"}`.repeat(64),
          filler: "llm",
          latencyMs: 1,
          mode: req.mode,
          verified: false,
          attempts: 1,
        };
      },
    };
    const l = makeLoop(bad);
    const { sink, offers } = managerSink(() => cfg);
    l.setGhost(sink);
    drawStairs(model);
    await waitFor(() => outcomes.some((o) => !o.superseded));
    const o = outcomes.find((x) => !x.superseded)!;
    expect(o.verify?.verified).toBeNull();
    expect(o.verify?.sendBack).toBe(true);
    expect(calls).toBe(2);
    expect(offers).toHaveLength(0);
    const fc = log.filter((e): e is Extract<LogEvent, { type: "fill.call" }> => e.type === "fill.call" && !e.superseded);
    expect(fc).toHaveLength(2);
    expect(fc[0].sendBack).toBe(true);
    expect(fc[0].verdictStage).not.toBe("ok");
    expect(fc[0].reason).toBeTruthy();
    expect(fc[1].requestHash).toBe("b".repeat(64));
    expect(o.events).toHaveLength(2);
  });

  it("Ctrl+Space runs a 'requested' fill", async () => {
    const l = makeLoop(new StubFiller());
    const { sink, offers } = managerSink(() => cfg);
    l.setGhost(sink);
    model.beginStroke();
    model.paintTile(12, 14, TILE.GRASS);
    model.paintTile(13, 13, TILE.GRASS);
    model.endStroke();
    l.cancel();
    const o = await l.request();
    expect(o?.mode).toBe("requested");
    expect(o?.request.mode).toBe("requested");
    expect(offers.at(-1)?.mode).toBe("requested");
  });

  describe("leading-edge calls (fillLeadingEdge)", () => {
    /** A filler that records how many recent placements each request saw and answers nothing. */
    function counting(): { filler: Filler; seen: number[] } {
      const seen: number[] = [];
      return {
        seen,
        filler: {
          name: "stub",
          fill: async (req: FillRequest) => {
            seen.push(req.recent.length);
            return null;
          },
        },
      };
    }
    function paintOne(x: number, y: number): void {
      model.beginStroke();
      model.paintTile(x, y, TILE.GRASS);
      model.endStroke();
    }

    it("the first placement after a quiet spell calls at once, before the coalescing window closes", async () => {
      cfg.fillLeadingEdge = true;
      cfg.fillDebounceMs = 5000; // a window that never closes during the test
      const { filler, seen } = counting();
      makeLoop(filler);
      paintOne(12, 14);
      await waitFor(() => seen.length > 0, 1000);
      expect(seen).toHaveLength(1);
    });

    it("a burst gives one leading call with the first tile and one trailing call with the whole burst", async () => {
      cfg.fillLeadingEdge = true;
      cfg.fillDebounceMs = 40;
      const { filler, seen } = counting();
      makeLoop(filler);
      drawStairs(model); // three placements in one tick
      await waitFor(() => seen.length >= 2, 2000);
      await sleep(120);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBeGreaterThan(seen[0]);
    });

    it("switched off, a burst is one coalesced call after the window", async () => {
      cfg.fillLeadingEdge = false;
      cfg.fillDebounceMs = 40;
      const { filler, seen } = counting();
      makeLoop(filler);
      drawStairs(model);
      await sleep(10);
      expect(seen).toHaveLength(0);
      await waitFor(() => seen.length >= 1, 2000);
      await sleep(120);
      expect(seen).toHaveLength(1);
    });

    it("a placement after the window closes starts a new leading call", async () => {
      cfg.fillLeadingEdge = true;
      cfg.fillDebounceMs = 30;
      const { filler, seen } = counting();
      makeLoop(filler);
      paintOne(12, 14);
      await waitFor(() => seen.length === 1, 1000);
      await sleep(80); // window closed, no trailing call (nothing else arrived)
      expect(seen).toHaveLength(1);
      paintOne(13, 13);
      await waitFor(() => seen.length === 2, 1000);
    });
  });

  it("requests carry the real brief, measured numbers and past ghosts with pattern tags", async () => {
    const l = makeLoop(new StubFiller());
    const { sink, manager } = managerSink(() => cfg, { onEnd: l.managerListeners.onEnd });
    l.setGhost(sink);
    drawStairs(model);
    await waitFor(() => !!manager.shown);
    manager.dismiss();
    const req = l.buildRequest("auto");
    expect(req.briefVersion).toMatch(/^brief\.v1-/);
    expect(req.brief.length).toBeGreaterThan(20);
    expect(req.measured.gapHist).toHaveLength(5);
    expect(req.lastGhosts).toHaveLength(1);
    expect(req.lastGhosts[0]).toMatchObject({ kind: "extend", outcome: "esc" });
    expect(req.lastGhosts[0].patterns?.length ?? 0).toBeGreaterThanOrEqual(0);
    expect(l.recentGhosts()[0].adds?.length).toBe(3);
  });

  it("pauses during Play: no fills", async () => {
    const l = makeLoop(new StubFiller());
    const { sink, offers } = managerSink(() => cfg);
    l.setGhost(sink);
    l.setPaused(true);
    drawStairs(model);
    await sleep(40);
    expect(offers).toHaveLength(0);
    expect(log.filter((e) => e.type === "fill.call")).toHaveLength(0);
    l.setPaused(false);
  });

  it("patrol: a gap the knight cannot clear gets a verified Fix (local repair after the stub fails)", async () => {
    cfg.patrolIdleMs = 10;
    // The starter has a full ground floor: cut it back to the old 12-column
    // start platform (x 0-11), so the pit below is there to be found.
    const snap = model.snapshot();
    for (let y = 0; y < snap.h; y++) for (let x = 12; x < snap.w; x++) snap.cells[y * snap.w + x] = 0;
    snap.entities = snap.entities.filter((e) => e.x < 12);
    model.load(snap);
    const l = makeLoop(new StubFiller(), { patrol: true });
    const { sink, offers } = managerSink(() => cfg);
    l.setGhost(sink);
    // A platform past a 14-wide pit (start platform ends at x=11; the knight clears 11).
    model.beginStroke();
    for (let x = 26; x <= 31; x++) model.paintTile(x, 15, TILE.GRASS);
    model.endStroke();
    l.cancel(); // only the patrol trip matters here
    await waitFor(() => log.some((e) => e.type === "patrol"), 15000);
    const p = log.find((e): e is Extract<LogEvent, { type: "patrol" }> => e.type === "patrol")!;
    expect(p.beatable).toBe(false);
    expect(p.blockedAt).toBeDefined();
    await waitFor(() => outcomes.some((o) => o.mode === "patrol" && !o.superseded), 15000);
    const o = outcomes.find((x) => x.mode === "patrol" && !x.superseded)!;
    expect(o.request.mode).toBe("patrol");
    expect(o.request.blockedAt).toBeDefined();
    expect(o.request.previousFailure?.stage).toBe("agent");
    const v = o.verify?.verified;
    expect(v, JSON.stringify(o.verify?.verdicts)).toBeTruthy();
    expect(v!.kind).toBe("fix");
    expect(v!.mode).toBe("patrol");
    expect(v!.adds.length).toBeLessThanOrEqual(3);
    expect(offers.some((s) => s.id === v!.id)).toBe(true);
  }, 30000);

  it("a scripted stub session passes the completeness checker", async () => {
    const l = makeLoop(new StubFiller());
    const { manager, sink } = managerSink(() => cfg, {
      onShow: (s: VerifiedSuggestion, because: import("./contracts").ShownBecause, t: number) =>
        log.push({ type: "ghost.show", t, suggestionId: s.id, kind: s.kind, confidence: s.confidence, shownBecause: because, cells: s.adds.length + s.entities.length, label: s.label }),
      onEnd: (s: VerifiedSuggestion, outcome: import("./contracts").GhostOutcome, dwellMs: number, _a: number | undefined, t: number) =>
        log.push({ type: "ghost.end", t, suggestionId: s.id, outcome, dwellMs: Math.round(dwellMs) }),
    });
    l.setGhost(sink);
    log.push(sessionEvent({ sessionId: "test", filler: "stub", t: 0, commit: "test" }, cfg));
    drawStairs(model);
    await waitFor(() => !!manager.shown);
    manager.accept();
    const res = checkCompleteness(log, { expectTypes: ["session", "place", "fill.call", "ghost.show", "ghost.end"] });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Speculation with reconciliation (decisions 2026-10-08)
// ---------------------------------------------------------------------------

type FillCall = Extract<LogEvent, { type: "fill.call" }>;

/** One call to the scripted filler: answer it (or not) whenever the test likes. */
interface ScriptedCall {
  request: FillRequest;
  signal?: AbortSignal;
  aborted: boolean;
  answer(s: Suggestion | null): void;
}

/** A filler whose answers the test releases by hand, in any order (a stand-in for the model). */
class ScriptedFiller implements Filler {
  readonly name = "llm" as const;
  readonly calls: ScriptedCall[] = [];
  fill(request: FillRequest, signal?: AbortSignal): Promise<Suggestion | null> {
    return new Promise((resolve, reject) => {
      const call: ScriptedCall = { request, signal, aborted: false, answer: resolve };
      this.calls.push(call);
      signal?.addEventListener(
        "abort",
        () => {
          call.aborted = true;
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        },
        { once: true },
      );
    });
  }
}

let answerSeq = 0;
/** A grass staircase answer in level coordinates, as the model's "staircase, N more steps". */
function stairsAnswer(cells: [number, number][], over: Partial<Suggestion> = {}): Suggestion {
  answerSeq++;
  return {
    id: `ans${answerSeq}`,
    kind: "finish",
    adds: cells.map(([x, y]) => ({ x, y, tile: TILE.GRASS })),
    removes: [],
    entities: [],
    confidence: 0.85,
    label: `staircase, ${cells.length} more steps`,
    anchor: { x: cells[0][0], y: cells[0][1] },
    requestHash: answerSeq.toString(16).padStart(64, "0"),
    filler: "llm",
    // Live latency: far above sendBackIfUnderMs, so no send-back.
    latencyMs: 2100,
    mode: "auto",
    verified: false,
    attempts: 1,
    ...over,
  };
}

describe("FillLoop speculation: calls are not cancelled, answers are reconciled", () => {
  let clock: FakeClock;
  let model: LevelModel;
  let agent: AgentClient;
  let log: LogEvent[];
  let cfg: GhostConfig;
  let outcomes: FillOutcome[];
  let loop: FillLoop | null;
  let filler: ScriptedFiller;
  let manager: SuggestionManager;
  let offers: VerifiedSuggestion[];
  let drops: { id: string; reason: string }[];
  let ends: { id: string; outcome: string }[];
  let offPlacement: (() => void) | null;

  beforeEach(() => {
    resetConfig();
    clock = new FakeClock(1000);
    const now = () => clock.now();
    model = starterModel(now);
    agent = new AgentClient({ worker: null });
    log = [];
    outcomes = [];
    cfg = cfgWith();
    filler = new ScriptedFiller();
    drops = [];
    ends = [];
    const registry = new FillerRegistry();
    registry.register(filler);
    cfg.filler = "llm";
    loop = makeSpecLoop();
    const sink = managerSink(
      () => cfg,
      {
        onDrop: (s: Suggestion, reason: string) => drops.push({ id: s.id, reason }),
        onEnd: (s: VerifiedSuggestion, outcome: string) => ends.push({ id: s.id, outcome }),
      },
      clock,
    );
    manager = sink.manager;
    offers = sink.offers;
    loop.setGhost(sink.sink);
    // As GhostSession does: the manager sees the person's placements too.
    offPlacement = model.onPlacement((e) => manager.onPlacement(e));

    function makeSpecLoop(a: FillLoopOptions["agent"] = agent): FillLoop {
      // Bind this test's arrays: a disposed loop of an earlier test still
      // settles its cancelled trips and must not write into the next test's.
      const myLog = log;
      const myOutcomes = outcomes;
      const l = new FillLoop({
        model,
        agent: a,
        registry,
        log: (e) => myLog.push(e),
        config: () => cfg,
        clock: now,
        patrol: false,
        onOutcome: (o) => myOutcomes.push(o),
      });
      l.refresh();
      return l;
    }
  });
  afterEach(() => {
    offPlacement?.();
    loop?.dispose();
    agent.dispose();
  });

  /** The person paints one tile (one stroke), then the debounced fill fires. */
  async function place(x: number, y: number, tile: number = TILE.GRASS): Promise<void> {
    model.beginStroke();
    model.paintTile(x, y, tile as (typeof TILE)[keyof typeof TILE]);
    model.endStroke();
    await sleep(5);
  }
  const fillCalls = () => log.filter((e): e is FillCall => e.type === "fill.call");
  const outcomeOf = (seq: number) => outcomes.find((o) => o.seq === seq);
  const settled = (seq: number) => waitFor(() => !!outcomeOf(seq));

  it("three placements, answers out of order: the 1st answer still fits after the 3rd placement and is shown; the 3rd replaces it; the late 2nd is stale", async () => {
    // A 3-step staircase at 400 ms per tile, as measured live.
    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    clock.advance(400);
    await place(14, 12);
    expect(filler.calls).toHaveLength(3);
    expect(filler.calls.some((c) => c.aborted)).toBe(false); // nothing cancelled by newer placements
    expect(loop!.inFlight).toBe(3);

    // 2.1 s after the first placement, its answer arrives: "three more steps" from step 1.
    // Steps 2 and 3 were since drawn exactly as proposed: trimmed, (15,11) is left and still fits.
    clock.set(3100);
    filler.calls[0].answer(stairsAnswer([[13, 13], [14, 12], [15, 11]]));
    await settled(1);
    const o1 = outcomeOf(1)!;
    expect(o1.superseded).toBe(false);
    expect(o1.trimmed).toBe(2);
    expect(o1.offer).toEqual({ status: "shown", because: "now" });
    expect(manager.shown?.adds.map((a) => [a.x, a.y])).toEqual([[15, 11]]);
    expect(manager.shown?.verified).toBe(true);

    // The 3rd answer arrives: newer, same structure, different cells -> the manager replaces the ghost.
    clock.set(3900);
    filler.calls[2].answer(stairsAnswer([[15, 11], [16, 10]]));
    await settled(3);
    const o3 = outcomeOf(3)!;
    expect(o3.superseded).toBe(false);
    expect(o3.trimmed).toBe(0);
    expect(o3.offer).toEqual({ status: "shown", because: "now" });
    expect(manager.shown?.adds.map((a) => [a.x, a.y])).toEqual([
      [15, 11],
      [16, 10],
    ]);
    expect(ends).toEqual([{ id: o1.verify!.verified!.id, outcome: "replaced" }]);

    // The 2nd answer comes in last: an answer to a newer request covering this area was already shown.
    clock.set(5200);
    filler.calls[1].answer(stairsAnswer([[14, 12], [15, 11], [16, 10]]));
    await settled(2);
    expect(outcomeOf(2)).toMatchObject({ superseded: true, dropReason: "stale: newer shown" });
    expect(manager.shown?.id).toBe(o3.verify!.verified!.id);
    expect(offers).toHaveLength(2);

    // Logging stays truthful: two answers verified and offered, one dropped as stale.
    const calls = fillCalls();
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(validateEvent(c, { strict: true }).ok, JSON.stringify(c)).toBe(true);
    const [c1, c3, c2] = calls; // in order of arrival
    expect(c1).toMatchObject({ superseded: false, verdictStage: "ok", act: true });
    expect(c3).toMatchObject({ superseded: false, verdictStage: "ok" });
    expect(c2).toMatchObject({ superseded: true, error: "superseded", reason: "stale: newer shown" });
    expect(c2.verdictStage).toBeUndefined(); // dropped before verification
    expect(loop!.stats).toMatchObject({ requests: 3, superseded: 1, stale: 1, trimmed: 1, offered: 2 }); // trimmed counts answers
  });

  it("a newer answer with the same cells as the shown ghost is dropped by the manager (duplicate), not shown twice", async () => {
    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    filler.calls[0].answer(stairsAnswer([[13, 13], [14, 12]]));
    await settled(1);
    expect(manager.shown?.adds.map((a) => [a.x, a.y])).toEqual([[14, 12]]);
    filler.calls[1].answer(stairsAnswer([[14, 12]]));
    await settled(2);
    expect(outcomeOf(2)?.offer).toEqual({ status: "dropped", reason: "duplicate" });
    expect(manager.shown?.id).toBe(outcomeOf(1)!.verify!.verified!.id);
  });

  it("an answer whose cells were drawn over since its request is dropped with a reason", async () => {
    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    clock.advance(400);
    // The person puts DIRT where the answer will propose grass.
    await place(14, 12, TILE.DIRT);
    filler.calls[1].answer(stairsAnswer([[14, 12], [15, 11]]));
    await settled(2);
    expect(outcomeOf(2)).toMatchObject({ superseded: true, dropReason: "stale: cells drawn" });
    expect(outcomeOf(2)!.verify).toBeUndefined();
    expect(offers).toHaveLength(0);
    expect(manager.shown).toBeNull();
    const c = fillCalls().at(-1)!;
    expect(c).toMatchObject({ superseded: true, error: "superseded", reason: "stale: cells drawn", act: true });
    expect(c.verdictStage).toBeUndefined(); // dropped before verification
    expect(validateEvent(c, { strict: true }).ok).toBe(true);

    // An answer the person has since drawn completely: right, but late.
    filler.calls[0].answer(stairsAnswer([[13, 13]]));
    await settled(1);
    expect(outcomeOf(1)).toMatchObject({ superseded: true, dropReason: "stale: all cells drawn" });
  });

  it("an answer whose cells the person PARTLY filled with the same tiles is trimmed to the rest and shown", async () => {
    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    clock.advance(600);
    // Still drawing the same pattern: the next step, exactly as the answer will propose it.
    await place(14, 12);
    clock.advance(1500);
    filler.calls[1].answer(stairsAnswer([[14, 12], [15, 11], [16, 10]]));
    await settled(2);
    const o = outcomeOf(2)!;
    expect(o).toMatchObject({ superseded: false, trimmed: 1 });
    const v = o.verify!.verified!;
    expect(v.adds.map((a) => [a.x, a.y])).toEqual([
      [15, 11],
      [16, 10],
    ]);
    expect(v.anchor).toEqual({ x: 15, y: 11 });
    expect(manager.shown?.id).toBe(v.id);
    // The fill.call reports the model's answer as it came (3 tiles) and its verdict.
    expect(fillCalls().at(-1)).toMatchObject({ superseded: false, verdictStage: "ok", tiles: 3 });
  });

  it("over maxInFlight: a new placement aborts only the OLDEST call, logged superseded", async () => {
    cfg.maxInFlight = 2;
    await place(12, 14);
    await place(13, 13);
    expect(filler.calls.map((c) => c.aborted)).toEqual([false, false]);
    await place(14, 12);
    expect(filler.calls.map((c) => c.aborted)).toEqual([true, false, false]);
    await settled(1);
    expect(outcomeOf(1)).toMatchObject({ superseded: true, dropReason: "aborted: over maxInFlight" });
    const c = fillCalls()[0];
    expect(c).toMatchObject({ superseded: true, error: "superseded", reason: "aborted: over maxInFlight" });
    expect(validateEvent(c, { strict: true }).ok).toBe(true);
    // The two newer calls are still running and can still be shown.
    filler.calls[2].answer(stairsAnswer([[15, 11], [16, 10]]));
    await settled(3);
    expect(outcomeOf(3)?.offer?.status).toBe("shown");
    expect(filler.calls[1].aborted).toBe(false);
  });

  it("an answer whose request is older than maxAnswerAgeMs is dropped", async () => {
    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    clock.advance(cfg.maxAnswerAgeMs + 1);
    filler.calls[1].answer(stairsAnswer([[14, 12], [15, 11]]));
    await settled(2);
    expect(outcomeOf(2)).toMatchObject({ superseded: true, dropReason: "stale: too old" });
    expect(fillCalls().at(-1)).toMatchObject({ superseded: true, error: "superseded", reason: "stale: too old" });
    expect(offers).toHaveLength(0);
    // Not too old yet at exactly maxAnswerAgeMs: the 1st request was built 400 ms earlier... and is now too old as well.
    filler.calls[0].answer(stairsAnswer([[13, 13], [14, 12]]));
    await settled(1);
    expect(outcomeOf(1)?.dropReason).toBe("stale: too old");
  });

  it("a newer answer offered while an older one is still being verified makes the older one stale before its offer", async () => {
    // Hold the agent for the first verification only.
    let gate!: () => void;
    let gated = 0;
    const held = new Promise<void>((r) => (gate = r));
    const slowAgent: FillLoopOptions["agent"] = {
      verify: async (q, o) => {
        if (gated++ === 0) await held;
        return agent.verify(q, o);
      },
      patrol: (q, o) => agent.patrol(q, o),
    };
    loop!.dispose();
    const registry = new FillerRegistry();
    registry.register(filler);
    loop = new FillLoop({ model, agent: slowAgent, registry, log: (e) => log.push(e), config: () => cfg, clock: () => clock.now(), patrol: false, onOutcome: (o) => outcomes.push(o) });
    loop.refresh();
    const sink = managerSink(() => cfg, {}, clock);
    manager = sink.manager;
    loop.setGhost(sink.sink);
    offPlacement?.();
    offPlacement = model.onPlacement((e) => manager.onPlacement(e));

    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    filler.calls[0].answer(stairsAnswer([[13, 13], [14, 12]])); // trimmed to (14,12), verification held
    await waitFor(() => gated === 1);
    filler.calls[1].answer(stairsAnswer([[14, 12], [15, 11]]));
    await settled(2);
    expect(outcomeOf(2)?.offer?.status).toBe("shown");
    gate();
    await settled(1);
    const o1 = outcomeOf(1)!;
    expect(o1).toMatchObject({ superseded: true, dropReason: "stale: newer shown" });
    expect(o1.verify?.verified).toBeTruthy(); // it passed verification, then lost to the newer answer
    expect(manager.shown?.id).toBe(outcomeOf(2)!.verify!.verified!.id);
    const c1 = fillCalls().find((c) => c.requestHash === o1.result.requestHash)!;
    expect(c1).toMatchObject({ superseded: true, error: "superseded", reason: "stale: newer shown", verdictStage: "ok" });
  });

  it("a late answer for an area the person has LEFT is dropped (stale: area left): no ghost behind them, no dismissal counted", async () => {
    await place(12, 14); // call 1, near the start
    clock.advance(400);
    await place(60, 12); // the person moves on: call 2
    clock.advance(400);
    await place(61, 12); // call 3
    expect(filler.calls.map((c) => c.aborted)).toEqual([false, false, false]);
    const streak = manager.streak;
    const above = manager.showNowAbove;

    // Call 1 answers late, within maxAnswerAgeMs, its cells untouched, nothing newer offered there.
    clock.set(3100);
    filler.calls[0].answer(stairsAnswer([[13, 13], [14, 12]]));
    await settled(1);
    expect(outcomeOf(1)).toMatchObject({ superseded: true, dropReason: "stale: area left" });
    expect(outcomeOf(1)!.verify).toBeUndefined();
    expect(offers).toHaveLength(0);
    expect(manager.shown).toBeNull();
    expect(fillCalls().at(-1)).toMatchObject({ superseded: true, error: "superseded", reason: "stale: area left" });
    expect(validateEvent(fillCalls().at(-1)!, { strict: true }).ok).toBe(true);

    // The person keeps drawing at x=62: nothing was shown, so nothing is dismissed.
    await place(62, 12);
    expect(ends).toEqual([]);
    expect(manager.streak).toBe(streak);
    expect(manager.showNowAbove).toBe(above);

    // The answer where they ARE drawing still shows.
    clock.set(3500);
    filler.calls[2].answer(stairsAnswer([[62, 11], [63, 10]]));
    await settled(3);
    expect(outcomeOf(3)?.offer?.status).toBe("shown");
  });

  it("a NEWER request declining (act:false) its window makes an older answer for that area stale (stale: newer declined)", async () => {
    // A filler that reports the model's answer, so act:false is a real decline.
    const DECLINE = { decline: true } as unknown as Suggestion;
    class Declining extends ScriptedFiller {
      async fillDetailed(request: FillRequest, signal?: AbortSignal) {
        const base = { requestHash: "f".repeat(64), latencyMs: 2100, samples: 1 as const, confidenceSource: "stated" as const, dropped: [], aborted: false, timedOut: false, superseded: false };
        try {
          const s = await this.fill(request, signal);
          if (s === DECLINE) {
            return { ...base, suggestion: null, answer: { act: false, kind: "extend" as const, adds: [], removes: [], entities: [], confidence: 0.2, label: "" } };
          }
          return { ...base, suggestion: s, answer: null };
        } catch {
          return { ...base, suggestion: null, answer: null, aborted: true, error: "aborted" };
        }
      }
    }
    loop!.dispose();
    const declining = new Declining();
    const registry = new FillerRegistry();
    registry.register(declining);
    loop = new FillLoop({ model, agent, registry, log: (e) => log.push(e), config: () => cfg, clock: () => clock.now(), patrol: false, onOutcome: (o) => outcomes.push(o) });
    loop.refresh();
    loop.setGhost(managerSink(() => cfg, {}, clock).sink);
    const startOffers = 0;

    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    // The newest request (more context) says: do nothing here.
    clock.set(2600);
    declining.calls[1].answer(DECLINE);
    await settled(2);
    expect(outcomeOf(2)).toMatchObject({ superseded: false });
    // The older one arrives after it and would have shown.
    clock.set(3100);
    declining.calls[0].answer(stairsAnswer([[13, 13], [14, 12]]));
    await settled(1);
    expect(outcomeOf(1)).toMatchObject({ superseded: true, dropReason: "stale: newer declined" });
    expect(loop.stats.offered).toBe(startOffers);
    expect(fillCalls().at(-1)).toMatchObject({ superseded: true, reason: "stale: newer declined" });
  });

  it("after dispose() a trip settling late writes no fill.call and reports no outcome", async () => {
    await place(12, 14);
    const before = fillCalls().length;
    const outs = outcomes.length;
    loop!.dispose();
    await sleep(20);
    filler.calls[0].answer(stairsAnswer([[13, 13]]));
    await sleep(20);
    expect(fillCalls()).toHaveLength(before);
    expect(outcomes).toHaveLength(outs);
    loop = null;
  });

  it('filler "none" makes zero calls: placements are logged, nothing is in flight', async () => {
    cfg.filler = "none";
    loop!.refresh();
    await place(12, 14);
    clock.advance(400);
    await place(13, 13);
    await sleep(20);
    expect(filler.calls).toHaveLength(0);
    expect(fillCalls()).toHaveLength(0);
    expect(loop!.inFlight).toBe(0);
    expect(loop!.stats.requests).toBe(0);
    expect(log.filter((e) => e.type === "place")).toHaveLength(2);
  });

  it("cancel() (Play, load) aborts every call in flight, logged as cancelled", async () => {
    await place(12, 14);
    await place(13, 13);
    loop!.setPaused(true);
    await settled(1);
    await settled(2);
    expect(filler.calls.every((c) => c.aborted)).toBe(true);
    for (const c of fillCalls()) expect(c).toMatchObject({ superseded: true, error: "superseded", reason: "cancelled" });
    expect(loop!.inFlight).toBe(0);
  });
});

describe("PewterApp boot", () => {
  afterEach(() => resetConfig());

  it("without a token: local session, URL filler, session event first, buffered events after", async () => {
    const model = starterModel();
    const agent = new AgentClient({ worker: null });
    const fetches: string[] = [];
    const app = new PewterApp({
      model,
      search: "?filler=stub",
      agent,
      fetch: (async (u: string) => {
        fetches.push(String(u));
        throw new Error("offline");
      }) as unknown as typeof fetch,
      eventLog: { autoStart: false },
    });
    app.log({ type: "undo", t: 1, what: "own" }); // before the session resolves
    const info = await app.ready;
    expect(info.fromProxy).toBe(false);
    expect(app.loop.activeFiller).toBe("stub");
    const events = app.eventLog!.events();
    expect(events[0].type).toBe("session");
    expect(events[0]).toMatchObject({ type: "session", filler: "stub", sessionId: info.sessionId });
    expect(events[1].type).toBe("undo");
    expect(fetches).toHaveLength(0); // no token: nothing asked of the proxy
    app.dispose();
    agent.dispose();
  });

  it("with a token: GET /session decides the condition (none beats ?filler=stub)", async () => {
    const model = starterModel();
    const agent = new AgentClient({ worker: null });
    const seen: { url: string; auth?: string }[] = [];
    const fetchFn = (async (u: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      seen.push({ url: String(u), auth });
      if (String(u).includes("/session"))
        return new Response(JSON.stringify({ sessionId: "sess-1", condition: "none", overrides: { pauseMs: 900 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const app = new PewterApp({ model, search: "?filler=stub&token=tok123", agent, fetch: fetchFn, eventLog: { autoStart: false } });
    const info = await app.ready;
    expect(info.fromProxy).toBe(true);
    expect(info.sessionId).toBe("sess-1");
    expect(app.loop.activeFiller).toBe("none");
    expect(app.loop.enabled).toBe(false);
    expect(seen[0].url).toContain("/session?token=tok123");
    const ev = app.eventLog!.events()[0] as Extract<LogEvent, { type: "session" }>;
    expect(ev.filler).toBe("none");
    expect((ev.config as { pauseMs: number }).pauseMs).toBe(900);
    expect(JSON.stringify(ev)).not.toContain("tok123");
    app.dispose();
    agent.dispose();
  });
});

describe("no key in the bundle", () => {
  it("app code reads import.meta.env only by static property (else Vite inlines every VITE_* var, the key too)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..", "..", "..");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name !== "node_modules" && !ent.name.startsWith("__")) walk(p);
        } else if (/\.ts$/.test(ent.name) && !/\.test\.ts$/.test(ent.name)) {
          const src = fs.readFileSync(p, "utf8");
          if (/import\.meta\s+as\b|import\.meta\.env(?!\.[A-Z_]+\b)|import\.meta\.env\.VITE_LLM/.test(src)) bad.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, "apps"));
    walk(path.join(root, "packages"));
    expect(bad).toEqual([]);
  });
});
