import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../apps/editor/src/contracts";
import { FakeUpstream, fakeParse, fakeRender } from "./__fixtures__/fakes";
import { FakeFirestore } from "./__fixtures__/fakeFirestore";
import { FirestoreClient, FirestoreError, FirestoreStore, MAX_CHUNK_BYTES, signAssertion, splitLines } from "./firestore";
import { createHandler } from "./handler";
import { StaticTokenStore } from "./sessions";
import { MemoryStore, logKey, recordingKey, rejectedLogKey } from "./store";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const sa = { project_id: "pg-test", client_email: "proxy@pg-test.iam.gserviceaccount.com", private_key: privateKeyPem };

const jl = (...e: object[]) => e.map((x) => JSON.stringify(x)).join("\n") + "\n";

function setup(over: { now?: () => number; ttl?: number } = {}) {
  const fake = new FakeFirestore("pg-test", { publicKeyPem, clientEmail: sa.client_email });
  if (over.ttl !== undefined) fake.tokenTtl = over.ttl;
  const db = new FirestoreClient({ projectId: "pg-test", credentials: sa, fetch: fake.fetch as typeof fetch, now: over.now });
  const inner = new MemoryStore();
  let t = 1_790_000_000_000;
  const store = new FirestoreStore(db, { inner, now: () => t++ });
  return { fake, db, inner, store };
}

describe("signAssertion", () => {
  it("makes an RS256 JWT with the service account, scope and a one-hour life", async () => {
    const jwt = await signAssertion(sa, 1_000);
    const [h, c] = jwt.split(".").slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url").toString()));
    expect(h).toEqual({ alg: "RS256", typ: "JWT" });
    expect(c).toEqual({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: 1_000, exp: 4_600 });
  });
});

describe("FirestoreClient auth", () => {
  it("asks Google for one token and reuses it", async () => {
    const { fake, db } = setup();
    await db.count("sessions");
    await db.count("sessions");
    expect(fake.tokenCalls).toBe(1);
  });

  it("gets a fresh token when it is about to expire", async () => {
    let now = 1_790_000_000_000;
    const { fake, db } = setup({ now: () => now, ttl: 300 });
    await db.count("sessions");
    now += 200_000; // 100 s left, still fine
    await db.count("sessions");
    expect(fake.tokenCalls).toBe(1);
    now += 100_000; // under the 60 s margin
    await db.count("sessions");
    expect(fake.tokenCalls).toBe(2);
  });

  it("recovers from a rejected token with one refresh", async () => {
    const { fake, db } = setup();
    await db.count("sessions");
    fake.revokeTokens();
    await expect(db.count("sessions")).resolves.toBe(0);
    expect(fake.tokenCalls).toBe(2);
  });

  it("reports a service account Google rejects, without leaking the key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fake = new FakeFirestore("pg-test", { publicKeyPem, clientEmail: sa.client_email });
    const db = new FirestoreClient({ projectId: "pg-test", credentials: { ...sa, private_key: other }, fetch: fake.fetch as typeof fetch });
    const e = await db.count("sessions").catch((x) => x);
    expect(e).toBeInstanceOf(FirestoreError);
    expect(e.status).toBe(400);
    expect(e.message).toContain("rejected the service account");
    expect(e.message).not.toContain("PRIVATE KEY");
  });

  it("retries a busy answer, then gives up with a clear error", async () => {
    const { fake, db } = setup();
    fake.failNext = [503];
    await expect(db.count("sessions")).resolves.toBe(0);
    fake.failNext = [503, 503, 503];
    const e = await db.count("sessions").catch((x) => x);
    expect(e).toBeInstanceOf(FirestoreError);
    expect(e.status).toBe(503);
  });

  it("with the emulator: no token, no credentials needed", async () => {
    const fake = new FakeFirestore("pg-test", { emulator: true });
    const db = new FirestoreClient({ projectId: "pg-test", emulatorHost: "127.0.0.1:8080", fetch: fake.fetch as typeof fetch });
    await db.count("sessions");
    expect(fake.tokenCalls).toBe(0);
    expect(db.base).toBe("http://127.0.0.1:8080/v1/projects/pg-test/databases/(default)/documents");
  });

  it("refuses to start with neither a service account nor the emulator", () => {
    expect(() => new FirestoreClient({ projectId: "x" })).toThrow(/service account/);
  });
});

