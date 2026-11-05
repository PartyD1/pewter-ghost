/**
 * A stand-in for Cloud Firestore's REST API, just the calls firestore.ts makes.
 * It is strict where the real service is strict, so a mistake in the store
 * fails here instead of in production:
 *  - the OAuth token endpoint verifies the RS256 JWT's signature and claims;
 *  - every other call needs a token it issued;
 *  - commits are atomic; `currentDocument.exists:false` conflicts with 409;
 *    a field in both the update mask and the transforms is a 400;
 *    only increment / minimum / maximum transforms are understood;
 *  - an ordered query leaves out documents that lack the ordered field.
 * It is NOT proof against the live service (it encodes our reading of the docs).
 */
import { createVerify } from "node:crypto";

type Value = Record<string, unknown>;
type Fields = Record<string, Value>;

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, message: string) => json(status, { error: { code: status, message } });

const numOf = (v: Value | undefined): number | undefined => {
  if (!v) return undefined;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue as number;
  return undefined;
};

export class FakeFirestore {
  /** "sessions/p01" or "sessions/p01/chunks/<id>" -> fields */
  docs = new Map<string, Fields>();
  tokenCalls = 0;
  requests: { method: string; path: string }[] = [];
  /** Statuses to answer with before behaving normally (to test retries). */
  failNext: number[] = [];
  /** Seconds a token lives (to test refresh). */
  tokenTtl = 3600;
  private tokens = new Set<string>();
  private issued = 0;

  constructor(
    readonly projectId: string,
    private readonly auth: { publicKeyPem: string; clientEmail: string } | { emulator: true },
  ) {}

