import { describe, expect, it, vi } from "vitest";
import { buildGeminiBody, extractLogprob, extractText, geminiFromEnv, GeminiUpstream } from "./gemini";
import { UpstreamError } from "./upstream";
import { GOOD_ANSWER, fakeRender, sampleRequest } from "./__fixtures__/fakes";

const KEY = "AIzaTEST-not-a-real-key-123";
const prompt = fakeRender(sampleRequest());

function okResponse(text: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }],
      usageMetadata: { promptTokenCount: 1100, candidatesTokenCount: 80 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
function errResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { code: status, message, status: "INVALID_ARGUMENT" } }), { status });
}

type Call = { url: string; init: RequestInit; body: Record<string, any> };
function mockFetch(responder: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init!, body: JSON.parse(String(init!.body)) };
    calls.push(call);
    return responder(call, calls.length);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("buildGeminiBody", () => {
  it("has systemInstruction, contents and JSON-mode generationConfig", () => {
    const body = buildGeminiBody(prompt, { temperature: 0.3, logprobs: true, thinkingBudget: 0, maxOutputTokens: 400 });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "SYSTEM" }] },
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: prompt.responseSchema,
        temperature: 0.3,
        candidateCount: 1,
        maxOutputTokens: 400,
        responseLogprobs: true,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  });
  it("omits optional fields when off", () => {
    const g = buildGeminiBody(prompt, { temperature: 0, logprobs: false }).generationConfig as Record<string, unknown>;
    expect(g.responseLogprobs).toBeUndefined();
    expect(g.thinkingConfig).toBeUndefined();
    expect(g.maxOutputTokens).toBeUndefined();
  });
});