describe("splitLines", () => {
  it("keeps whole lines and respects the byte limit", () => {
    expect(splitLines("a\nb\nc\n", 4)).toEqual(["a\nb\n", "c\n"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n\n")).toEqual([]);
    expect(splitLines("a\nb")).toEqual(["a\nb\n"]);
  });
  it("counts bytes, not characters", () => {
    expect(splitLines("é\né\n", 5)).toEqual(["é\n", "é\n"]); // 3 bytes each with the newline
  });
});

describe("FirestoreStore: session logs", () => {
  it("stores a log and reads it back in order across appends", async () => {
    const { store, fake } = setup();
    await store.append(logKey("p01"), jl({ type: "key", t: 1, code: "A", down: true }));
    await store.append(logKey("p01"), jl({ type: "key", t: 2, code: "A", down: false }, { type: "key", t: 3, code: "B", down: true }));
    expect(await store.read(logKey("p01"))).toBe(jl({ type: "key", t: 1, code: "A", down: true }, { type: "key", t: 2, code: "A", down: false }, { type: "key", t: 3, code: "B", down: true }));
    expect(await store.read(logKey("nope"))).toBeNull();
    // one summary document and one chunk per append
    expect([...fake.docs.keys()].filter((k) => k.startsWith("sessions/p01/chunks/"))).toHaveLength(2);
    expect(fake.docs.has("sessions/p01")).toBe(true);
  });

  it("keeps a summary the replay list can use without downloading anything", async () => {
    const { store } = setup();
    await store.append(logKey("p01"), jl({ type: "session", t: 1000, filler: "llm", startedAt: 1_700_000_000_000 }, { type: "key", t: 1500, code: "A", down: true }));
    await store.append(logKey("p01"), jl({ type: "snapshot", t: 1600 }, { type: "pointer.path", t: 2000, dt: [0, 800], x: [1, 2], y: [1, 2] }));
    const { sessions, total } = await store.summaries(10);
    expect(total).toBe(1);
    expect(sessions[0]).toMatchObject({ sessionId: "p01", events: 4, durationMs: 1800, startedAt: 1_700_000_000_000, hasReplay: true, filler: "llm" });
    expect(sessions[0].bytes).toBeGreaterThan(100);
  });

  it("flags a session with no replay data, and takes its date from a dev id", async () => {
    const { store } = setup();
    await store.append(logKey("dev.20261008011131-hvspul"), jl({ type: "session", t: 286, filler: "llm" }, { type: "patrol", t: 3296, beatable: true, ms: 8 }));
    const [s] = (await store.summaries(10)).sessions;
    expect(s).toMatchObject({ hasReplay: false, durationMs: 3010, startedAt: Date.UTC(2026, 9, 8, 1, 11, 31) });
  });

  it("lists newest first and caps the list, with the total from a count", async () => {
    const { store } = setup();
    for (const [id, at] of [["a", 1000], ["b", 3000], ["c", 2000], ["d", 4000]] as const) await store.append(logKey(id), jl({ type: "session", t: 0, filler: "x", startedAt: at }));
    const { sessions, total } = await store.summaries(3);
    expect(sessions.map((s) => s.sessionId)).toEqual(["d", "b", "c"]);
    expect(total).toBe(4);
  });

  it("a session that starts with a late batch keeps its true start", async () => {
    const { store } = setup();
    await store.append(logKey("p01"), jl({ type: "key", t: 9000, code: "A", down: true }));
    await store.append(logKey("p01"), jl({ type: "session", t: 100, filler: "llm", startedAt: 1000 }));
    const [s] = (await store.summaries(5)).sessions;
    expect(s.startedAt).toBe(1000);
    expect(s.durationMs).toBe(8900);
  });

  it("lists logical keys for the logs prefix only", async () => {
    const { store, inner } = setup();
    await store.append(logKey("p02"), jl({ type: "session", t: 0 }));
    await store.append(logKey("p01"), jl({ type: "session", t: 0 }));
    await inner.append(recordingKey("p01"), "x\n");
    expect(await store.list("logs/")).toEqual(["logs/p01.jsonl", "logs/p02.jsonl"]);
    expect(await store.list("recordings/")).toEqual(["recordings/p01.jsonl"]);
  });

  it("sends everything that is not a session log to the store it replaced", async () => {
    const { store, inner, fake } = setup();
    await store.append(recordingKey("p01"), '{"requestHash":"x"}\n');
    await store.append(rejectedLogKey("p01"), '{"error":"x"}\n');
    expect(await store.read(recordingKey("p01"))).toBe('{"requestHash":"x"}\n');
    expect(await inner.read(rejectedLogKey("p01"))).toBe('{"error":"x"}\n');
    expect(fake.docs.size).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it("splits a big batch across documents, each under Firestore's size limit", async () => {
    const { store, fake } = setup();
    const line = JSON.stringify({ type: "key", t: 1, code: "A".repeat(10_000), down: true });
    const big = (line + "\n").repeat(150); // ~1.5 MB
    await store.append(logKey("p01"), big);
    const chunks = [...fake.docs.entries()].filter(([k]) => k.startsWith("sessions/p01/chunks/"));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const [, f] of chunks) expect(new TextEncoder().encode((f.text as { stringValue: string }).stringValue).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    expect(await store.read(logKey("p01"))).toBe(big);
  });

  it("reads back a log that spans more than one page of chunks", async () => {
    const { store } = setup();
    const expected: string[] = [];
    for (let i = 0; i < 25; i++) {
      const l = jl({ type: "key", t: i, code: "A", down: true });
      expected.push(l);
      await store.append(logKey("p01"), l);
    }
    expect(await store.read(logKey("p01"))).toBe(expected.join(""));
  });

  it("ignores an empty append and surfaces a Firestore failure to the caller", async () => {
    const { store, fake } = setup();
    await store.append(logKey("p01"), "\n");
    expect(fake.requests).toEqual([]);
    fake.failNext = [403, 403, 403];
    await expect(store.append(logKey("p01"), jl({ type: "key", t: 1, code: "A", down: true }))).rejects.toThrow(/403/);
  });
});

describe("through the proxy: /log -> Firestore -> /replay", () => {
  const SECRET = "lab-secret";
  function proxy() {
    const { store, fake } = setup();
    const handler = createHandler({
      render: fakeRender,
      parse: fakeParse,
      upstream: new FakeUpstream(),
      store,
      tokens: new StaticTokenStore({ tokens: { tok_p01_abc: { condition: "none", sessionId: "p01" } } }, false),
      readSecret: SECRET,
    });
    const log = (events: LogEvent[]) =>
      handler(new Request("http://proxy.test/log", { method: "POST", headers: { Authorization: "Bearer tok_p01_abc", "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "p01", events }) }));
    const get = (path: string) => handler(new Request(`http://proxy.test${path}`, { headers: { Authorization: `Bearer ${SECRET}` } }));
    return { log, get, fake };
  }

  it("a participant's batches show up in the researcher's list and log", async () => {
    const { log, get, fake } = proxy();
    const a: LogEvent[] = [
      { type: "session", t: 500, sessionId: "p01", commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "none", config: {}, replay: 1, startedAt: 1_790_000_000_000 },
      { type: "focus", t: 510, focused: true },
    ];
    const b: LogEvent[] = [
      { type: "pointer.path", t: 2000, dt: [0, 40], x: [1, 2], y: [3, 4] },
      { type: "key", t: 6500, code: "KeyZ", down: true },
    ];
    expect(((await (await log(a)).json()) as { accepted: number }).accepted).toBe(2);
    await log(b);

    const list = (await (await get("/replay/sessions")).json()) as { sessions: { sessionId: string; durationMs: number; hasReplay: boolean; events: number }[]; total: number };
    expect(list.total).toBe(1);
    expect(list.sessions[0]).toMatchObject({ sessionId: "p01", events: 4, durationMs: 6000, hasReplay: true });

    const text = await (await get("/replay/sessions/p01")).text();
    expect(text.trim().split("\n").map((l) => JSON.parse(l))).toEqual([...a, ...b]);
    // The list was one query plus one count: it did not read any log.
    expect(fake.requests.filter((r) => r.path.includes("/chunks")).length).toBe(1); // only the log fetch above
  });
});