  private root = () => `projects/${this.projectId}/databases/(default)/documents`;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.href === TOKEN_URL) return this.token(String(init?.body ?? ""));

    this.requests.push({ method, path: url.pathname + url.search });
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const okAuth = "emulator" in this.auth ? bearer === "owner" : this.tokens.has(bearer);
    if (!okAuth) return err(401, "Request had invalid authentication credentials.");
    const fail = this.failNext.shift();
    if (fail) return err(fail, "scripted failure");

    const prefix = `/v1/${this.root()}`;
    if (!url.pathname.startsWith(prefix)) return err(404, "not found");
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "POST" && rest === ":commit") return this.commit(body.writes as Write[]);
    if (method === "POST" && rest === ":runQuery") return this.runQuery(body.structuredQuery as Query);
    if (method === "POST" && rest === ":runAggregationQuery") return this.aggregate(body.structuredAggregationQuery as { structuredQuery: Query });
    if (method === "GET" && rest.startsWith("/")) return this.list(rest.slice(1), url.searchParams);
    return err(400, `unsupported call ${method} ${rest}`);
  };

  // -------------------------------------------------------------- OAuth

  private async token(form: string): Promise<Response> {
    this.tokenCalls++;
    if ("emulator" in this.auth) return err(400, "the emulator needs no token");
    const p = new URLSearchParams(form);
    if (p.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return json(400, { error: "unsupported_grant_type" });
    const parts = (p.get("assertion") ?? "").split(".");
    if (parts.length !== 3) return json(400, { error: "invalid_grant", error_description: "malformed assertion" });
    const verify = createVerify("RSA-SHA256");
    verify.update(`${parts[0]}.${parts[1]}`);
    if (!verify.verify(this.auth.publicKeyPem, Buffer.from(parts[2], "base64url"))) return json(400, { error: "invalid_grant", error_description: "bad signature" });
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (header.alg !== "RS256") return json(400, { error: "invalid_grant", error_description: "alg" });
    if (claims.iss !== this.auth.clientEmail) return json(400, { error: "invalid_grant", error_description: "iss" });
    if (claims.scope !== "https://www.googleapis.com/auth/datastore") return json(400, { error: "invalid_scope" });
    if (claims.aud !== TOKEN_URL) return json(400, { error: "invalid_grant", error_description: "aud" });
    if (!(claims.exp > claims.iat) || claims.exp - claims.iat > 3600) return json(400, { error: "invalid_grant", error_description: "exp" });
    const access = `tok-${++this.issued}`;
    this.tokens.add(access);
    return json(200, { access_token: access, expires_in: this.tokenTtl, token_type: "Bearer" });
  }

  /** Make every issued token invalid (to test the 401 -> refresh path). */
  revokeTokens(): void {
    this.tokens.clear();
  }

  // ------------------------------------------------------------ commit

  private commit(writes: Write[]): Response {
    if (!Array.isArray(writes) || writes.length === 0) return err(400, "writes required");
    const next = new Map(this.docs);
    for (const w of writes) {
      const name = w.update?.name;
      if (!name?.startsWith(this.root() + "/")) return err(400, "bad document name");
      const path = name.slice(this.root().length + 1);
      const existing = next.get(path);
      if (w.currentDocument?.exists === false && existing) return err(409, `Document already exists: ${name}`);
      if (w.currentDocument?.exists === true && !existing) return err(404, `No document to update: ${name}`);
      const fields = w.update?.fields ?? {};
      let doc: Fields;
      if (w.updateMask) {
        doc = { ...(existing ?? {}) };
        for (const f of w.updateMask.fieldPaths) {
          if (f in fields) doc[f] = fields[f];
          else delete doc[f];
        }
      } else doc = { ...fields };
      const transformed = new Set<string>();
      for (const t of w.updateTransforms ?? []) {
        if (w.updateMask?.fieldPaths.includes(t.fieldPath)) return err(400, `field ${t.fieldPath} is in both the update mask and the transforms`);
        if (transformed.has(t.fieldPath)) return err(400, `two transforms on ${t.fieldPath}`);
        transformed.add(t.fieldPath);
        const cur = numOf(doc[t.fieldPath]);
        if (t.increment) {
          const by = numOf(t.increment);
          if (by === undefined) return err(400, "increment needs a number");
          doc[t.fieldPath] = "doubleValue" in t.increment || (doc[t.fieldPath] && "doubleValue" in doc[t.fieldPath]) ? { doubleValue: (cur ?? 0) + by } : { integerValue: String((cur ?? 0) + by) };
        } else if (t.minimum || t.maximum) {
          const v = (t.minimum ?? t.maximum)!;
          const n = numOf(v);
          if (n === undefined) return err(400, "minimum / maximum need a number");
          if (cur === undefined) doc[t.fieldPath] = v;
          else doc[t.fieldPath] = (t.minimum ? n < cur : n > cur) ? v : doc[t.fieldPath];
        } else return err(400, `unsupported transform on ${t.fieldPath}`);
      }
      next.set(path, doc);
    }
    this.docs = next;
    return json(200, { writeResults: writes.map(() => ({ updateTime: "2026-01-01T00:00:00Z" })), commitTime: "2026-01-01T00:00:00Z" });
  }

  // -------------------------------------------------------------- reads

  private doc(path: string): { name: string; fields: Fields } {
    return { name: `${this.root()}/${path}`, fields: this.docs.get(path) ?? {} };
  }

  private children(collectionPath: string): string[] {
    const p = collectionPath + "/";
    return [...this.docs.keys()].filter((k) => k.startsWith(p) && !k.slice(p.length).includes("/")).sort();
  }

  private list(collectionPath: string, q: URLSearchParams): Response {
    const size = Number(q.get("pageSize") ?? 20);
    const start = Number(q.get("pageToken") ?? 0);
    const all = this.children(collectionPath);
    const page = all.slice(start, start + size);
    const more = start + size < all.length;
    return json(200, { ...(page.length ? { documents: page.map((k) => this.doc(k)) } : {}), ...(more ? { nextPageToken: String(start + size) } : {}) });
  }

  private runQuery(sq: Query): Response {
    const coll = sq.from?.[0]?.collectionId;
    if (!coll) return err(400, "from required");
    let keys = this.children(coll);
    const order = sq.orderBy?.[0];
    if (order) {
      const f = order.field.fieldPath;
      keys = keys.filter((k) => numOf(this.docs.get(k)?.[f]) !== undefined); // missing field: not in an ordered query
      keys.sort((a, b) => ((numOf(this.docs.get(a)![f]) ?? 0) - (numOf(this.docs.get(b)![f]) ?? 0)) * (order.direction === "DESCENDING" ? -1 : 1));
    }
    if (sq.limit !== undefined) keys = keys.slice(0, sq.limit);
    const onlyName = sq.select?.fields?.every((f) => f.fieldPath === "__name__");
    const rows = keys.map((k) => ({ document: onlyName ? { name: `${this.root()}/${k}` } : this.doc(k), readTime: "2026-01-01T00:00:00Z" }));
    return json(200, rows.length ? rows : [{ readTime: "2026-01-01T00:00:00Z" }]);
  }

  private aggregate(q: { structuredQuery: Query }): Response {
    const coll = q.structuredQuery.from?.[0]?.collectionId;
    if (!coll) return err(400, "from required");
    return json(200, [{ result: { aggregateFields: { n: { integerValue: String(this.children(coll).length) } } }, readTime: "2026-01-01T00:00:00Z" }]);
  }
}

interface Write {
  update?: { name: string; fields?: Fields };
  updateMask?: { fieldPaths: string[] };
  updateTransforms?: { fieldPath: string; increment?: Value; minimum?: Value; maximum?: Value }[];
  currentDocument?: { exists?: boolean };
}
interface Query {
  from?: { collectionId: string }[];
  orderBy?: { field: { fieldPath: string }; direction?: string }[];
  limit?: number;
  select?: { fields: { fieldPath: string }[] };
}
