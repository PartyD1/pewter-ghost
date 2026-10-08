/**
 * Pewter Ghost proxy: one fetch-style handler (Request -> Response) shared by
 * the Cloudflare Worker (worker.ts) and the node dev server (dev.ts).
 *
 * Routes
 *   GET  /health                      no auth
 *   GET  /session?token=<t>           token in query or Bearer -> ProxySessionResponse
 *   POST /fill   Bearer <t>           ProxyFillBody -> ProxyFillResponse
 *   POST /log    Bearer <t> | ?token= ProxyLogBody  -> { ok, accepted, rejected }
 *
 * /fill renders the prompt with the injected renderer, calls the upstream,
 * parses each sample with the injected parser (garbage -> null), and appends a
 * Recording line to recordings/<sessionId>.jsonl. Upstream failures (timeout,
 * HTTP error) still answer 200 with `answer: null` and `error`, so the client
 * always gets the requestHash; client mistakes get 4xx.
 */
import type {
  FillRequest,
  ModelAnswer,
  ProxyFillBody,
  ProxyFillResponse,
  ProxyLogBody,
  Recording,
  RenderedPrompt,
} from "../../apps/editor/src/contracts";
import { canonicalJson, sha256Hex } from "../../apps/editor/src/research/hash";
import { validateEvent } from "../../apps/editor/src/research/schema";
import { TokenBucketLimiter, type RateLimitConfig } from "./rateLimit";
import {
  sessionBelongsTo,
  sessionResponse,
  tokenActive,
  type TokenInfo,
  type TokenStore,
} from "./sessions";
import { isSafeSessionId, logKey, recordingKey, rejectedLogKey, type ProxyStore } from "./store";
import { UpstreamError, type Upstream, type UpstreamResult } from "./upstream";

export interface HandlerDeps {
  render: (req: FillRequest) => RenderedPrompt;
  parse: (raw: unknown) => ModelAnswer | null;
  upstream: Upstream;
  store: ProxyStore;
  tokens: TokenStore;
  /** Epoch ms clock (default Date.now). */
  now?: () => number;
  /** Id minting for dev sessions (default timestamp + random). */
  newId?: () => string;
  /** /fill limit per token (default 120/min, burst 120). */
  fillRate?: RateLimitConfig;
  /** /log limit per token (default 60/min, burst 30). */
  logRate?: RateLimitConfig;
  /** /session limit per token (default 30/min, burst 10). */
  sessionRate?: RateLimitConfig;
  /** CORS: which browser origins may call (default: localhost / 127.0.0.1 on any port). */
  allowOrigin?: (origin: string) => boolean;
  /** Conditions whose tokens may call /fill (default ["llm"]). */
  fillConditions?: readonly TokenInfo["condition"][];
  /** Default temperatures by sample count (defaults 0.2 and 0.7). */
  temperature?: { one: number; two: number };
  maxFillBodyBytes?: number;
  maxLogBodyBytes?: number;
  maxLogEvents?: number;
  /** Operational log sink (never receives the key or request bodies). */
  onError?: (message: string) => void;
}

export interface HandlerContext {
  /** Worker ExecutionContext.waitUntil: storage writes continue after the response. */
  waitUntil?: (p: Promise<unknown>) => void;
}

export type ProxyHandler = (request: Request, ctx?: HandlerContext) => Promise<Response>;

export const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function allowLocalhost(origin: string): boolean {
  return LOCALHOST_ORIGIN.test(origin);
}