describe("GeminiUpstream", () => {
  it("posts to the pinned model URL with the key only in x-goog-api-key", async () => {
    const m = mockFetch(() => okResponse(JSON.stringify(GOOD_ANSWER), { avgLogprobs: -0.25 }));
    const up = new GeminiUpstream({ apiKey: KEY, model: "gemini-3.7-flash", fetch: m.fetch });
    const r = await up.generate({ prompt, temperature: 0.2, samples: 1 });
    expect(m.calls).toHaveLength(1);
    const c = m.calls[0];
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
    expect(c.url).not.toContain(KEY);
    expect(c.init.method).toBe("POST");
    const headers = c.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.stringify(c.body)).not.toContain(KEY);
    expect(c.body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseSchema: prompt.responseSchema,
      temperature: 0.2,
      responseLogprobs: true,
    });
    expect(c.body.systemInstruction.parts[0].text).toBe("SYSTEM");
    expect(c.body.contents[0].parts[0].text).toBe(prompt.user);
    expect(r).toMatchObject({ texts: [JSON.stringify(GOOD_ANSWER)], logprob: -0.25, model: "gemini-3.7-flash" });
    expect(r.usage).toEqual({ promptTokens: 1100, outputTokens: 80 });
  });

  it("samples = 2 makes two calls and returns both texts", async () => {
    const m = mockFetch((_c, n) => okResponse(`{"n":${n}}`));
    const up = new GeminiUpstream({ apiKey: KEY, fetch: m.fetch });
    const r = await up.generate({ prompt, temperature: 0.7, samples: 2 });
    expect(m.calls).toHaveLength(2);
    expect(m.calls.every((c) => c.body.generationConfig.temperature === 0.7)).toBe(true);
    expect(r.texts.sort()).toEqual(['{"n":1}', '{"n":2}']);
  });

  it("samples = 2 survives one failed sample", async () => {
    const m = mockFetch((_c, n) => (n === 1 ? okResponse("{}") : errResponse(500, "internal")));
    const up = new GeminiUpstream({ apiKey: KEY, fetch: m.fetch, logprobs: false });
    const r = await up.generate({ prompt, temperature: 0.7, samples: 2 });
    expect(r.texts).toEqual(["{}", null]);
    expect(r.sampleErrors?.[1]).toContain("500");
  });

  it("drops responseLogprobs for good when the API rejects it", async () => {
    const m = mockFetch((c) =>
      c.body.generationConfig.responseLogprobs ? errResponse(400, "responseLogprobs is not supported for this model") : okResponse("{}"),
    );
    const up = new GeminiUpstream({ apiKey: KEY, fetch: m.fetch });
    const r1 = await up.generate({ prompt, temperature: 0.2, samples: 1 });
    expect(r1.texts).toEqual(["{}"]);
    expect(r1.logprob).toBeUndefined();
    expect(up.logprobsEnabled).toBe(false);
    await up.generate({ prompt, temperature: 0.2, samples: 1 });
    expect(m.calls).toHaveLength(3); // rejected, retried, then straight through
    expect(m.calls[2].body.generationConfig.responseLogprobs).toBeUndefined();
  });

  it("drops thinkingConfig when rejected", async () => {
    const m = mockFetch((c) => (c.body.generationConfig.thinkingConfig ? errResponse(400, "Thinking budget is not supported") : okResponse("{}")));
    const up = new GeminiUpstream({ apiKey: KEY, fetch: m.fetch, logprobs: false, thinkingBudget: 0 });
    await up.generate({ prompt, temperature: 0.2, samples: 1 });
    expect(up.thinkingBudget).toBeNull();
  });

  it("an unrelated 400 is retried plain once and surfaces if the plain body fails too", async () => {
    const m = mockFetch(() => errResponse(400, "Invalid value at 'generation_config.response_schema'"));
    const up = new GeminiUpstream({ apiKey: KEY, fetch: m.fetch });
    await expect(up.generate({ prompt, temperature: 0.2, samples: 1 })).rejects.toMatchObject({ kind: "http", status: 400 });
    expect(m.calls).toHaveLength(2);
    expect(up.logprobsEnabled).toBe(true); // not blamed, not disabled
  });

  it("times out with UpstreamError('timeout')", async () => {
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
    const up = new GeminiUpstream({ apiKey: KEY, fetch: hanging, timeoutMs: 30 });
    const err = await up.generate({ prompt, temperature: 0.2, samples: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.kind).toBe("timeout");
  });

  it("network and HTTP errors never contain the key", async () => {
    const leaky = (async () => {
      throw new Error(`connect failed for key ${KEY}`);
    }) as unknown as typeof fetch;
    const e1 = await new GeminiUpstream({ apiKey: KEY, fetch: leaky }).generate({ prompt, temperature: 0, samples: 1 }).catch((e) => e);
    expect(e1.kind).toBe("network");
    expect(e1.message).not.toContain(KEY);
    const m = mockFetch(() => errResponse(403, `API key ${KEY} not valid`));
    const e2 = await new GeminiUpstream({ apiKey: KEY, fetch: m.fetch }).generate({ prompt, temperature: 0, samples: 1 }).catch((e) => e);
    expect(e2.status).toBe(403);
    expect(e2.message).not.toContain(KEY);
    expect(e2.message).toContain("[redacted]");
  });

  it("non-JSON error bodies become bad-response", async () => {
    const m = mockFetch(() => new Response("<html>502</html>", { status: 502 }));
    const err = await new GeminiUpstream({ apiKey: KEY, fetch: m.fetch }).generate({ prompt, temperature: 0, samples: 1 }).catch((e) => e);
    expect(err.kind).toBe("bad-response");
  });

  it("refuses to construct without a key or with a strange model id", () => {
    expect(() => new GeminiUpstream({ apiKey: "" })).toThrow(UpstreamError);
    expect(() => new GeminiUpstream({ apiKey: KEY, model: "../x?y" })).toThrow(/model/);
  });
});

describe("extractors", () => {
  it("joins non-thought text parts", () => {
    expect(extractText({ candidates: [{ content: { parts: [{ text: "a", thought: true }, { text: "{" }, { text: "}" }] } }] })).toBe("{}");
    expect(extractText({ candidates: [] })).toBeNull();
    expect(extractText({ promptFeedback: { blockReason: "SAFETY" } })).toBeNull();
  });
  it("prefers avgLogprobs, else averages chosen candidates", () => {
    expect(extractLogprob({ candidates: [{ avgLogprobs: -0.5 }] })).toBe(-0.5);
    expect(
      extractLogprob({ candidates: [{ logprobsResult: { chosenCandidates: [{ logProbability: -1 }, { logProbability: -3 }] } }] }),
    ).toBe(-2);
    expect(extractLogprob({ candidates: [{}] })).toBeUndefined();
  });
});

describe("geminiFromEnv", () => {
  it("reads key and model, with defaults", () => {
    const a = geminiFromEnv({ VITE_LLM_API_KEY: KEY });
    expect(a.model).toBe("gemini-3.7-flash");
    const b = geminiFromEnv({ GEMINI_API_KEY: KEY, VITE_LLM_MODEL_NAME: "gemini-x", PROXY_THINKING_BUDGET: "0", PROXY_LOGPROBS: "0" });
    expect(b.model).toBe("gemini-x");
    expect(b.thinkingBudget).toBe(0);
    expect(b.logprobsEnabled).toBe(false);
    expect(() => geminiFromEnv({})).toThrow(/key/);
  });
});
