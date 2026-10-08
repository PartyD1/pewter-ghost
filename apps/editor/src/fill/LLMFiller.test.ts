import { describe, expect, it, vi } from "vitest";
import type { FillRequest, ModelAnswer, ProxyFillBody, ProxyFillResponse } from "../contracts";
import { DEFAULT_CONFIG, type GhostConfig } from "../suggest/config";
import { StubFiller } from "./Filler";
import { requestHash } from "./hash";
import {
  answerCells,
  CANCELLED,
  FillScheduler,
  fillCallEvent,
  LLMFiller,
  logprobConfidence,
  OVER_MAX_IN_FLIGHT,
  pickForVariety,
  sampleAgreement,
  type FillResult,
} from "./LLMFiller";

const request: FillRequest = {
  grid: [
    "Window 8x4 = level x 40..47, y 10..13. All coordinates are window-relative: x 0..7 right, y 0..3 down.",
    "  01234567",
    "0 ........",
    "1 ........",
    "2 ..GG....",
    "3 GGGGGG..",
  ].join("\n"),
  origin: { x: 40, y: 10 },
  size: { w: 8, h: 4 },
  recent: [{ dt: 120, x: 3, y: 2, tile: "grass", tool: "paint" }],
  frontier: { x: 5, y: 3, idleMs: 300 },
  knight: { maxGapStand: 8, maxGapRun: 11, maxRise: 6 },
  measured: { density: 0.3, gapHist: [0, 0, 0, 0, 0], verticality: 0, rewardSpacing: 0, pressure: 0 },
  brief: "notes",
  briefVersion: "test",
  lastGhosts: [{ kind: "extend", label: "flat floor run", outcome: "esc" }],
  mode: "auto",
};

const answer: ModelAnswer = {
  act: true,
  kind: "finish",
  adds: [
    { x: 4, y: 1, tile: "grass" },
    { x: 5, y: 1, tile: "grass" },
  ],
  removes: [],
  entities: [{ kind: "coin", x: 5, y: 0 }],
  confidence: 0.8,
  label: "two more steps",
  levelGuess: "parkour",
};

function cfg(over: Partial<GhostConfig> = {}) {
  return { ...DEFAULT_CONFIG, proxyUrl: "http://proxy.test/", callTimeoutMs: 900, ...over };
}

function response(over: Partial<ProxyFillResponse> = {}): ProxyFillResponse {
  return { answer, latencyMs: 210, model: "gemini-test", promptVersion: "fill.v1-test", requestHash: "abc123", ...over };
}

type FetchCall = { url: string; init: RequestInit };

