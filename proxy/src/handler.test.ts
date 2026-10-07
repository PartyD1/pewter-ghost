import { describe, expect, it, vi } from "vitest";
import type { LogEvent, ProxyFillResponse, ProxySessionResponse, Recording } from "../../apps/editor/src/contracts";
import { canonicalJson, sha256Hex } from "../../apps/editor/src/research/hash";
import { createHandler, fillRequestProblem, originAllowList, type HandlerDeps } from "./handler";
import { StaticTokenStore, type TokenFile } from "./sessions";
import { MemoryStore, logKey, recordingKey, rejectedLogKey } from "./store";
import { FakeUpstream, GOOD_ANSWER, fakeParse, fakeRender, sampleRequest, timeoutUpstream } from "./__fixtures__/fakes";

const TOKENS: TokenFile = {
  tokens: {
    tok_llm_abc: { condition: "llm", sessionId: "p01", overrides: { showNowAbove: 0.9 } },
    tok_algo_abc: { condition: "algo", sessionId: "p02" },
    tok_none_abc: { condition: "none", sessionId: "p03" },
    tok_old_abc: { condition: "llm", sessionId: "p04", expiresAt: "2020-01-01T00:00:00Z" },
    tok_off_abc: { condition: "llm", sessionId: "p05", disabled: true },
    tok_auto_abc: { condition: "stub" },
  },
};

