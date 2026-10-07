/**
 * Session tokens and the condition switch (G-09, G-33).
 *
 * A launcher URL carries `?token=<t>`. The token maps to a TokenInfo: the
 * session id the proxy files recordings under, the study condition
 * (llm | algo | none | stub) and optional config overrides. GET /session hands
 * the condition and overrides to the client, which applies them silently.
 *
 * Token file format (proxy/.data/tokens.json in dev, PROXY_TOKENS in the worker):
 *   { "tokens": { "<token>": { "condition": "llm", "sessionId": "p01",
 *                             "overrides": { "showNowAbove": 0.8 }, "label": "pilot 1" } } }
 * `sessionId` defaults to "t-" + the first 12 hex chars of sha256(token).
 */
import type { ProxySessionResponse } from "../../apps/editor/src/contracts";
import { sha256Hex } from "../../apps/editor/src/research/hash";
import { isSafeSessionId } from "./store";

export type Condition = ProxySessionResponse["condition"];
export const CONDITIONS: readonly Condition[] = ["llm", "algo", "none", "stub"];

export interface TokenInfo {
  token: string;
  /** Base session id; recordings go under this id (or `<id>.<suffix>`). */
  sessionId: string;
  condition: Condition;
  overrides: Record<string, unknown>;
  label?: string;
  /** Epoch ms after which the token is refused. */
  expiresAt?: number;
  disabled?: boolean;
  /** Open-mode dev token: /session mints a fresh `dev.<stamp>` id per call. */
  dev?: boolean;
}

export interface TokenEntry {
  condition?: Condition;
  sessionId?: string;
  overrides?: Record<string, unknown>;
  label?: string;
  expiresAt?: number | string;
  disabled?: boolean;
}

export interface TokenFile {
  tokens: Record<string, TokenEntry>;
}

export interface TokenStore {
  lookup(token: string): Promise<TokenInfo | null>;
}

/** Tokens must be URL-safe and long enough not to be guessed (dev token excepted). */
export function isWellFormedToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(t);
}

export async function entryToInfo(token: string, entry: TokenEntry): Promise<TokenInfo | null> {
  const condition = entry.condition ?? "llm";
  if (!CONDITIONS.includes(condition)) return null;
  const sessionId = entry.sessionId ?? `t-${(await sha256Hex(token)).slice(0, 12)}`;
  if (!isSafeSessionId(sessionId)) return null;
  const overrides =
    entry.overrides && typeof entry.overrides === "object" && !Array.isArray(entry.overrides) ? entry.overrides : {};
  let expiresAt: number | undefined;
  if (typeof entry.expiresAt === "number") expiresAt = entry.expiresAt;
  else if (typeof entry.expiresAt === "string") {
    const ms = Date.parse(entry.expiresAt);
    if (!Number.isNaN(ms)) expiresAt = ms;
  }
  return { token, sessionId, condition, overrides, label: entry.label, expiresAt, disabled: entry.disabled };
}

export function parseTokenFile(text: string): TokenFile {
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("token file: not an object");
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error("token file: missing tokens map");
  return { tokens: tokens as Record<string, TokenEntry> };
}

export const DEV_TOKEN = "dev";

/** The token accepted when PROXY_OPEN=1. */
export function devTokenInfo(): TokenInfo {
  return { token: DEV_TOKEN, sessionId: "dev", condition: "llm", overrides: {}, dev: true, label: "open dev mode" };
}

/** In-memory token store over a TokenFile; optionally accepts the dev token. */
export class StaticTokenStore implements TokenStore {
  constructor(
    private file: TokenFile = { tokens: {} },
    private readonly open = false,
  ) {}

  setFile(file: TokenFile): void {
    this.file = file;
  }

  async lookup(token: string): Promise<TokenInfo | null> {
    if (!isWellFormedToken(token)) return null;
    const entry = Object.prototype.hasOwnProperty.call(this.file.tokens, token) ? this.file.tokens[token] : undefined;
    if (entry) return entryToInfo(token, entry);
    if (this.open && token === DEV_TOKEN) return devTokenInfo();
    return null;
  }
}

/** Tries stores in order; first hit wins. */
export class ChainTokenStore implements TokenStore {
  constructor(private readonly stores: TokenStore[]) {}
  async lookup(token: string): Promise<TokenInfo | null> {
    for (const s of this.stores) {
      const hit = await s.lookup(token);
      if (hit) return hit;
    }
    return null;
  }
}

/** Is the token usable right now? */
export function tokenActive(info: TokenInfo, nowMs: number): boolean {
  if (info.disabled) return false;
  if (info.expiresAt !== undefined && nowMs > info.expiresAt) return false;
  return true;
}

/**
 * Does `sessionId` (from a /fill or /log body) belong to this token?
 * Allowed: the base id, or `<base>.<suffix>` (several runs under one token).
 * The open dev token may use any safe id.
 */
export function sessionBelongsTo(info: TokenInfo, sessionId: string): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  if (info.dev) return true;
  return sessionId === info.sessionId || sessionId.startsWith(info.sessionId + ".");
}

/** GET /session body. Dev tokens get a fresh id per call so dev runs do not merge. */
export function sessionResponse(info: TokenInfo, mintId: () => string): ProxySessionResponse {
  const sessionId = info.dev ? `dev.${mintId()}` : info.sessionId;
  return { sessionId, condition: info.condition, overrides: { ...info.overrides } };
}

/** Random URL-safe token (for the token script). */
export function generateToken(bytes = 18): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
