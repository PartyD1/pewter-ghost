import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RenderedPrompt } from "../../apps/editor/src/contracts";
import { GeminiUpstream } from "../../proxy/src/gemini";
import { CachedCaller, CallCache, callKey, geminiCaller, hasApiKey, mapLimit, UpstreamCaller } from "./live";
import { FakeUpstream, httpError } from "./__fixtures__/fakes";

const prompt: RenderedPrompt = { system: "sys", user: "user", responseSchema: { type: "OBJECT" }, promptVersion: "p1" };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "eval-live-"));

describe("UpstreamCaller", () => {
  it("returns texts, latency and usage", async () => {
    const up = new FakeUpstream("m", () => '{"act":false}', { logprob: -0.2 });
    let t = 0;
    const c = new UpstreamCaller(up, { clock: () => (t += 50) });
    const r = await c.call(prompt, { temperature: 0.2, samples: 2 });
    expect(r.texts).toEqual(['{"act":false}', '{"act":false}']);
    expect(r).toMatchObject({ latencyMs: 50, model: "m", promptVersion: "p1", logprob: -0.2, usage: { promptTokens: 1000 } });
  });

  it("retries 429 and 5xx with backoff, not 400", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const up = new FakeUpstream("m", () => (n++ < 2 ? httpError(429) : "ok"));
    const c = new UpstreamCaller(up, { retry: { retries: 3, baseDelayMs: 10, sleep: async (ms) => void sleeps.push(ms) } });
    expect((await c.call(prompt, { temperature: 0, samples: 1 })).texts).toEqual(["ok"]);
    expect(sleeps).toEqual([10, 20]);
    const bad = new UpstreamCaller(new FakeUpstream("m", () => httpError(400)), { retry: { sleep: async () => undefined } });
    const r = await bad.call(prompt, { temperature: 0, samples: 1 });
    expect(r.texts).toEqual([]);
    expect(r.error).toMatch(/400/);
  });
});

describe("CachedCaller", () => {
  it("serves reruns from disk and keys on prompt and config", async () => {
    const up = new FakeUpstream("m", () => "answer");
    const cache = new CallCache(tmp());
    const c = new CachedCaller(new UpstreamCaller(up), cache);
    const o = { temperature: 0.2, samples: 1 as const };
    const a = await c.call(prompt, o);
    const b = await c.call(prompt, o);
    expect(up.calls).toHaveLength(1);
    expect(a.cached).toBeUndefined();
    expect(b).toMatchObject({ texts: ["answer"], cached: true });
    await c.call(prompt, { ...o, temperature: 0.7 });
    await c.call({ ...prompt, user: "other" }, o);
    expect(up.calls).toHaveLength(3);
    expect(callKey(prompt, "m", o)).not.toBe(callKey(prompt, "m2", o));
    expect(callKey(prompt, "m", o, { thinkingBudget: 0 })).not.toBe(callKey(prompt, "m", o, { thinkingBudget: null }));
    // refresh ignores the cache
    await new CachedCaller(new UpstreamCaller(up), cache, { refresh: true }).call(prompt, o);
    expect(up.calls).toHaveLength(4);
  });

  it("does not cache failures", async () => {
    let fail = true;
    const up = new FakeUpstream("m", () => (fail ? httpError(400) : "fine"));
    const c = new CachedCaller(new UpstreamCaller(up), new CallCache(tmp()));
    expect((await c.call(prompt, { temperature: 0, samples: 1 })).error).toBeDefined();
    fail = false;
    expect((await c.call(prompt, { temperature: 0, samples: 1 })).texts).toEqual(["fine"]);
  });
});

describe("geminiCaller", () => {
  it("needs a key and never leaks it into results", async () => {
    expect(hasApiKey({})).toBe(false);
    expect(hasApiKey({ VITE_LLM_API_KEY: "x" })).toBe(true);
    expect(() => geminiCaller({ model: "m", thinkingBudget: 0 }, {})).toThrow(/VITE_LLM_API_KEY/);
    const key = "AIzaSyFAKE-not-a-real-key-123456789";
    const fetch = (async () => new Response(JSON.stringify({ error: { message: `bad key ${key}` } }), { status: 403 })) as typeof globalThis.fetch;
    const c = geminiCaller({ model: "gemini-test", thinkingBudget: 0, fetch, retry: { retries: 0 } }, { VITE_LLM_API_KEY: key });
    const r = await c.call(prompt, { temperature: 0, samples: 1 });
    expect(r.error).toMatch(/403/);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(c.settings).toEqual({ thinkingBudget: 0 });
    expect(new GeminiUpstream({ apiKey: key, model: "gemini-test" }).url).not.toContain(key);
  });
});

describe("mapLimit", () => {
  it("keeps order and the concurrency bound", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (x) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, x));
      live--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});
