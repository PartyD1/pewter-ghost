import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEvent, ProxyLogBody } from "../contracts";
import { EventLog, getActiveLog, logEvent, setActiveLog } from "./log";

const ev = (t: number): LogEvent => ({ type: "place", t, x: t, y: 1, tile: 6, author: 1, stroke: "s", tool: "paint" });

function fakeFetch(status = 200) {
  const bodies: ProxyLogBody[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  let mode: "ok" | "fail" | "throw" = "ok";
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    if (mode === "throw") throw new TypeError("Failed to fetch");
    if (mode === "fail") return new Response("{}", { status: 503 });
    bodies.push(JSON.parse(String(init!.body)));
    return new Response('{"ok":true}', { status });
  });
  return {
    fetch: fn as unknown as typeof fetch,
    bodies,
    calls,
    setMode: (m: typeof mode) => {
      mode = m;
    },
  };
}

describe("EventLog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setActiveLog(null);
  });

  it("batches to POST /log every 5 s with bearer token", async () => {
    const f = fakeFetch();
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://proxy.test/", token: "tok", fetch: f.fetch });
    log.log(ev(1));
    log.log(ev(2));
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("http://proxy.test/log");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(f.bodies[0]).toEqual({ sessionId: "p01", events: [ev(1), ev(2)] });
    expect(log.pendingCount()).toBe(0);

    // nothing pending -> no request on the next tick
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls).toHaveLength(1);
    log.log(ev(3));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.bodies[1].events).toEqual([ev(3)]);
    log.stop();
  });

  it("flush() sends immediately (e.g. on save) and resolves true", async () => {
    const f = fakeFetch();
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: f.fetch });
    log.log(ev(1));
    await expect(log.flush()).resolves.toBe(true);
    expect(f.bodies).toHaveLength(1);
    await expect(log.flush()).resolves.toBe(true);
    expect(f.bodies).toHaveLength(1);
    log.stop();
  });

  it("keeps events after failures and resends them with the next batch", async () => {
    const f = fakeFetch();
    const errors: string[] = [];
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: f.fetch, onError: (m) => errors.push(m) });
    f.setMode("fail");
    log.log(ev(1));
    await expect(log.flush()).resolves.toBe(false);
    f.setMode("throw");
    log.log(ev(2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(log.pendingCount()).toBe(2);
    expect(errors[0]).toMatch(/503/);
    expect(errors[1]).toMatch(/Failed to fetch/);
    f.setMode("ok");
    log.log(ev(3));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0].events).toEqual([ev(1), ev(2), ev(3)]);
    expect(log.getStats()).toMatchObject({ logged: 3, sent: 3, pending: 0, failedPosts: 2 });
    log.stop();
  });

  it("splits large backlogs into maxBatch-sized requests", async () => {
    const f = fakeFetch();
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: f.fetch, maxBatch: 2, autoStart: false });
    for (let i = 0; i < 5; i++) log.log(ev(i));
    await log.flush();
    expect(f.bodies.map((b) => b.events.length)).toEqual([2, 2, 1]);
  });

  it("concurrent flushes do not double-send", async () => {
    const f = fakeFetch();
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: f.fetch, autoStart: false });
    log.log(ev(1));
    const a = log.flush();
    log.log(ev(2));
    const b = log.flush();
    await Promise.all([a, b]);
    const sent = f.bodies.flatMap((x) => x.events.map((e) => e.t));
    expect(sent).toEqual([1, 2]);
  });

  it("works offline: no proxy/token -> buffer only, no fetch", async () => {
    const f = fakeFetch();
    const log = new EventLog({ sessionId: "local-1", fetch: f.fetch });
    log.log(ev(1));
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(log.flush()).resolves.toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(log.pendingCount()).toBe(1);
    // connecting later delivers the backlog
    log.connect("http://p", "tok");
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.bodies[0].events).toEqual([ev(1)]);
    log.stop();
  });

  it("navigator.onLine === false holds the batch", async () => {
    const f = fakeFetch();
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: f.fetch, autoStart: false });
      log.log(ev(1));
      expect(log.online).toBe(false);
      expect(await log.flush()).toBe(false);
      expect(f.calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("download() returns all events (sent or not) as JSONL", async () => {
    const f = fakeFetch();
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: f.fetch, autoStart: false });
    log.log(ev(1));
    await log.flush();
    log.log(ev(2));
    const blob = log.download();
    expect(blob.type).toBe("application/x-ndjson");
    const text = await blob.text();
    expect(text.trim().split("\n").map((l) => JSON.parse(l))).toEqual([ev(1), ev(2)]);
  });

  it("never throws into callers, even for invalid or unserialisable events", () => {
    const invalid: unknown[] = [];
    const log = new EventLog({ sessionId: "p01", autoStart: false, onInvalid: (e) => invalid.push(e) });
    expect(() => log.log({ type: "nonsense" } as unknown as LogEvent)).not.toThrow();
    expect(() => log.log(null as unknown as LogEvent)).not.toThrow();
    const cyclic: Record<string, unknown> = { type: "play.start", t: 1 };
    cyclic.self = cyclic;
    expect(() => log.log(cyclic as unknown as LogEvent)).not.toThrow();
    expect(() => log.toJsonl()).not.toThrow();
    expect(invalid.length).toBeGreaterThanOrEqual(2);
    expect(log.getStats().invalid).toBeGreaterThanOrEqual(2);
    // a throwing callback is swallowed too
    const log2 = new EventLog({ sessionId: "p", autoStart: false, onInvalid: () => { throw new Error("x"); } });
    expect(() => log2.log({ type: "bad" } as unknown as LogEvent)).not.toThrow();
  });

  it("snapshots events so later caller mutation does not change them", () => {
    const log = new EventLog({ sessionId: "p01", autoStart: false });
    const e = ev(1) as { x: number };
    log.log(e as unknown as LogEvent);
    e.x = 999;
    expect((log.events()[0] as { x: number }).x).toBe(1);
  });

  it("caps the buffer, dropping oldest first", () => {
    const log = new EventLog({ sessionId: "p01", autoStart: false, maxBuffer: 3 });
    for (let i = 0; i < 5; i++) log.log(ev(i));
    expect(log.events().map((e) => e.t)).toEqual([2, 3, 4]);
    expect(log.getStats().dropped).toBe(2);
  });

  it("times out a hanging POST and keeps the events", async () => {
    const hanging = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_r, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    ) as unknown as typeof fetch;
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: hanging, autoStart: false, requestTimeoutMs: 1000 });
    log.log(ev(1));
    const p = log.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(false);
    expect(log.getStats().lastError).toMatch(/timeout/);
    expect(log.pendingCount()).toBe(1);
  });

  it("flushOnUnload uses sendBeacon with ?token=", async () => {
    const sent: { url: string; data: Blob }[] = [];
    vi.stubGlobal("navigator", { onLine: true, sendBeacon: (url: string, data: Blob) => (sent.push({ url, data }), true) });
    try {
      const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "t k", autoStart: false });
      log.log(ev(1));
      expect(log.flushOnUnload()).toBe(true);
      expect(sent[0].url).toBe("http://p/log?token=t%20k");
      expect(JSON.parse(await sent[0].data.text())).toEqual({ sessionId: "p01", events: [ev(1)] });
      expect(log.pendingCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("close() stops the timer and flushes", async () => {
    const f = fakeFetch();
    const log = new EventLog({ sessionId: "p01", proxyUrl: "http://p", token: "tok", fetch: f.fetch });
    log.log(ev(1));
    await expect(log.close()).resolves.toBe(true);
    log.log(ev(2));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.bodies).toHaveLength(1);
  });

  it("active-log helpers route and never throw", () => {
    expect(() => logEvent(ev(1))).not.toThrow();
    const log = new EventLog({ sessionId: "p01", autoStart: false });
    setActiveLog(log);
    expect(getActiveLog()).toBe(log);
    logEvent(ev(2));
    expect(log.events()).toEqual([ev(2)]);
  });
});
