/**
 * Append-only storage used by the proxy for recordings and logs.
 *
 * Keys look like `recordings/<sessionId>.jsonl` and `logs/<sessionId>.jsonl`.
 * Implementations: MemoryStore (tests), FileStore (node dev server, proxy/.data),
 * ChunkedObjectStore over Cloudflare KV or R2 (worker). All runtime-neutral
 * except FileStore, which lives in ./node/.
 */

export interface ProxyStore {
  /** Append text (normally whole JSONL lines, each ending in "\n") to `key`. */
  append(key: string, text: string): Promise<void>;
  /** Full contents of `key`, or null if nothing was ever appended. */
  read(key: string): Promise<string | null>;
}

export class MemoryStore implements ProxyStore {
  readonly data = new Map<string, string>();
  async append(key: string, text: string): Promise<void> {
    this.data.set(key, (this.data.get(key) ?? "") + text);
  }
  async read(key: string): Promise<string | null> {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  /** Parsed JSONL lines of `key` (test helper). */
  lines<T = unknown>(key: string): T[] {
    const s = this.data.get(key);
    if (!s) return [];
    return s
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  }
}

// ---------------------------------------------------------------------------
// Object-store backed (Cloudflare KV / R2). Neither supports atomic append, so
// every append writes its own chunk object `<key>/<time>-<seq>-<rand>` and
// read() concatenates the chunks in name order. No read-modify-write races.
// ---------------------------------------------------------------------------

/** The subset of an object store the proxy needs. */
export interface ObjectStoreLike {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  /** All keys with the prefix (implementations page internally). */
  list(prefix: string): Promise<string[]>;
}

export class ChunkedObjectStore implements ProxyStore {
  private seq = 0;
  constructor(
    private readonly objects: ObjectStoreLike,
    private readonly now: () => number = Date.now,
  ) {}

  async append(key: string, text: string): Promise<void> {
    const stamp = String(this.now()).padStart(15, "0");
    const seq = String(this.seq++ % 1_000_000).padStart(6, "0");
    const rand = Math.random().toString(36).slice(2, 8);
    await this.objects.put(`${key}/${stamp}-${seq}-${rand}`, text);
  }

  async read(key: string): Promise<string | null> {
    const names = (await this.objects.list(`${key}/`)).sort();
    if (names.length === 0) return null;
    const parts = await Promise.all(names.map((n) => this.objects.get(n)));
    return parts.map((p) => p ?? "").join("");
  }
}

/** Minimal structural type of a Cloudflare KV namespace binding. */
export interface KVNamespaceLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(opts: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export function kvObjects(kv: KVNamespaceLike): ObjectStoreLike {
  return {
    put: (k, v) => kv.put(k, v),
    get: (k) => kv.get(k, "text"),
    async list(prefix) {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const r = await kv.list({ prefix, cursor });
        for (const k of r.keys) out.push(k.name);
        if (r.list_complete || !r.cursor) break;
        cursor = r.cursor;
      }
      return out;
    },
  };
}

/** Minimal structural type of a Cloudflare R2 bucket binding. */
export interface R2BucketLike {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(opts: { prefix?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export function r2Objects(r2: R2BucketLike): ObjectStoreLike {
  return {
    async put(k, v) {
      await r2.put(k, v);
    },
    async get(k) {
      const o = await r2.get(k);
      return o ? o.text() : null;
    },
    async list(prefix) {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const r = await r2.list({ prefix, cursor });
        for (const o of r.objects) out.push(o.key);
        if (!r.truncated || !r.cursor) break;
        cursor = r.cursor;
      }
      return out;
    },
  };
}

/** Keys used by the proxy. sessionId must already be validated (isSafeSessionId). */
export const recordingKey = (sessionId: string) => `recordings/${sessionId}.jsonl`;
export const logKey = (sessionId: string) => `logs/${sessionId}.jsonl`;
export const rejectedLogKey = (sessionId: string) => `logs/${sessionId}.rejected.jsonl`;

/** Session ids become file/object names: letters, digits, dot, dash, underscore; no "..". */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
}
