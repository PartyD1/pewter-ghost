/**
 * Session client (G-33): reads the launcher token from the URL, asks the proxy
 * which condition this token is assigned to, and turns that into config
 * overrides. The UI must never show the condition; callers only feed the
 * overrides into `applyOverrides`.
 */
import type { ProxySessionResponse } from "../contracts";
import { DEFAULT_CONFIG, type GhostConfig } from "../suggest/config";

export type Condition = ProxySessionResponse["condition"];
const CONDITIONS: readonly Condition[] = ["llm", "algo", "none", "stub"];

/** Config fields a token may never override from the server. */
const SERVER_LOCKED = new Set<keyof GhostConfig>(["proxyUrl"]);

export interface SessionInfo {
  sessionId: string;
  condition: Condition;
  /** Sanitised overrides, always including `filler` = condition. */
  overrides: Partial<GhostConfig>;
  token: string | null;
  /** True when the proxy answered; false for the local fallback. */
  fromProxy: boolean;
  /** Why the fallback was used (no token, network error, HTTP status). */
  error?: string;
}

/** Read `?token=` (or `#token=`) from a URL search/hash string. */
export function readTokenFromUrl(href?: string): string | null {
  try {
    const loc = href ?? (globalThis as { location?: { href?: string } }).location?.href;
    if (!loc) return null;
    const url = new URL(loc, "http://localhost/");
    const q = url.searchParams.get("token");
    if (q && q.trim()) return q.trim();
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const h = hash.get("token");
    return h && h.trim() ? h.trim() : null;
  } catch {
    return null;
  }
}

/** Keep only known GhostConfig keys whose value type matches the default. */
export function sanitizeOverrides(raw: unknown): Partial<GhostConfig> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out as Partial<GhostConfig>;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in DEFAULT_CONFIG) || SERVER_LOCKED.has(k as keyof GhostConfig)) continue;
    const def = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[k];
    if (typeof def === "number") {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    } else if (typeof def === "string") {
      if (typeof v === "string") out[k] = v;
    } else if (typeof def === "boolean") {
      if (typeof v === "boolean") out[k] = v;
    } else if (def && typeof def === "object") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const merged: Record<string, unknown> = { ...(def as Record<string, unknown>) };
        for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
          const sd = (def as Record<string, unknown>)[sk];
          if (sk in merged && typeof sv === typeof sd) merged[sk] = sv;
        }
        out[k] = merged;
      }
    }
  }
  if ("filler" in out && !CONDITIONS.includes(out.filler as Condition)) delete out.filler;
  if ("confidenceSource" in out && !["stated", "logprob", "twoSample"].includes(out.confidenceSource as string))
    delete out.confidenceSource;
  return out as Partial<GhostConfig>;
}

export function isCondition(v: unknown): v is Condition {
  return typeof v === "string" && (CONDITIONS as readonly string[]).includes(v);
}

export function localSessionId(now = Date.now()): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `local-${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${rand}`;
}

export interface FetchSessionOptions {
  proxyUrl?: string;
  /** Defaults to readTokenFromUrl(). */
  token?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Condition used when the proxy cannot be reached (default: DEFAULT_CONFIG.filler). */
  fallbackCondition?: Condition;
}

/**
 * Resolve the session. Never rejects: without a token or on any failure it
 * returns a local session with the fallback condition and `fromProxy: false`.
 */
export async function fetchSession(opts: FetchSessionOptions = {}): Promise<SessionInfo> {
  const token = opts.token === undefined ? readTokenFromUrl() : opts.token;
  const fallback = (error: string): SessionInfo => {
    const condition = opts.fallbackCondition ?? DEFAULT_CONFIG.filler;
    return { sessionId: localSessionId(), condition, overrides: { filler: condition }, token, fromProxy: false, error };
  };
  if (!token) return fallback("no token");
  const base = (opts.proxyUrl ?? DEFAULT_CONFIG.proxyUrl).replace(/\/+$/, "");
  const f = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  if (!f) return fallback("no fetch");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await f(`${base}/session?token=${encodeURIComponent(token)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return fallback(`HTTP ${res.status}`);
    const body = (await res.json()) as Partial<ProxySessionResponse>;
    if (!body || typeof body.sessionId !== "string" || !isCondition(body.condition)) return fallback("bad session response");
    const overrides = { ...sanitizeOverrides(body.overrides), filler: body.condition };
    return { sessionId: body.sessionId, condition: body.condition, overrides, token, fromProxy: true };
  } catch (e) {
    return fallback(e instanceof Error && e.name === "AbortError" ? "timeout" : String(e));
  } finally {
    clearTimeout(timer);
  }
}
