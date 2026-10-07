import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "./node/fileStore";
import { ChunkedObjectStore, isSafeSessionId, kvObjects, MemoryStore, r2Objects, type KVNamespaceLike, type R2BucketLike } from "./store";

function fakeKV(pageSize = 2): KVNamespaceLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(k) {
      return map.get(k) ?? null;
    },
    async put(k, v) {
      map.set(k, v);
    },
    async list({ prefix = "", cursor }) {
      const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + pageSize);
      const done = start + pageSize >= all.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + pageSize) };
    },
  };
}

function fakeR2(): R2BucketLike {
  const map = new Map<string, string>();
  return {
    async put(k, v) {
      map.set(k, v);
    },
    async get(k) {
      const v = map.get(k);
      return v === undefined ? null : { text: async () => v };
    },
    async list({ prefix = "" }) {
      return { objects: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

describe("MemoryStore", () => {
  it("appends and reads", async () => {
    const s = new MemoryStore();
    expect(await s.read("a")).toBeNull();
    await s.append("a", '{"x":1}\n');
    await s.append("a", '{"x":2}\n');
    expect(s.lines("a")).toEqual([{ x: 1 }, { x: 2 }]);
  });
});

describe("ChunkedObjectStore", () => {
  it("over KV: chunks per append, read concatenates in order across pages", async () => {
    const kv = fakeKV(2);
    let t = 1000;
    const s = new ChunkedObjectStore(kvObjects(kv), () => t++);
    for (let i = 0; i < 5; i++) await s.append("recordings/s1.jsonl", `${i}\n`);
    await s.append("recordings/s10.jsonl", "other\n");
    expect(kv.map.size).toBe(6);
    expect(await s.read("recordings/s1.jsonl")).toBe("0\n1\n2\n3\n4\n");
    expect(await s.read("recordings/none.jsonl")).toBeNull();
  });
  it("over R2", async () => {
    const s = new ChunkedObjectStore(r2Objects(fakeR2()));
    await s.append("logs/a.jsonl", "x\n");
    await s.append("logs/a.jsonl", "y\n");
    expect(await s.read("logs/a.jsonl")).toBe("x\ny\n");
  });
});

describe("FileStore", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("appends lines without interleaving under concurrency", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pg-store-"));
    const s = new FileStore(dir);
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.append("recordings/s1.jsonl", JSON.stringify({ i }) + "\n")));
    const text = await readFile(path.join(dir, "recordings", "s1.jsonl"), "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l).i);
    expect(lines).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(await s.read("recordings/s1.jsonl")).toBe(text);
    expect(await s.read("recordings/missing.jsonl")).toBeNull();
  });

  it("refuses keys that escape the root", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pg-store-"));
    const s = new FileStore(dir);
    await expect(s.append("../x", "a")).rejects.toThrow(/unsafe/);
    await expect(s.append("a/../../x", "a")).rejects.toThrow(/unsafe/);
    await expect(s.append("/etc/passwd", "a")).rejects.toThrow(/unsafe/);
  });
});

describe("isSafeSessionId", () => {
  it.each([
    ["p01", true],
    ["dev.20261007-abc", true],
    ["t-0123abcd_x", true],
    ["", false],
    [".hidden", false],
    ["a/b", false],
    ["a..b", false],
    ["x".repeat(129), false],
    [42, false],
  ])("%s -> %s", (id, ok) => expect(isSafeSessionId(id)).toBe(ok));
});
