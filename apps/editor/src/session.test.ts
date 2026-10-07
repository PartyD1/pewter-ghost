import { AgentClient } from "@physsim";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHOR, TILE, type FillRequest, type Filler, type LogEvent, type Suggestion, type VerifiedSuggestion } from "./contracts";
import { starterSnapshot } from "./editor/newLevel";
import { FillerRegistry, StubFiller, sleep } from "./fill/Filler";
import { LevelModel } from "./level/LevelModel";
import { checkCompleteness } from "./research/completeness";
import { validateEvent } from "./research/schema";
import { FakeClock } from "./suggest/fakeClock";
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
  type FillOutcome,
  type GhostSink,
} from "./session";

const cfgWith = (over: Partial<GhostConfig> = {}): GhostConfig => ({
  ...structuredClone(DEFAULT_CONFIG),
  fillDebounceMs: 0,
  ...over,
});

function starterModel(): LevelModel {
  const m = new LevelModel();
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
function managerSink(cfg: () => GhostConfig, listeners = {}) {
  const offers: VerifiedSuggestion[] = [];
  const reports: unknown[] = [];
  const manager = new SuggestionManager({ config: cfg, listeners });
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

  function makeLoop(filler: Filler | null, opts: { patrol?: boolean } = {}) {
    const registry = new FillerRegistry();
    registry.register(new StubFiller());
    if (filler) registry.register(filler);
    cfg.filler = filler ? (filler.name as GhostConfig["filler"]) : "none";
    const l = new FillLoop({
      model,
      agent,
      registry,
      log: (e) => log.push(e),
      config: () => cfg,
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

  it("speculative fills: newest wins and superseded calls are logged", async () => {
    // A slow stub so each placement replaces the call in flight.
    const slow = new StubFiller({ delayMs: 150 });
    const l = makeLoop(slow);
    const { sink, offers } = managerSink(() => cfg);
    l.setGhost(sink);
    drawStairs(model); // three placements, each debounced to 0 ms; they arrive in one tick
    await sleep(5);
    model.beginStroke();
    model.paintTile(15, 11, TILE.GRASS);
    model.endStroke();
    await waitFor(() => outcomes.some((o) => !o.superseded));
    await sleep(50);
    const calls = log.filter((e): e is Extract<LogEvent, { type: "fill.call" }> => e.type === "fill.call");
    expect(calls.some((c) => c.superseded)).toBe(true);
    const sup = calls.find((c) => c.superseded)!;
    expect(sup.error).toBe("superseded");
    expect(sup.requestHash).toMatch(/^[0-9a-f]{64}$/);
    // Only the newest request can reach the manager: it continues from (15,11).
    expect(offers.length).toBe(1);
    expect(offers[0].adds[0]).toMatchObject({ x: 16, y: 10 });
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
