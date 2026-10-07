import { describe, expect, it, vi } from "vitest";
import { fetchSession, readTokenFromUrl, sanitizeOverrides } from "./session";

function jsonFetch(status: number, body: unknown) {
  const calls: string[] = [];
  const f = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("readTokenFromUrl", () => {
  it("reads ?token= and #token=", () => {
    expect(readTokenFromUrl("http://x/editor/?a=1&token=abc123")).toBe("abc123");
    expect(readTokenFromUrl("http://x/#token=hash_tok")).toBe("hash_tok");
    expect(readTokenFromUrl("http://x/?token=")).toBeNull();
    expect(readTokenFromUrl("http://x/")).toBeNull();
    expect(readTokenFromUrl("?token=rel")).toBe("rel");
  });
  it("returns null without a location", () => {
    expect(readTokenFromUrl()).toBeNull();
  });
});

describe("sanitizeOverrides", () => {
  it("keeps known keys with the right types and drops the rest", () => {
    expect(
      sanitizeOverrides({
        showNowAbove: 0.9,
        pauseMs: "fast",
        proxyUrl: "http://evil",
        nonsense: 1,
        filler: "algo",
        kinds: { fix: false, bogus: true, finish: "yes" },
        confidenceSource: "vibes",
      }),
    ).toEqual({ showNowAbove: 0.9, filler: "algo", kinds: { finish: true, extend: true, fix: false } });
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([1])).toEqual({});
    expect(sanitizeOverrides({ filler: "gpt" })).toEqual({});
  });
});

describe("fetchSession", () => {
  it("returns the proxy's condition as filler override", async () => {
    const { f, calls } = jsonFetch(200, { sessionId: "p01", condition: "algo", overrides: { pauseMs: 1000, filler: "llm" } });
    const s = await fetchSession({ proxyUrl: "http://proxy/", token: "tok 1", fetch: f });
    expect(calls[0]).toBe("http://proxy/session?token=tok%201");
    expect(s).toEqual({
      sessionId: "p01",
      condition: "algo",
      overrides: { pauseMs: 1000, filler: "algo" },
      token: "tok 1",
      fromProxy: true,
    });
  });

  it.each(["llm", "algo", "none", "stub"] as const)("condition %s comes through", async (c) => {
    const { f } = jsonFetch(200, { sessionId: "s", condition: c, overrides: {} });
    const s = await fetchSession({ token: "t", fetch: f });
    expect(s.condition).toBe(c);
    expect(s.overrides.filler).toBe(c);
  });

  it("falls back locally without a token, on HTTP errors, bad bodies and network errors", async () => {
    const none = await fetchSession({ token: null });
    expect(none).toMatchObject({ fromProxy: false, error: "no token", condition: "llm" });
    expect(none.sessionId).toMatch(/^local-/);
    expect(await fetchSession({ token: "t", fetch: jsonFetch(401, { error: "x" }).f })).toMatchObject({ fromProxy: false, error: "HTTP 401" });
    expect(await fetchSession({ token: "t", fetch: jsonFetch(200, { condition: "weird" }).f })).toMatchObject({ error: "bad session response" });
    const boom = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchSession({ token: "t", fetch: boom, fallbackCondition: "none" })).toMatchObject({
      fromProxy: false,
      condition: "none",
      overrides: { filler: "none" },
    });
  });

  it("times out", async () => {
    vi.useFakeTimers();
    try {
      const hang = ((_u: unknown, init?: RequestInit) =>
        new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))))) as unknown as typeof fetch;
      const p = fetchSession({ token: "t", fetch: hang, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toMatchObject({ fromProxy: false, error: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