function setup(over: Partial<HandlerDeps> = {}, open = false) {
  let clock = 1_760_000_000_000;
  const store = new MemoryStore();
  const upstream = (over.upstream as FakeUpstream | undefined) ?? new FakeUpstream();
  const deps: HandlerDeps = {
    render: fakeRender,
    parse: fakeParse,
    upstream,
    store,
    tokens: new StaticTokenStore(TOKENS, open),
    now: () => clock,
    newId: () => "minted1",
    ...over,
  };
  const handler = createHandler(deps);
  return {
    handler,
    store,
    upstream,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const BASE = "http://proxy.test";
function post(path: string, body: unknown, token: string | null = "tok_llm_abc", headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  return new Request(BASE + path, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const fillBody = (over: Record<string, unknown> = {}) => ({ sessionId: "p01", request: sampleRequest(), ...over });

describe("POST /fill", () => {
  it("renders, calls upstream, parses, answers and records (happy path)", async () => {
    const { handler, store, upstream } = setup();
    const res = await handler(post("/fill", fillBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyFillResponse;
    expect(body.answer).toEqual(GOOD_ANSWER);
    expect(body.answers).toBeUndefined();
    expect(body.logprob).toBe(-0.12);
    expect(body.model).toBe("fake-model-1");
    expect(body.promptVersion).toBe("fill.test.1");
    expect(body.error).toBeUndefined();
    const expectedHash = await sha256Hex(canonicalJson(sampleRequest()));
    expect(body.requestHash).toBe(expectedHash);
    expect(body.requestHash).toMatch(/^[0-9a-f]{64}$/);

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].samples).toBe(1);
    expect(upstream.calls[0].temperature).toBe(0.2);
    expect(upstream.calls[0].prompt.system).toBe("SYSTEM");

    const recs = store.lines<Recording>(recordingKey("p01"));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      sessionId: "p01",
      requestHash: expectedHash,
      answer: GOOD_ANSWER,
      model: "fake-model-1",
      promptVersion: "fill.test.1",
      logprob: -0.12,
      samples: 1,
      temperature: 0.2,
    });
    expect(recs[0].request).toEqual(sampleRequest());
    expect(new Date(recs[0].t).toISOString()).toBe(recs[0].t);
    expect(recs[0].raw).toBeUndefined();
  });

  it("hash is independent of key order", async () => {
    const { handler } = setup();
    const r = sampleRequest();
    const reordered = Object.fromEntries(Object.entries(r).reverse());
    const a = (await (await handler(post("/fill", fillBody({ request: r })))).json()) as ProxyFillResponse;
    const b = (await (await handler(post("/fill", fillBody({ request: reordered })))).json()) as ProxyFillResponse;
    expect(a.requestHash).toBe(b.requestHash);
  });

  it("samples = 2 returns both answers and uses the higher default temperature", async () => {
    const upstream = new FakeUpstream(() => ({
      texts: [JSON.stringify(GOOD_ANSWER), "not json at all"],
      model: "fake-model-1",
    }));
    const { handler, store } = setup({ upstream });
    const body = (await (await handler(post("/fill", fillBody({ samples: 2 })))).json()) as ProxyFillResponse;
    expect(body.answer).toEqual(GOOD_ANSWER);
    expect(body.answers).toEqual([GOOD_ANSWER, null]);
    expect(upstream.calls[0]).toMatchObject({ samples: 2, temperature: 0.7 });
    const rec = store.lines<Recording>(recordingKey("p01"))[0];
    expect(rec.answers).toEqual([GOOD_ANSWER, null]);
    expect(rec.raw).toEqual([JSON.stringify(GOOD_ANSWER), "not json at all"]);
  });

  it("explicit temperature is clamped to [0, 2]", async () => {
    const { handler, upstream } = setup();
    await handler(post("/fill", fillBody({ temperature: 9 })));
    expect(upstream.calls[0].temperature).toBe(2);
  });

  it.each([
    ["non-JSON text", "garbage {"],
    ["JSON that fails the schema", JSON.stringify({ hello: "world" })],
    ["empty output", null],
  ])("schema garbage (%s) -> answer null, still 200 and recorded", async (_name, text) => {
    const upstream = new FakeUpstream(() => ({ texts: [text], model: "fake-model-1" }));
    const { handler, store } = setup({ upstream });
    const res = await handler(post("/fill", fillBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyFillResponse;
    expect(body.answer).toBeNull();
    expect(body.error).toBeUndefined();
    const rec = store.lines<Recording>(recordingKey("p01"))[0];
    expect(rec.answer).toBeNull();
    if (text !== null) expect(rec.raw).toEqual([text]);
  });

  it("accepts answers wrapped in a ``` json fence", async () => {
    const upstream = new FakeUpstream(() => ({ texts: ["```json\n" + JSON.stringify(GOOD_ANSWER) + "\n```"], model: "m" }));
    const { handler } = setup({ upstream });
    const body = (await (await handler(post("/fill", fillBody()))).json()) as ProxyFillResponse;
    expect(body.answer).toEqual(GOOD_ANSWER);
  });

  it("a parser that throws is treated as garbage", async () => {
    const { handler } = setup({
      parse: () => {
        throw new Error("boom");
      },
    });
    const body = (await (await handler(post("/fill", fillBody()))).json()) as ProxyFillResponse;
    expect(body.answer).toBeNull();
  });

  it("upstream timeout -> 200 with answer null and error, recorded with the error", async () => {
    const { handler, store } = setup({ upstream: timeoutUpstream() });
    const res = await handler(post("/fill", fillBody()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyFillResponse;
    expect(body.answer).toBeNull();
    expect(body.error).toBe("upstream timeout");
    expect(body.requestHash).toMatch(/^[0-9a-f]{64}$/);
    const rec = store.lines<Recording>(recordingKey("p01"))[0];
    expect(rec.error).toBe("upstream timeout");
    expect(rec.answer).toBeNull();
  });

  it("measures latency with the injected clock", async () => {
    let t = 0;
    const upstream = new FakeUpstream(() => {
      t += 420;
      return { texts: [JSON.stringify(GOOD_ANSWER)], model: "m" };
    });
    const { handler } = setup({ upstream, now: () => 1_000_000 + t });
    const body = (await (await handler(post("/fill", fillBody()))).json()) as ProxyFillResponse;
    expect(body.latencyMs).toBe(420);
  });

  it("a non-UpstreamError failure is reported, not thrown", async () => {
    const onError = vi.fn();
    const upstream = new FakeUpstream(() => {
      throw new Error("socket hang up");
    });
    const { handler } = setup({ upstream, onError });
    const body = (await (await handler(post("/fill", fillBody()))).json()) as ProxyFillResponse;
    expect(body.error).toContain("socket hang up");
    expect(onError).toHaveBeenCalled();
  });

  it("refuses without a token, with a bad token, an expired or a revoked one", async () => {
    const { handler, upstream } = setup();
    for (const token of [null, "nope_nope", "tok_old_abc", "tok_off_abc"]) {
      const res = await handler(post("/fill", fillBody(), token));
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    // ?token= is not enough for /fill
    const q = new Request(`${BASE}/fill?token=tok_llm_abc`, { method: "POST", body: JSON.stringify(fillBody()) });
    expect((await handler(q)).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it("dev token works only in open mode", async () => {
    const closed = setup();
    expect((await closed.handler(post("/fill", fillBody({ sessionId: "dev.x1" }), "dev"))).status).toBe(401);
    const open = setup({}, true);
    expect((await open.handler(post("/fill", fillBody({ sessionId: "dev.x1" }), "dev"))).status).toBe(200);
  });

  it("refuses fill for non-llm conditions and foreign session ids", async () => {
    const { handler, upstream } = setup();
    expect((await handler(post("/fill", fillBody({ sessionId: "p02" }), "tok_algo_abc"))).status).toBe(403);
    expect((await handler(post("/fill", fillBody({ sessionId: "p03" }), "tok_none_abc"))).status).toBe(403);
    expect((await handler(post("/fill", fillBody({ sessionId: "p02" })))).status).toBe(403);
    expect((await handler(post("/fill", fillBody({ sessionId: "p01x" })))).status).toBe(403);
    expect((await handler(post("/fill", fillBody({ sessionId: "p01.run2" })))).status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
  });

  it("validates the body", async () => {
    const { handler } = setup();
    expect((await handler(post("/fill", "{not json"))).status).toBe(400);
    expect((await handler(post("/fill", fillBody({ sessionId: "../etc" })))).status).toBe(400);
    expect((await handler(post("/fill", fillBody({ request: { grid: "" } })))).status).toBe(400);
    expect((await handler(post("/fill", fillBody({ samples: 3 })))).status).toBe(400);
    expect((await handler(post("/fill", fillBody({ temperature: "hot" })))).status).toBe(400);
    const big = post("/fill", fillBody({ request: sampleRequest({ brief: "x".repeat(300 * 1024) }) }));
    expect((await handler(big)).status).toBe(413);
  });

  it("a renderer that throws yields 400 and no upstream call", async () => {
    const { handler, upstream } = setup({
      render: () => {
        throw new Error("window too large");
      },
    });
    const res = await handler(post("/fill", fillBody()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("window too large");
    expect(upstream.calls).toHaveLength(0);
  });

  it("rate-limits per token with Retry-After, and refills over time", async () => {
    const { handler, advance } = setup({ fillRate: { capacity: 3, perMinute: 60 } });
    for (let i = 0; i < 3; i++) expect((await handler(post("/fill", fillBody()))).status).toBe(200);
    const limited = await handler(post("/fill", fillBody()));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // another token is unaffected
    expect((await handler(post("/fill", fillBody({ sessionId: "t-x" }), "tok_algo_abc"))).status).toBe(403);
    advance(1000);
    expect((await handler(post("/fill", fillBody()))).status).toBe(200);
    expect((await handler(post("/fill", fillBody()))).status).toBe(429);
  });

  it("default limit is 120 fills per minute", async () => {
    const { handler } = setup({ upstream: new FakeUpstream(() => ({ texts: ["{}"], model: "m" })) });
    let ok = 0;
    for (let i = 0; i < 125; i++) if ((await handler(post("/fill", fillBody()))).status === 200) ok++;
    expect(ok).toBe(120);
  });

  it("uses waitUntil for storage when the runtime provides it", async () => {
    const { handler, store } = setup();
    const pending: Promise<unknown>[] = [];
    const res = await handler(post("/fill", fillBody()), { waitUntil: (p) => pending.push(p) });
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(store.lines(recordingKey("p01"))).toHaveLength(1);
  });

  it("a failing store does not fail the response", async () => {
    const onError = vi.fn();
    const store = { append: async () => Promise.reject(new Error("disk full")), read: async () => null };
    const { handler } = setup({ store, onError });
    expect((await handler(post("/fill", fillBody()))).status).toBe(200);
    expect(onError.mock.calls.map((c) => c[0]).join()).toContain("disk full");
  });
});

describe("POST /log", () => {
  const events: LogEvent[] = [
    { type: "session", t: 0, sessionId: "p01", commit: "abc", promptVersion: "p1", briefVersion: "b1", model: "m", filler: "llm", config: {} },
    { type: "place", t: 10, x: 1, y: 2, tile: 6, author: 1, stroke: "s1", tool: "paint" },
  ];

  it("appends valid events to logs/<sessionId>.jsonl", async () => {
    const { handler, store } = setup();
    const res = await handler(post("/log", { sessionId: "p01", events }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2, rejected: [] });
    expect(store.lines(logKey("p01"))).toEqual(events);
    await handler(post("/log", { sessionId: "p01", events: [{ type: "play.start", t: 20 }] }));
    expect(store.lines(logKey("p01"))).toHaveLength(3);
  });

  it("keeps invalid events apart and reports them", async () => {
    const { handler, store } = setup();
    const res = await handler(post("/log", { sessionId: "p01", events: [events[1], { type: "place", t: "soon" }, 42] }));
    const body = (await res.json()) as { accepted: number; rejected: { index: number; error: string }[] };
    expect(body.accepted).toBe(1);
    expect(body.rejected.map((r) => r.index)).toEqual([1, 2]);
    expect(store.lines(logKey("p01"))).toHaveLength(1);
    expect(store.lines(rejectedLogKey("p01"))).toHaveLength(2);
  });

  it("accepts ?token= (sendBeacon) and text/plain bodies", async () => {
    const { handler, store } = setup();
    const req = new Request(`${BASE}/log?token=tok_llm_abc`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ sessionId: "p01", events }),
    });
    expect((await handler(req)).status).toBe(200);
    expect(store.lines(logKey("p01"))).toHaveLength(2);
  });

  it("refuses without token, for foreign sessions, and for bad bodies", async () => {
    const { handler } = setup();
    expect((await handler(post("/log", { sessionId: "p01", events }, null))).status).toBe(401);
    expect((await handler(post("/log", { sessionId: "p02", events }))).status).toBe(403);
    expect((await handler(post("/log", { sessionId: "p01", events: "nope" }))).status).toBe(400);
    expect((await handler(post("/log", { sessionId: "p01", events: Array(10_001).fill(events[1]) }))).status).toBe(413);
  });

  it("log route works for every condition (all sessions are logged)", async () => {
    const { handler } = setup();
    expect((await handler(post("/log", { sessionId: "p03", events }, "tok_none_abc"))).status).toBe(200);
  });
});

describe("GET /session", () => {
  it("returns condition and overrides for a token in the query", async () => {
    const { handler } = setup();
    const res = await handler(new Request(`${BASE}/session?token=tok_llm_abc`));
    expect(res.status).toBe(200);
    expect((await res.json()) as ProxySessionResponse).toEqual({
      sessionId: "p01",
      condition: "llm",
      overrides: { showNowAbove: 0.9 },
    });
  });

  it("accepts a bearer token and derives a session id when none is configured", async () => {
    const { handler } = setup();
    const res = await handler(new Request(`${BASE}/session`, { headers: { Authorization: "Bearer tok_auto_abc" } }));
    const body = (await res.json()) as ProxySessionResponse;
    expect(body.condition).toBe("stub");
    expect(body.sessionId).toBe(`t-${(await sha256Hex("tok_auto_abc")).slice(0, 12)}`);
  });

  it("each condition comes through", async () => {
    const { handler } = setup();
    for (const [tok, cond] of [
      ["tok_llm_abc", "llm"],
      ["tok_algo_abc", "algo"],
      ["tok_none_abc", "none"],
      ["tok_auto_abc", "stub"],
    ]) {
      const body = (await (await handler(new Request(`${BASE}/session?token=${tok}`))).json()) as ProxySessionResponse;
      expect(body.condition).toBe(cond);
    }
  });

  it("refuses unknown tokens; dev token mints fresh ids in open mode", async () => {
    expect((await setup().handler(new Request(`${BASE}/session?token=dev`))).status).toBe(401);
    expect((await setup().handler(new Request(`${BASE}/session`))).status).toBe(401);
    const { handler } = setup({}, true);
    const body = (await (await handler(new Request(`${BASE}/session?token=dev`))).json()) as ProxySessionResponse;
    expect(body).toEqual({ sessionId: "dev.minted1", condition: "llm", overrides: {} });
  });
});

describe("routing, health and CORS", () => {
  it("GET /health needs no token and does not leak secrets", async () => {
    const { handler } = setup();
    const res = await handler(new Request(`${BASE}/health`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, model: "fake-model-1" });
  });

  it("404 for unknown paths, 405 for wrong methods", async () => {
    const { handler } = setup();
    expect((await handler(new Request(`${BASE}/nope`))).status).toBe(404);
    const r = await handler(new Request(`${BASE}/fill`));
    expect(r.status).toBe(405);
    expect(r.headers.get("Allow")).toContain("POST");
    expect((await handler(post("/health", {}))).status).toBe(405);
  });

  it("answers preflight for localhost origins and tags responses", async () => {
    const { handler } = setup();
    const pre = await handler(
      new Request(`${BASE}/fill`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    const res = await handler(post("/fill", fillBody(), "tok_llm_abc", { Origin: "http://127.0.0.1:4173" }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:4173");
    const err = await handler(post("/fill", fillBody(), null, { Origin: "http://localhost:5173" }));
    expect(err.status).toBe(401);
    expect(err.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("does not grant CORS to other origins", async () => {
    const { handler } = setup();
    const pre = await handler(new Request(`${BASE}/fill`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }));
    expect(pre.status).toBe(403);
    const res = await handler(new Request(`${BASE}/health`, { headers: { Origin: "https://evil.example" } }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("originAllowList adds configured origins to localhost", () => {
    const allow = originAllowList("https://lab.github.io, https://x.org/");
    expect(allow("https://lab.github.io")).toBe(true);
    expect(allow("https://x.org")).toBe(true);
    expect(allow("http://localhost:1")).toBe(true);
    expect(allow("https://other.io")).toBe(false);
    expect(originAllowList("*")("https://any")).toBe(true);
  });
});

describe("fillRequestProblem", () => {
  it("accepts the fixture and names the first problem otherwise", () => {
    expect(fillRequestProblem(sampleRequest())).toBeNull();
    expect(fillRequestProblem(null)).toMatch(/object/);
    expect(fillRequestProblem(sampleRequest({ mode: "wild" as never }))).toMatch(/mode/);
    expect(fillRequestProblem({ ...sampleRequest(), origin: { x: "1" } })).toMatch(/origin/);
    expect(fillRequestProblem({ ...sampleRequest(), size: { w: 0, h: 1 } })).toMatch(/size/);
  });
});