/** A fetch that answers with `body` after `delayMs`, honouring the abort signal. */
function fakeFetch(body: unknown, opts: { status?: number; delayMs?: number; headers?: Record<string, string> } = {}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      const done = () =>
        resolve(
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status: opts.status ?? 200,
            headers: { "Content-Type": "application/json", ...opts.headers },
          }),
        );
      if (!opts.delayMs) return done();
      const timer = setTimeout(done, opts.delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function filler(f: typeof fetch, over: Partial<GhostConfig> = {}, extra: Partial<ConstructorParameters<typeof LLMFiller>[0]> = {}) {
  let t = 0;
  return new LLMFiller({ sessionId: "s1", token: "tok-secret", config: cfg(over), fetch: f, clock: () => (t += 5), ...extra });
}

describe("LLMFiller", () => {
  it("posts the request with the bearer token and converts to level coordinates", async () => {
    const { fetch, calls } = fakeFetch(response());
    const r = await filler(fetch).fillDetailed(request);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://proxy.test/fill");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-secret");
    const body = JSON.parse(String(calls[0].init.body)) as ProxyFillBody;
    expect(body).toEqual({ sessionId: "s1", request });
    expect(r.error).toBeUndefined();
    expect(r.requestHash).toBe("abc123");
    expect(r.model).toBe("gemini-test");
    expect(r.serverLatencyMs).toBe(210);
    const s = r.suggestion!;
    expect(s.filler).toBe("llm");
    expect(s.adds).toEqual([
      { x: 44, y: 11, tile: 6 },
      { x: 45, y: 11, tile: 6 },
    ]);
    expect(s.entities).toEqual([{ kind: "coin", x: 45, y: 10 }]);
    expect(s.confidence).toBe(0.8);
    expect(s.requestHash).toBe("abc123");
    expect(s.levelGuess).toBe("parkour");
    expect(r.confidenceSource).toBe("stated");
  });

  it("fill() resolves the suggestion; Filler contract", async () => {
    const { fetch } = fakeFetch(response());
    const s = await filler(fetch).fill(request);
    expect(s?.kind).toBe("finish");
  });

  it("returns null for act:false and for answer:null with the proxy's error", async () => {
    const declined = await filler(fakeFetch(response({ answer: { ...answer, act: false, adds: [], entities: [], confidence: 0 } })).fetch).fillDetailed(request);
    expect(declined.suggestion).toBeNull();
    expect(declined.answer?.act).toBe(false);
    expect(declined.error).toBeUndefined();
    const failed = await filler(fakeFetch(response({ answer: null, error: "upstream timeout after 900 ms" })).fetch).fillDetailed(request);
    expect(failed.suggestion).toBeNull();
    expect(failed.error).toBe("upstream timeout after 900 ms");
  });

  it("re-validates the answer on the client", async () => {
    const r = await filler(fakeFetch(response({ answer: { ...answer, adds: [{ x: 1, y: 1, tile: "lava" }] } as unknown as ModelAnswer })).fetch).fillDetailed(request);
    expect(r.suggestion).toBeNull();
    expect(r.error).toBe("answer failed client validation");
  });

  it("reports cells dropped by the converter", async () => {
    const r = await filler(fakeFetch(response({ answer: { ...answer, adds: [...answer.adds, { x: 30, y: 1, tile: "grass" }] } })).fetch).fillDetailed(request);
    expect(r.suggestion?.adds).toHaveLength(2);
    expect(r.dropped).toEqual([{ what: "add", x: 30, y: 1, reason: "outside-window" }]);
  });

  it("never throws: HTTP errors, bad JSON, network failures", async () => {
    const http = await filler(fakeFetch({ error: "rate limited" }, { status: 429, headers: { "Retry-After": "3" } }).fetch).fillDetailed(request);
    expect(http.suggestion).toBeNull();
    expect(http.status).toBe(429);
    expect(http.error).toBe("http 429: rate limited");
    expect(http.retryAfterMs).toBe(3000);
    expect(http.requestHash).toBe(await requestHash(request));

    const garbage = await filler(fakeFetch("<html>oops</html>").fetch).fillDetailed(request);
    expect(garbage.error).toBe("http 200: body is not JSON");

    const net = filler((() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch);
    const r = await net.fillDetailed(request);
    expect(r.error).toBe("network: Failed to fetch");
    const sync = filler((() => {
      throw new Error("boom");
    }) as unknown as typeof fetch);
    await expect(sync.fill(request)).resolves.toBeNull();
  });

  it("never puts the token in an error or result", async () => {
    const r = await filler(fakeFetch({ error: "bad token" }, { status: 401 }).fetch).fillDetailed(request);
    expect(JSON.stringify(r)).not.toContain("tok-secret");
  });

  it("times out after config.callTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = fakeFetch(response(), { delayMs: 5000 });
      const p = filler(fetch, { callTimeoutMs: 900 }).fillDetailed(request);
      await vi.advanceTimersByTimeAsync(901);
      const r = await p;
      expect(r.timedOut).toBe(true);
      expect(r.aborted).toBe(false);
      expect(r.suggestion).toBeNull();
      expect(r.error).toBe("timeout after 900 ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours the caller's abort signal", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = fakeFetch(response(), { delayMs: 500 });
      const ctrl = new AbortController();
      const p = filler(fetch).fillDetailed(request, ctrl.signal);
      await vi.advanceTimersByTimeAsync(100);
      ctrl.abort();
      const r = await p;
      expect(r.aborted).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.suggestion).toBeNull();
      const pre = new AbortController();
      pre.abort();
      const r2 = await filler(fetch).fillDetailed(request, pre.signal);
      expect(r2.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses exp(logprob) as confidence when configured, falling back to stated", async () => {
    const lp = await filler(fakeFetch(response({ logprob: -0.2 })).fetch, { confidenceSource: "logprob" }).fillDetailed(request);
    expect(lp.confidenceSource).toBe("logprob");
    expect(lp.suggestion!.confidence).toBeCloseTo(Math.exp(-0.2), 10);
    expect(lp.statedConfidence).toBe(0.8);
    const none = await filler(fakeFetch(response()).fetch, { confidenceSource: "logprob" }).fillDetailed(request);
    expect(none.confidenceSource).toBe("stated");
    expect(none.confidenceFallback).toBe(true);
    expect(none.suggestion!.confidence).toBe(0.8);
  });

  it("asks for two samples and uses their agreement for twoSample", async () => {
    const other: ModelAnswer = { ...answer, adds: [answer.adds[0], { x: 6, y: 1, tile: "grass" }] };
    const { fetch, calls } = fakeFetch(response({ answers: [answer, other] }));
    const r = await filler(fetch, { confidenceSource: "twoSample" }).fillDetailed(request);
    expect(JSON.parse(String(calls[0].init.body)).samples).toBe(2);
    // answer: a(4,1) a(5,1) e(5,0); other: a(4,1) a(6,1) e(5,0) -> shared 2, union 4.
    expect(r.agreement).toBe(0.5);
    expect(r.suggestion!.confidence).toBe(0.5);
    expect(r.confidenceSource).toBe("twoSample");
    expect(r.answers).toHaveLength(2);
  });

  it("varietyTwoSample keeps the extend least like the history", async () => {
    const a1: ModelAnswer = { ...answer, kind: "extend", label: "flat floor run again" };
    const a2: ModelAnswer = { ...answer, kind: "extend", label: "pillar hop", adds: [{ x: 6, y: 1, tile: "block" }] };
    const { fetch, calls } = fakeFetch(response({ answer: a1, answers: [a1, a2] }));
    const r = await filler(fetch, {}, { varietyTwoSample: true }).fillDetailed(request);
    expect(JSON.parse(String(calls[0].init.body)).samples).toBe(2);
    expect(r.answer?.label).toBe("pillar hop");
    expect(r.suggestion?.adds).toEqual([{ x: 46, y: 11, tile: 1 }]);
  });

  it("calls onResult and keeps lastResult", async () => {
    const seen: FillResult[] = [];
    const f = filler(fakeFetch(response()).fetch, {}, { onResult: (r) => seen.push(r) });
    await f.fill(request);
    expect(seen).toHaveLength(1);
    expect(f.lastResult).toBe(seen[0]);
  });
});

describe("confidence helpers", () => {
  it("sampleAgreement = shared / union over typed cells", () => {
    expect(sampleAgreement(answer, answer)).toBe(1);
    expect(sampleAgreement(answer, { ...answer, adds: [], entities: [{ kind: "coin", x: 0, y: 0 }] })).toBe(0);
    // Same cell, different tile: not shared.
    expect(sampleAgreement(answer, { ...answer, adds: answer.adds.map((a) => ({ ...a, tile: "dirt" as const })) })).toBeCloseTo(1 / 5, 10);
    expect(sampleAgreement(answer, null)).toBe(0);
    expect(sampleAgreement(answer, { ...answer, act: false })).toBe(0);
    expect(sampleAgreement({ ...answer, adds: [], entities: [] }, { ...answer, adds: [], entities: [] })).toBe(0);
    expect(answerCells({ ...answer, kind: "fix", removes: [{ x: 1, y: 1 }] }).has("r:1,1")).toBe(true);
  });

  it("logprobConfidence maps mean log-probability into [0, 1]", () => {
    expect(logprobConfidence(0)).toBe(1);
    expect(logprobConfidence(Math.log(0.5))).toBeCloseTo(0.5, 10);
    expect(logprobConfidence(3)).toBe(1);
    expect(logprobConfidence(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(logprobConfidence(Number.NaN)).toBe(0);
  });

  it("pickForVariety ignores non-extend answers", () => {
    const fin = { ...answer, label: "something new" };
    const ext = { ...answer, kind: "extend" as const, label: "flat floor run" };
    expect(pickForVariety([ext, fin], request.lastGhosts)).toBe(0);
    expect(pickForVariety([null, ext], request.lastGhosts)).toBe(1);
    expect(pickForVariety([null, null], [])).toBe(0);
  });
});

describe("fillCallEvent", () => {
  it("summarises a result as a fill.call log event", async () => {
    const r = await filler(fakeFetch(response()).fetch).fillDetailed(request);
    const e = fillCallEvent(r, request, 1234);
    expect(e).toEqual({
      type: "fill.call",
      t: 1234,
      requestHash: "abc123",
      mode: "auto",
      superseded: false,
      latencyMs: r.latencyMs,
      act: true,
      kind: "finish",
      confidence: 0.8,
      tiles: 3,
    });
    const err = await filler(fakeFetch({ error: "nope" }, { status: 403 }).fetch).fillDetailed(request);
    expect(fillCallEvent(err, request, 1).act).toBeNull();
    expect(fillCallEvent(err, request, 1).error).toBe("http 403: nope");
  });
});

describe("FillScheduler", () => {
  it("runs speculative calls side by side: a newer request does not abort the older", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = fakeFetch(response(), { delayMs: 300 });
      const results: FillResult[] = [];
      const sched = new FillScheduler(filler(fetch), { maxInFlight: 3, onResult: (r) => results.push(r) });
      const p1 = sched.schedule(request);
      await vi.advanceTimersByTimeAsync(100);
      expect(sched.inFlight).toBe(true);
      const p2 = sched.schedule({ ...request, mode: "requested" });
      expect(sched.inFlightCount).toBe(2);
      expect((calls[0].init.signal as AbortSignal).aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      const [r1, r2] = await Promise.all([p1, p2]);
      // The older answer arrived and is kept: the caller reconciles it.
      expect(r1.superseded).toBe(false);
      expect(r1.suggestion).not.toBeNull();
      expect(r2.superseded).toBe(false);
      expect(r2.suggestion).not.toBeNull();
      expect(sched.inFlight).toBe(false);
      expect(sched.stats).toMatchObject({ scheduled: 2, superseded: 0, completed: 2, suggestions: 2, maxConcurrent: 2 });
      expect(results.map((r) => r.superseded)).toEqual([false, false]);
      expect(fillCallEvent(r1, request, 0).error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("over maxInFlight: only the OLDEST call is aborted, logged superseded with a reason", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = fakeFetch(response(), { delayMs: 500 });
      let limit = 2;
      const sched = new FillScheduler(filler(fetch), { maxInFlight: () => limit });
      const p1 = sched.schedule(request);
      await vi.advanceTimersByTimeAsync(50);
      const p2 = sched.schedule(request);
      await vi.advanceTimersByTimeAsync(50);
      expect(sched.inFlightCount).toBe(2);
      const p3 = sched.schedule(request);
      expect(sched.inFlightCount).toBe(2);
      const r1 = await p1;
      expect((calls[0].init.signal as AbortSignal).aborted).toBe(true);
      expect((calls[1].init.signal as AbortSignal).aborted).toBe(false);
      expect(r1.superseded).toBe(true);
      expect(r1.supersededReason).toBe(OVER_MAX_IN_FLIGHT);
      expect(r1.suggestion).toBeNull();
      const ev = fillCallEvent(r1, request, 0);
      expect(ev.superseded).toBe(true);
      expect(ev.error).toBe("superseded");
      expect(ev.reason).toBe("aborted: over maxInFlight");
      await vi.advanceTimersByTimeAsync(500);
      const [r2, r3] = await Promise.all([p2, p3]);
      expect(r2.superseded).toBe(false);
      expect(r2.suggestion).not.toBeNull();
      expect(r3.superseded).toBe(false);
      expect(sched.stats).toMatchObject({ scheduled: 3, superseded: 1, completed: 2, maxConcurrent: 2 });

      // The limit is read live: lowering it to 1 makes the next call abort the one in flight.
      limit = 1;
      const p4 = sched.schedule(request);
      const p5 = sched.schedule(request);
      expect((await p4).supersededReason).toBe(OVER_MAX_IN_FLIGHT);
      await vi.advanceTimersByTimeAsync(500);
      expect((await p5).superseded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to config.maxInFlight (3)", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = fakeFetch(response(), { delayMs: 500 });
      const sched = new FillScheduler(filler(fetch));
      const ps = [0, 1, 2, 3].map(() => sched.schedule(request));
      expect(sched.inFlightCount).toBe(DEFAULT_CONFIG.maxInFlight);
      await vi.advanceTimersByTimeAsync(500);
      const rs = await Promise.all(ps);
      expect(rs.map((r) => r.superseded)).toEqual([true, false, false, false]);
      expect(calls.map((c) => (c.init.signal as AbortSignal).aborted)).toEqual([true, false, false, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a suggestion that resolves after being aborted", async () => {
    // A filler that ignores the signal and resolves late.
    let release!: () => void;
    const slow = {
      name: "stub" as const,
      fill: () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    };
    const stub = new StubFiller();
    let first = true;
    const mixed = {
      name: "stub" as const,
      fill: (req: FillRequest) => {
        if (first) {
          first = false;
          return stub.fill(req).then(async (s) => {
            await new Promise<void>((r) => setTimeout(r, 20));
            return s;
          });
        }
        return slow.fill();
      },
    };
    const sched = new FillScheduler(mixed, { maxInFlight: 1 });
    const p1 = sched.schedule(request);
    const p2 = sched.schedule(request);
    const r1 = await p1;
    expect(r1.superseded).toBe(true);
    expect(r1.suggestion).toBeNull();
    release();
    const r2 = await p2;
    expect(r2.superseded).toBe(false);
  });

  it("adapts plain fillers and their abort errors; cancel() aborts every call in flight", async () => {
    const sched = new FillScheduler(new StubFiller({ delayMs: 50 }), { maxInFlight: 1 });
    const p1 = sched.schedule(request);
    const p2 = sched.schedule(request);
    const r1 = await p1;
    expect(r1.aborted).toBe(true);
    expect(r1.superseded).toBe(true);
    const r2 = await p2;
    expect(r2.suggestion?.filler).toBe("stub");
    expect(r2.requestHash).toBe(await requestHash(request));
    sched.cancel(); // nothing in flight: no-op

    const wide = new FillScheduler(new StubFiller({ delayMs: 50 }), { maxInFlight: 3 });
    const p3 = wide.schedule(request);
    const p4 = wide.schedule(request);
    expect(wide.inFlightCount).toBe(2);
    wide.cancel();
    expect(wide.inFlight).toBe(false);
    for (const r of await Promise.all([p3, p4])) {
      expect(r.superseded).toBe(true);
      expect(r.supersededReason).toBe(CANCELLED);
      expect(fillCallEvent(r, request, 0)).toMatchObject({ error: "superseded", reason: "cancelled" });
    }
  });
});