/** Origin predicate for a comma-separated allow list plus localhost. `*` allows all. */
export function originAllowList(list: string | undefined): (origin: string) => boolean {
  const items = (list ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (items.includes("*")) return () => true;
  const set = new Set(items);
  return (o) => allowLocalhost(o) || set.has(o);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function createHandler(deps: HandlerDeps): ProxyHandler {
  const now = deps.now ?? Date.now;
  const newId =
    deps.newId ??
    (() => `${new Date(now()).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`);
  const fillLimiter = new TokenBucketLimiter(deps.fillRate ?? { capacity: 120, perMinute: 120 });
  const logLimiter = new TokenBucketLimiter(deps.logRate ?? { capacity: 30, perMinute: 60 });
  const sessionLimiter = new TokenBucketLimiter(deps.sessionRate ?? { capacity: 10, perMinute: 30 });
  const allowOrigin = deps.allowOrigin ?? allowLocalhost;
  const fillConditions = deps.fillConditions ?? ["llm"];
  const temps = deps.temperature ?? { one: 0.2, two: 0.7 };
  const maxFill = deps.maxFillBodyBytes ?? 256 * 1024;
  const maxLog = deps.maxLogBodyBytes ?? 2 * 1024 * 1024;
  const maxLogEvents = deps.maxLogEvents ?? 10_000;
  const report = (m: string) => {
    try {
      deps.onError?.(m);
    } catch {
      /* ignore */
    }
  };

  async function persist(ctx: HandlerContext | undefined, what: string, p: Promise<unknown>): Promise<void> {
    const guarded = p.catch((e) => report(`store ${what} failed: ${e instanceof Error ? e.message : String(e)}`));
    if (ctx?.waitUntil) ctx.waitUntil(guarded);
    else await guarded;
  }

  async function authenticate(request: Request, url: URL, allowQuery: boolean): Promise<TokenInfo> {
    const auth = request.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    let token = m ? m[1] : null;
    if (!token && allowQuery) token = url.searchParams.get("token");
    if (!token) throw new HttpError(401, "missing session token", { "WWW-Authenticate": "Bearer" });
    const info = await deps.tokens.lookup(token);
    if (!info || !tokenActive(info, now())) throw new HttpError(401, "invalid or expired session token", { "WWW-Authenticate": "Bearer" });
    return info;
  }

  function limit(limiter: TokenBucketLimiter, info: TokenInfo): void {
    const r = limiter.take(info.token, now());
    if (!r.ok)
      throw new HttpError(429, "rate limit exceeded", { "Retry-After": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) });
  }

  async function readJson(request: Request, maxBytes: number): Promise<unknown> {
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > maxBytes) throw new HttpError(413, "body too large");
    const text = await request.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, "body too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "body is not valid JSON");
    }
  }

  // --- routes --------------------------------------------------------------

  async function health(): Promise<Response> {
    return json(200, { ok: true, model: deps.upstream.model, time: new Date(now()).toISOString() });
  }

  async function session(request: Request, url: URL): Promise<Response> {
    const info = await authenticate(request, url, true);
    limit(sessionLimiter, info);
    return json(200, sessionResponse(info, newId));
  }

  async function fill(request: Request, url: URL, ctx?: HandlerContext): Promise<Response> {
    const info = await authenticate(request, url, false);
    if (!fillConditions.includes(info.condition)) throw new HttpError(403, "fill is not enabled for this session");
    limit(fillLimiter, info);
    const body = (await readJson(request, maxFill)) as Partial<ProxyFillBody> | null;
    if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
    const sessionId = body.sessionId;
    if (!isSafeSessionId(sessionId)) throw new HttpError(400, "bad sessionId");
    if (!sessionBelongsTo(info, sessionId)) throw new HttpError(403, "sessionId does not belong to this token");
    const shapeErr = fillRequestProblem(body.request);
    if (shapeErr) throw new HttpError(400, `bad request: ${shapeErr}`);
    const req = body.request as FillRequest;
    const samples: 1 | 2 = body.samples === 2 ? 2 : 1;
    if (body.samples !== undefined && body.samples !== 1 && body.samples !== 2) throw new HttpError(400, "samples must be 1 or 2");
    let temperature = samples === 2 ? temps.two : temps.one;
    if (body.temperature !== undefined) {
      if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)) throw new HttpError(400, "bad temperature");
      temperature = Math.min(2, Math.max(0, body.temperature));
    }

    const requestHash = await sha256Hex(canonicalJson(req));
    let prompt: RenderedPrompt;
    try {
      prompt = deps.render(req);
    } catch (e) {
      throw new HttpError(400, `cannot render prompt: ${e instanceof Error ? e.message : String(e)}`);
    }

    const t0 = now();
    let result: UpstreamResult | null = null;
    let error: string | undefined;
    try {
      result = await deps.upstream.generate({ prompt, temperature, samples });
    } catch (e) {
      error = e instanceof UpstreamError ? (e.kind === "timeout" ? "upstream timeout" : e.message) : `upstream failed: ${e instanceof Error ? e.message : String(e)}`;
      report(`fill ${sessionId}: ${error}`);
    }
    const latencyMs = Math.max(0, now() - t0);

    const texts = result?.texts ?? [];
    const answers: (ModelAnswer | null)[] = [];
    for (let i = 0; i < samples; i++) answers.push(parseSample(texts[i] ?? null));
    const answer = answers[0] ?? null;
    if (!error && result && texts[0] == null && result.sampleErrors?.[0]) error = result.sampleErrors[0] ?? undefined;

    const response: ProxyFillResponse = {
      answer,
      latencyMs,
      model: result?.model ?? deps.upstream.model,
      promptVersion: prompt.promptVersion,
      requestHash,
    };
    if (samples === 2) response.answers = answers;
    if (result?.logprob !== undefined) response.logprob = result.logprob;
    if (error) response.error = error;

    const recording: Recording = {
      t: new Date(now()).toISOString(),
      sessionId,
      requestHash,
      request: req,
      answer,
      latencyMs,
      model: response.model,
      promptVersion: prompt.promptVersion,
      temperature,
      samples,
    };
    if (samples === 2) recording.answers = answers;
    if (response.logprob !== undefined) recording.logprob = response.logprob;
    if (error) recording.error = error;
    // Keep raw model text when parsing failed, so prompt work can see what went wrong.
    if (result && answers.some((a, i) => a === null && texts[i] != null)) recording.raw = texts.slice(0, samples);
    await persist(ctx, "recording", deps.store.append(recordingKey(sessionId), JSON.stringify(recording) + "\n"));

    return json(200, response);
  }

  function parseSample(text: string | null): ModelAnswer | null {
    if (text == null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(stripFence(text));
    } catch {
      return null;
    }
    try {
      return deps.parse(raw) ?? null;
    } catch {
      return null;
    }
  }

  async function log(request: Request, url: URL, ctx?: HandlerContext): Promise<Response> {
    // sendBeacon cannot set headers, so /log also takes ?token=.
    const info = await authenticate(request, url, true);
    limit(logLimiter, info);
    const body = (await readJson(request, maxLog)) as Partial<ProxyLogBody> | null;
    if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
    const sessionId = body.sessionId;
    if (!isSafeSessionId(sessionId)) throw new HttpError(400, "bad sessionId");
    if (!sessionBelongsTo(info, sessionId)) throw new HttpError(403, "sessionId does not belong to this token");
    if (!Array.isArray(body.events)) throw new HttpError(400, "events must be an array");
    if (body.events.length > maxLogEvents) throw new HttpError(413, `at most ${maxLogEvents} events per batch`);

    let good = "";
    let bad = "";
    let accepted = 0;
    const rejected: { index: number; error: string }[] = [];
    const received = new Date(now()).toISOString();
    body.events.forEach((ev, index) => {
      const v = validateEvent(ev);
      if (v.ok) {
        good += JSON.stringify(ev) + "\n";
        accepted++;
      } else {
        rejected.push({ index, error: v.error });
        bad += JSON.stringify({ received, error: v.error, event: ev }) + "\n";
      }
    });
    if (good) await persist(ctx, "log", deps.store.append(logKey(sessionId), good));
    if (bad) await persist(ctx, "rejected log", deps.store.append(rejectedLogKey(sessionId), bad));
    return json(200, { ok: true, accepted, rejected });
  }

  // --- dispatch ------------------------------------------------------------

  return async function handle(request: Request, ctx?: HandlerContext): Promise<Response> {
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, allowOrigin);
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (request.method === "OPTIONS") {
        if (origin && !cors) return withHeaders(new Response(null, { status: 403 }), {});
        return withHeaders(new Response(null, { status: 204 }), {
          ...(cors ?? {}),
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        });
      }
      const route = ROUTES[path];
      if (!route) throw new HttpError(404, "not found");
      if (request.method !== route) throw new HttpError(405, "method not allowed", { Allow: `${route}, OPTIONS` });
      let res: Response;
      switch (path) {
        case "/health":
          res = await health();
          break;
        case "/session":
          res = await session(request, url);
          break;
        case "/fill":
          res = await fill(request, url, ctx);
          break;
        default:
          res = await log(request, url, ctx);
          break;
      }
      return withHeaders(res, cors ?? {});
    } catch (e) {
      if (e instanceof HttpError) return withHeaders(json(e.status, { error: e.message }), { ...(cors ?? {}), ...e.headers });
      report(`internal error: ${e instanceof Error ? e.message : String(e)}`);
      return withHeaders(json(500, { error: "internal error" }), cors ?? {});
    }
  };
}

