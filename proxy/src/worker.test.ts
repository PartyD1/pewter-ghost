import { describe, expect, it, vi } from "vitest";
import type { ProxyFillResponse } from "../../apps/editor/src/contracts";
import { GOOD_ANSWER, fakeParse, fakeRender, sampleRequest } from "./__fixtures__/fakes";
import type { KVNamespaceLike } from "./store";

// The real renderer is owned by fill/prompt.ts; the worker is tested with fakes.
vi.mock("@app/fill/prompt", () => ({ renderFillPrompt: fakeRender, parseModelAnswer: fakeParse, PROMPT_VERSION: "fill.test.1" }));

function fakeKV(): KVNamespaceLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => void map.set(k, v),
    list: async ({ prefix = "" }) => ({ keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

describe("worker entry", () => {
  it("serves /fill through KV tokens, Gemini (mocked fetch) and KV recordings via waitUntil", async () => {
    const { default: worker } = await import("./worker");
    const kv = fakeKV();
    kv.map.set("tokens/kvtok_123", JSON.stringify({ condition: "llm", sessionId: "w01" }));
    const realFetch = globalThis.fetch;
    const upstreamCalls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      upstreamCalls.push(String(url));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD_ANSWER) }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const env = { VITE_LLM_API_KEY: "k-test", PEWTER_KV: kv, ALLOWED_ORIGINS: "https://lab.github.io" };
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
      const res = await worker.fetch(
        new Request("https://proxy.example/fill", {
          method: "POST",
          headers: { Authorization: "Bearer kvtok_123", Origin: "https://lab.github.io" },
          body: JSON.stringify({ sessionId: "w01", request: sampleRequest() }),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://lab.github.io");
      expect(((await res.json()) as ProxyFillResponse).answer).toEqual(GOOD_ANSWER);
      expect(upstreamCalls[0]).toContain("/models/gemini-3.7-flash:generateContent");
      await Promise.all(waits);
      const chunks = [...kv.map.keys()].filter((k) => k.startsWith("recordings/w01.jsonl/"));
      expect(chunks).toHaveLength(1);

      const s = await worker.fetch(new Request("https://proxy.example/session?token=nope"), env, ctx);
      expect(s.status).toBe(401);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("PROXY_TOKENS env and missing key: /session works, /fill reports a config error", async () => {
    const { buildWorkerHandler } = await import("./worker");
    const h = buildWorkerHandler({ PROXY_TOKENS: JSON.stringify({ tokens: { envtok_1: { condition: "none", sessionId: "e1" } } }) });
    const s = await h(new Request("https://p/session?token=envtok_1"));
    expect(await s.json()).toEqual({ sessionId: "e1", condition: "none", overrides: {} });
    const h2 = buildWorkerHandler({ PROXY_OPEN: "1" });
    const f = await h2(
      new Request("https://p/fill", { method: "POST", headers: { Authorization: "Bearer dev" }, body: JSON.stringify({ sessionId: "dev.1", request: sampleRequest() }) }),
    );
    const body = (await f.json()) as ProxyFillResponse;
    expect(body.answer).toBeNull();
    expect(body.error).toMatch(/key/);
  });
});
