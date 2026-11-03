import { describe, expect, it, vi } from "vitest";
import { buildOpenRouterBody, extractChatLogprob, extractChatText, OpenRouterUpstream, toJsonSchema } from "./openrouter";
import { JEV_LOCAL_BASE_URL, JEV_OPENROUTER_DEFAULT_MODEL, jevUpstreamFromEnv, modelFromEnv, providerFromEnv, reasoningFromEnv, upstreamFromEnv } from "./provider";
import { GeminiUpstream } from "./gemini";
import { UpstreamError } from "./upstream";
import { GOOD_ANSWER, fakeRender, sampleRequest } from "./__fixtures__/fakes";

const KEY = "sk-or-v1-TEST-not-a-real-key";
const prompt = fakeRender(sampleRequest());

function okResponse(text: string, logprobs?: number[]) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: text },
          finish_reason: "stop",
          logprobs: logprobs ? { content: logprobs.map((logprob) => ({ token: "x", logprob })) } : null,
        },
      ],
      usage: { prompt_tokens: 1100, completion_tokens: 80 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
function errResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), { status });
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

const make = (fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof OpenRouterUpstream>[0]> = {}) =>
  new OpenRouterUpstream({ apiKey: KEY, model: "gpt-test", baseUrl: "https://api.example/v1", fetch, ...extra });

describe("toJsonSchema", () => {
  it("lower-cases types and drops propertyOrdering, recursively", () => {
    expect(
      toJsonSchema({
        type: "OBJECT",
        properties: { a: { type: "ARRAY", items: { type: "INTEGER" } }, type: { type: "STRING", enum: ["X"] } },
        required: ["a"],
        propertyOrdering: ["a", "type"],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "array", items: { type: "integer" } }, type: { type: "string", enum: ["X"] } },
      required: ["a"],
    });
  });
});

describe("buildOpenRouterBody", () => {
  it("has system + user messages, json_schema output and the optional fields", () => {
    const body = buildOpenRouterBody(prompt, {
      model: "gpt-test",
      temperature: 0.3,
      format: "json_schema",
      logprobs: true,
      reasoning: { enabled: false },
      maxOutputTokens: 400,
    });
    expect(body.messages).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: prompt.user },
    ]);
    expect(body).toMatchObject({ model: "gpt-test", temperature: 0.3, logprobs: true, reasoning: { enabled: false }, max_completion_tokens: 400 });
    expect((body.response_format as any).type).toBe("json_schema");
    expect((body.response_format as any).json_schema.schema).toEqual(toJsonSchema(prompt.responseSchema));
  });
  it("omits what is off", () => {
    const body = buildOpenRouterBody(prompt, { model: "m", temperature: null, format: "none", logprobs: false });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("logprobs");
    expect(body).not.toHaveProperty("reasoning");
    expect(buildOpenRouterBody(prompt, { model: "m", temperature: 0, format: "json_object", logprobs: false }).response_format).toEqual({
      type: "json_object",
    });
  });
});

describe("extract", () => {
  it("reads text and mean logprob", () => {
    const r = { choices: [{ message: { content: "hi" }, logprobs: { content: [{ logprob: -0.2 }, { logprob: -0.4 }] } }] };
    expect(extractChatText(r)).toBe("hi");
    expect(extractChatLogprob(r)).toBeCloseTo(-0.3);
    expect(extractChatText({ choices: [{ message: { content: null } }] })).toBeNull();
    expect(extractChatLogprob({ choices: [{ logprobs: null }] })).toBeUndefined();
  });
});