const ROUTES: Record<string, "GET" | "POST"> = {
  "/health": "GET",
  "/session": "GET",
  "/fill": "POST",
  "/log": "POST",
};

function corsHeaders(origin: string | null, allow: (o: string) => boolean): Record<string, string> | null {
  if (!origin || !allow(origin)) return null;
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

/** Models sometimes wrap JSON in ``` fences even in JSON mode. */
function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1] : t;
}

const MODES = new Set(["auto", "requested", "patrol", "tidy"]);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPt = (v: unknown) => !!v && typeof v === "object" && isNum((v as { x?: unknown }).x) && isNum((v as { y?: unknown }).y);

/** Cheap structural check of a FillRequest; the renderer does the rest. Returns a problem or null. */
export function fillRequestProblem(r: unknown): string | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "request must be an object";
  const q = r as Partial<FillRequest>;
  if (typeof q.grid !== "string" || q.grid.length === 0) return "grid must be a non-empty string";
  if (!isPt(q.origin)) return "origin must be {x,y}";
  if (!q.size || !isNum(q.size.w) || !isNum(q.size.h) || q.size.w <= 0 || q.size.h <= 0) return "size must be {w,h} > 0";
  if (!Array.isArray(q.recent)) return "recent must be an array";
  if (!q.frontier || !isPt(q.frontier)) return "frontier must be {x,y,idleMs}";
  if (!q.knight || typeof q.knight !== "object") return "knight must be an object";
  if (!q.measured || typeof q.measured !== "object") return "measured must be an object";
  if (typeof q.brief !== "string") return "brief must be a string";
  if (typeof q.briefVersion !== "string") return "briefVersion must be a string";
  if (!Array.isArray(q.lastGhosts)) return "lastGhosts must be an array";
  if (typeof q.mode !== "string" || !MODES.has(q.mode)) return "mode must be auto | requested | patrol";
  return null;
}
