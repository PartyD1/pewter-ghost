/**
 * Firebase (Cloud Firestore) backend for session logs.
 *
 * The proxy is the only writer and reader: it holds a service account, so no
 * Firebase credential ever reaches the browser, and Firestore's security
 * rules can deny every client (firestore.rules). It talks to Firestore's REST
 * API with `fetch` and WebCrypto only, so the same code runs on the Cloudflare
 * Worker and in Node (the Admin SDK does not run on Workers).
 *
 * Layout
 *   sessions/{sessionId}                 one summary per session (what the replay
 *                                        list shows without downloading anything):
 *                                        events, bytes, firstT, lastT, startedAt,
 *                                        replayFlag (0|1), filler, updatedAt
 *   sessions/{sessionId}/chunks/{id}     the log itself: `text` (whole JSONL lines,
 *                                        <= ~700 KB so a document stays under
 *                                        Firestore's 1 MiB), ids sort in write order
 *
 * Only session logs live here (logs/<id>.jsonl). Everything else the proxy
 * keeps (recordings for the eval suite, rejected events, Jev exchanges) stays
 * in the store it already used, behind FirestoreStore.
 *
 * Local runs can use the Firestore emulator (FIRESTORE_EMULATOR_HOST) with no
 * credentials.
 */
import { isSafeSessionId, type ProxyStore } from "./store";
import { idTimestamp, scanLog, type SessionSummary } from "./summary";

export interface ServiceAccount {
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FirestoreOptions {
  projectId: string;
  /** Service account (production). Omit with `emulatorHost`. */
  credentials?: ServiceAccount;
  /** "127.0.0.1:8080": use the local Firestore emulator, no auth. */
  emulatorHost?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class FirestoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FirestoreError";
  }
}

type Value = { stringValue: string } | { integerValue: string } | { doubleValue: number } | { booleanValue: boolean } | { nullValue: null };
type Fields = Record<string, Value>;
export interface FsDocument {
  name: string;
  fields?: Fields;
}

const SCOPE = "https://www.googleapis.com/auth/datastore";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

const b64url = (bytes: ArrayBuffer | Uint8Array | string): string => {
  const u8 = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [A-Z ]+-----/, "").replace(/-----END [A-Z ]+-----/, "").replace(/\s+/g, "");
  const bin = atob(body);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A signed JWT assertion for Google's OAuth token endpoint (RS256). */
export async function signAssertion(sa: ServiceAccount, nowSec: number): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? DEFAULT_TOKEN_URI, iat: nowSec, exp: nowSec + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

export const str = (s: string): Value => ({ stringValue: s });
export const int = (n: number): Value => ({ integerValue: String(Math.round(n)) });
export const dbl = (n: number): Value => ({ doubleValue: n });

function num(v: Value | undefined): number | undefined {
  if (!v) return undefined;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  return undefined;
}
const text = (v: Value | undefined): string | undefined => (v && "stringValue" in v ? v.stringValue : undefined);
const lastSegment = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

/** Firestore REST with service-account auth (or the emulator). */
export class FirestoreClient {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;
  readonly base: string;
  private readonly root: string;

  constructor(private readonly o: FirestoreOptions) {
    this.f = o.fetch ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.root = `projects/${o.projectId}/databases/(default)/documents`;
    this.base = o.emulatorHost ? `http://${o.emulatorHost}/v1/${this.root}` : `https://firestore.googleapis.com/v1/${this.root}`;
    if (!o.emulatorHost && !o.credentials) throw new Error("Firestore needs a service account (or FIRESTORE_EMULATOR_HOST for the emulator)");
  }

  get projectId(): string {
    return this.o.projectId;
  }

  docName(path: string): string {
    return `${this.root}/${path}`;
  }

  private async accessToken(force = false): Promise<string> {
    if (this.o.emulatorHost) return "owner";
    const nowMs = this.now();
    if (!force && this.token && this.token.expiresAt - 60_000 > nowMs) return this.token.value;
    const sa = this.o.credentials!;
    const assertion = await signAssertion(sa, Math.floor(nowMs / 1000));
    const res = await this.f(sa.token_uri ?? DEFAULT_TOKEN_URI, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
    });
    if (!res.ok) throw new FirestoreError(res.status, `Google rejected the service account (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new FirestoreError(500, "Google gave no access token");
    this.token = { value: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** One request; a 401 refreshes the token once, a 429 / 503 is retried once. */
  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this.accessToken(refreshed)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 401 && !refreshed && !this.o.emulatorHost) {
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
      } catch {
        /* no JSON body */
      }
      throw new FirestoreError(res.status, `Firestore ${method} ${path.split("?")[0]} failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
  }