describe("OpenRouterUpstream", () => {
  it("posts to chat/completions with the key only in the Bearer header", async () => {
    const m = mockFetch(() => okResponse(JSON.stringify(GOOD_ANSWER), [-0.1, -0.3]));
    const res = await make(m.fetch).generate({ prompt, temperature: 0.2, samples: 1 });
    expect(m.calls[0].url).toBe("https://api.example/v1/chat/completions");
    expect(m.calls[0].url).not.toContain(KEY);
    expect((m.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(m.calls[0].body.model).toBe("gpt-test");
    expect(res.texts).toEqual([JSON.stringify(GOOD_ANSWER)]);
    expect(res.logprob).toBeCloseTo(-0.2);
    expect(res.usage).toEqual({ promptTokens: 1100, outputTokens: 80 });
    expect(res.model).toBe("gpt-test");
  });

  it("samples = 2 makes two calls", async () => {
    const m = mockFetch((_c, n) => (n === 1 ? okResponse("a") : errResponse(500, "boom")));
    const res = await make(m.fetch, { logprobs: false }).generate({ prompt, temperature: 0.2, samples: 2 });
    expect(m.calls).toHaveLength(2);
    expect(res.texts).toEqual(["a", null]);
    expect(res.sampleErrors?.[1]).toMatch(/500/);
  });

  it("drops logprobs and reasoning for good when the API blames them", async () => {
    const m = mockFetch((c) => {
      if (c.body.logprobs) return errResponse(400, "logprobs is not supported with this model");
      if (c.body.reasoning?.enabled === false) return errResponse(400, "Reasoning is mandatory for this endpoint and cannot be disabled.");
      if (c.body.reasoning) return errResponse(400, "reasoning effort is not supported");
      return okResponse("ok");
    });
    const up = make(m.fetch, { reasoning: { enabled: false } });
    await up.generate({ prompt, temperature: 0, samples: 1 });
    expect(up.logprobsEnabled).toBe(false);
    expect(up.reasoning).toBeNull();
    expect(up.format).toBe("json_schema");
    const n = m.calls.length;
    await up.generate({ prompt, temperature: 0, samples: 1 });
    expect(m.calls.length).toBe(n + 1);
  });

  it("asks for minimal effort when a model refuses to turn reasoning off", async () => {
    const m = mockFetch((c) =>
      c.body.reasoning?.enabled === false ? errResponse(400, "Reasoning is mandatory for this endpoint and cannot be disabled.") : okResponse("ok"),
    );
    const up = make(m.fetch, { logprobs: false, reasoning: { enabled: false } });
    await up.generate({ prompt, temperature: 0, samples: 1 });
    expect(up.reasoning).toEqual({ effort: "minimal", exclude: true });
    expect(m.calls[1].body.reasoning).toEqual({ effort: "minimal", exclude: true });
  });

  it("steps response_format down to json_object, then none", async () => {
    const m = mockFetch((c) => (c.body.response_format ? errResponse(400, "Invalid parameter: response_format") : okResponse("ok")));
    const up = make(m.fetch, { logprobs: false });
    await up.generate({ prompt, temperature: 0, samples: 1 });
    expect(up.format).toBe("none");
    expect(m.calls.map((c) => c.body.response_format?.type ?? "none")).toEqual(["json_schema", "json_object", "none"]);
  });

  it("drops temperature when a reasoning model refuses it", async () => {
    const m = mockFetch((c) => ("temperature" in c.body ? errResponse(400, "Unsupported value: 'temperature'") : okResponse("ok")));
    const up = make(m.fetch, { logprobs: false });
    await up.generate({ prompt, temperature: 0.4, samples: 1 });
    expect(up.temperatureEnabled).toBe(false);
  });

  it("does not keep a step-down when it did not help", async () => {
    const m = mockFetch(() => errResponse(400, "context length exceeded"));
    const up = make(m.fetch);
    const err = await up.generate({ prompt, temperature: 0, samples: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(400);
    expect(up.format).toBe("json_schema");
    expect(up.logprobsEnabled).toBe(true);
  });

  it("times out, and never leaks the key in errors", async () => {
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const t = await make(hanging, { timeoutMs: 30 }).generate({ prompt, temperature: 0, samples: 1 }).catch((e) => e);
    expect(t.kind).toBe("timeout");
    const m = mockFetch(() => errResponse(401, `Incorrect API key provided: ${KEY}`));
    const e = await make(m.fetch).generate({ prompt, temperature: 0, samples: 1 }).catch((x) => x);
    expect(e.kind).toBe("http");
    expect(e.message).not.toContain(KEY);
  });

  it("requires a key", () => {
    expect(() => new OpenRouterUpstream({ apiKey: "", model: "m", baseUrl: "x" })).toThrow(UpstreamError);
  });
});

describe("provider selection", () => {
  it("honours LLM_PROVIDER, else the first provider with a key", () => {
    expect(providerFromEnv({})).toBe("gemini");
    expect(providerFromEnv({ OPENROUTER_API_KEY: KEY })).toBe("openrouter");
    expect(providerFromEnv({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: KEY })).toBe("gemini");
    expect(providerFromEnv({ LLM_PROVIDER: " BayLeaf ", GEMINI_API_KEY: "g" })).toBe("bayleaf");
    expect(() => providerFromEnv({ LLM_PROVIDER: "nope" })).toThrow(/LLM_PROVIDER/);
  });

  it("uses each provider's own model variable", () => {
    const env = { VITE_LLM_MODEL_NAME: "gemini-x", OPENROUTER_MODEL: "x-ai/y", BAYLEAF_MODEL: "openrouter:a/b" };
    expect(modelFromEnv({ ...env, LLM_PROVIDER: "gemini" })).toBe("gemini-x");
    expect(modelFromEnv({ ...env, LLM_PROVIDER: "openrouter" })).toBe("x-ai/y");
    expect(modelFromEnv({ ...env, LLM_PROVIDER: "bayleaf" })).toBe("openrouter:a/b");
  });

  it("maps thinking settings to OpenRouter's reasoning object", () => {
    expect(reasoningFromEnv({})).toBeNull();
    expect(reasoningFromEnv({ PROXY_THINKING_BUDGET: "0" })).toEqual({ enabled: false });
    expect(reasoningFromEnv({ PROXY_THINKING_BUDGET: "512" })).toEqual({ max_tokens: 512, exclude: true });
    expect(reasoningFromEnv({ PROXY_THINKING_BUDGET: "0", PROXY_REASONING_EFFORT: "low" })).toEqual({ effort: "low", exclude: true });
  });

  it("builds the right upstream", async () => {
    expect(upstreamFromEnv({ GEMINI_API_KEY: "AIzaTEST" })).toBeInstanceOf(GeminiUpstream);
    const oa = upstreamFromEnv({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: KEY }) as OpenRouterUpstream;
    expect(oa.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(() => upstreamFromEnv({ LLM_PROVIDER: "openrouter" })).toThrow(/openrouter API key/);

    const m = mockFetch(() => okResponse("ok"));
    const bl = upstreamFromEnv({ LLM_PROVIDER: "bayleaf" }, m.fetch) as OpenRouterUpstream;
    expect(bl.url).toBe("https://api.bayleaf.dev/v1/chat/completions");
    expect(bl.model).toBe("openrouter:z-ai/glm-5.3-flash");
    await bl.generate({ prompt, temperature: 0, samples: 1 });
    expect((m.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer campus");
  });
});

describe("Jev upstream selection (/when)", () => {
  it("is null with nothing set: /when uses the fill upstream", () => {
    expect(jevUpstreamFromEnv({ GEMINI_API_KEY: "AIzaTEST" })).toBeNull();
  });

  it("JEV_PROVIDER=openrouter defaults to the free LFM2.5 2.6B, independent of the fill provider", () => {
    const up = jevUpstreamFromEnv({ GEMINI_API_KEY: "AIzaTEST", OPENROUTER_API_KEY: KEY, JEV_PROVIDER: "openrouter" }) as OpenRouterUpstream;
    expect(up).toBeInstanceOf(OpenRouterUpstream);
    expect(up.model).toBe(JEV_OPENROUTER_DEFAULT_MODEL);
    expect(up.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const named = jevUpstreamFromEnv({ OPENROUTER_API_KEY: KEY, JEV_PROVIDER: "openrouter", JEV_MODEL: "google/gemma-4-26b-a4b-it:free" })!;
    expect(named.model).toBe("google/gemma-4-26b-a4b-it:free");
  });

  it("JEV_MODEL alone keeps the fill provider; gemini needs a model", () => {
    expect(jevUpstreamFromEnv({ GEMINI_API_KEY: "AIzaTEST", JEV_MODEL: "gemini-lite" })!.model).toBe("gemini-lite");
    expect(() => jevUpstreamFromEnv({ GEMINI_API_KEY: "AIzaTEST", JEV_PROVIDER: "gemini" })).toThrow(/JEV_MODEL/);
    expect(() => jevUpstreamFromEnv({ JEV_PROVIDER: "jev-cloud" })).toThrow(/JEV_PROVIDER/);
  });

  it("local talks to an OpenAI-compatible server (Ollama by default) and needs a model", async () => {
    expect(() => jevUpstreamFromEnv({ JEV_PROVIDER: "local" })).toThrow(/JEV_MODEL/);
    const m = mockFetch(() => okResponse('{"suggest":true,"p":0.8,"why":"x"}'));
    const up = jevUpstreamFromEnv({ JEV_PROVIDER: "local", JEV_MODEL: "lfm2.5:2.6b" }, m.fetch) as OpenRouterUpstream;
    expect(up.url).toBe(`${JEV_LOCAL_BASE_URL}/chat/completions`);
    await up.generate({ prompt, temperature: 0, samples: 1 });
    expect(m.calls[0].body.model).toBe("lfm2.5:2.6b");
    const lm = jevUpstreamFromEnv({ JEV_PROVIDER: "local", JEV_MODEL: "m", JEV_BASE_URL: "http://127.0.0.1:1234/v1/" }) as OpenRouterUpstream;
    expect(lm.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
  });
});