  commit(writes: unknown[]): Promise<unknown> {
    return this.request("POST", ":commit", { writes });
  }

  async listDocuments(collectionPath: string, pageSize = 300): Promise<FsDocument[]> {
    const out: FsDocument[] = [];
    let token: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const q = `?pageSize=${pageSize}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
      const r = await this.request<{ documents?: FsDocument[]; nextPageToken?: string }>("GET", `/${collectionPath}${q}`);
      out.push(...(r.documents ?? []));
      if (!r.nextPageToken) break;
      token = r.nextPageToken;
    }
    return out;
  }

  async runQuery(structuredQuery: unknown): Promise<FsDocument[]> {
    const rows = await this.request<{ document?: FsDocument }[]>("POST", ":runQuery", { structuredQuery });
    return rows.flatMap((r) => (r.document ? [r.document] : []));
  }

  async count(collectionId: string): Promise<number> {
    const rows = await this.request<{ result?: { aggregateFields?: { n?: Value } } }[]>("POST", ":runAggregationQuery", {
      structuredAggregationQuery: { aggregations: [{ count: {}, alias: "n" }], structuredQuery: { from: [{ collectionId }] } },
    });
    return num(rows[0]?.result?.aggregateFields?.n) ?? 0;
  }
}

export interface FirebaseEnv {
  /** The service account key file's JSON, as one string (a Worker secret). */
  FIREBASE_SERVICE_ACCOUNT?: string;
  /** Defaults to the service account's own project. */
  FIREBASE_PROJECT_ID?: string;
  /** "127.0.0.1:8080": the Firestore emulator instead of the real service. */
  FIRESTORE_EMULATOR_HOST?: string;
}

/**
 * Firestore client from the environment, or null when Firebase is not set up
 * (the proxy then keeps logs where it always did). A half-set or malformed
 * configuration throws a message that says what is wrong and never echoes the key.
 */
export function firestoreFromEnv(env: FirebaseEnv, fetchImpl?: typeof fetch): FirestoreClient | null {
  const raw = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST?.trim();
  if (!raw && !emulatorHost) return null;
  if (emulatorHost) return new FirestoreClient({ projectId: env.FIREBASE_PROJECT_ID?.trim() || "demo-pewter-ghost", emulatorHost, fetch: fetchImpl });
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw!) as ServiceAccount;
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole downloaded key file)");
  }
  if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") throw new Error("FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key (is it the service account key file?)");
  // A key pasted through a .env file often has literal \n instead of line breaks.
  sa = { ...sa, private_key: sa.private_key.replace(/\\n/g, "\n") };
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || sa.project_id;
  if (!projectId) throw new Error("no Firebase project id: set FIREBASE_PROJECT_ID (the key file has no project_id)");
  return new FirestoreClient({ projectId, credentials: sa, fetch: fetchImpl });
}

/** Longest chunk of log text kept in one document (bytes), under Firestore's 1 MiB with room for the rest. */
export const MAX_CHUNK_BYTES = 700_000;

/** Split JSONL text into pieces of at most `max` bytes, on line boundaries. */
export function splitLines(textIn: string, max = MAX_CHUNK_BYTES): string[] {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const line of textIn.split("\n")) {
    if (line === "") continue;
    const withNl = line + "\n";
    const b = enc.encode(withNl).length;
    if (cur && curBytes + b > max) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += withNl;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out;
}

const logSessionOf = (key: string): string | null => {
  if (!key.startsWith("logs/") || !key.endsWith(".jsonl") || key.endsWith(".rejected.jsonl")) return null;
  const id = key.slice("logs/".length, -".jsonl".length);
  return isSafeSessionId(id) ? id : null;
};

export interface FirestoreStoreOptions {
  /** Where every key that is not a session log goes (recordings, rejected events, Jev). */
  inner: ProxyStore;
  now?: () => number;
}

/** A ProxyStore that keeps session logs in Firestore and everything else in `inner`. */
export class FirestoreStore implements ProxyStore {
  private seq = 0;
  private readonly now: () => number;

  constructor(
    private readonly db: FirestoreClient,
    private readonly o: FirestoreStoreOptions,
  ) {
    this.now = o.now ?? Date.now;
  }

  async append(key: string, textIn: string): Promise<void> {
    const sid = logSessionOf(key);
    if (!sid) return this.o.inner.append(key, textIn);
    const pieces = splitLines(textIn);
    if (!pieces.length) return;
    const scan = scanLog(textIn);
    const t = this.now();
    const stamp = String(t).padStart(15, "0");
    const writes: unknown[] = [];

    // The summary: create-or-update with counters that merge safely when two batches overlap.
    const fields: Fields = { sessionId: str(sid), updatedAt: int(t) };
    const mask = ["sessionId", "updatedAt"];
    if (scan.filler) {
      fields.filler = str(scan.filler);
      mask.push("filler");
    }
    const transforms: unknown[] = [
      { fieldPath: "events", increment: int(scan.events) },
      { fieldPath: "bytes", increment: int(textIn.length) },
      { fieldPath: "startedAt", minimum: int(scan.startedAt ?? idTimestamp(sid) ?? t) },
      { fieldPath: "replayFlag", maximum: int(scan.hasReplay ? 1 : 0) },
    ];
    if (scan.events > 0) {
      transforms.push({ fieldPath: "firstT", minimum: dbl(scan.minT) }, { fieldPath: "lastT", maximum: dbl(scan.maxT) });
    }
    writes.push({ update: { name: this.db.docName(`sessions/${sid}`), fields }, updateMask: { fieldPaths: mask }, updateTransforms: transforms });

    pieces.forEach((piece, i) => {
      const id = `${stamp}-${String(this.seq++ % 1_000_000).padStart(6, "0")}-${i}-${Math.random().toString(36).slice(2, 7)}`;
      writes.push({
        update: { name: this.db.docName(`sessions/${sid}/chunks/${id}`), fields: { text: str(piece), n: int(piece.split("\n").length - 1) } },
        currentDocument: { exists: false },
      });
    });
    await this.db.commit(writes);
  }

  async read(key: string): Promise<string | null> {
    const sid = logSessionOf(key);
    if (!sid) return this.o.inner.read(key);
    const chunks = await this.db.listDocuments(`sessions/${sid}/chunks`);
    if (!chunks.length) return null;
    chunks.sort((a, b) => (lastSegment(a.name) < lastSegment(b.name) ? -1 : 1));
    return chunks.map((c) => text(c.fields?.text) ?? "").join("");
  }

  async list(prefix: string): Promise<string[]> {
    if (!prefix.startsWith("logs/")) return this.o.inner.list(prefix);
    const docs = await this.db.runQuery({ from: [{ collectionId: "sessions" }], select: { fields: [{ fieldPath: "__name__" }] }, limit: 5000 });
    return docs
      .map((d) => lastSegment(d.name))
      .filter((id) => isSafeSessionId(id))
      .map((id) => `logs/${id}.jsonl`)
      .filter((k) => k.startsWith(prefix))
      .sort();
  }

  async summaries(limit: number): Promise<{ sessions: SessionSummary[]; total: number }> {
    const docs = await this.db.runQuery({
      from: [{ collectionId: "sessions" }],
      orderBy: [{ field: { fieldPath: "startedAt" }, direction: "DESCENDING" }],
      limit,
    });
    const sessions = docs.map((d): SessionSummary => {
      const f = d.fields ?? {};
      const first = num(f.firstT);
      const last = num(f.lastT);
      return {
        sessionId: text(f.sessionId) ?? lastSegment(d.name),
        events: num(f.events) ?? 0,
        durationMs: first !== undefined && last !== undefined ? Math.max(0, Math.round(last - first)) : 0,
        startedAt: num(f.startedAt),
        hasReplay: (num(f.replayFlag) ?? 0) > 0,
        filler: text(f.filler),
        bytes: num(f.bytes) ?? 0,
      };
    });
    let total = sessions.length;
    if (sessions.length >= limit) {
      try {
        total = Math.max(total, await this.db.count("sessions"));
      } catch {
        /* the list is still right; only "showing N of M" is approximate */
      }
    }
    return { sessions, total };
  }
}
