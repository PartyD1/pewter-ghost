import { describe, expect, it } from "vitest";
import { idTimestamp, listSessionSummaries, summarizeLog } from "./summary";
import { MemoryStore, logKey, rejectedLogKey } from "./store";

const jl = (...e: object[]) => e.map((x) => JSON.stringify(x)).join("\n") + "\n";

describe("idTimestamp", () => {
  it("reads the stamp of a dev session id as UTC", () => {
    expect(idTimestamp("dev.20261008011127-iqje83")).toBe(Date.UTC(2026, 9, 8, 1, 11, 27));
    expect(idTimestamp("p07")).toBeUndefined();
    expect(idTimestamp("dev.nope")).toBeUndefined();
  });
});

describe("summarizeLog", () => {
  it("measures length, counts events and spots replay data", () => {
    const s = summarizeLog(
      "p01",
      jl(
        { type: "session", t: 1000, filler: "llm", startedAt: 1_760_000_000_000 },
        { type: "snapshot", t: 1100 },
        { type: "pointer.path", t: 2000, dt: [0, 500, 1500], x: [1, 2, 3], y: [1, 2, 3] },
        { type: "key", t: 3000, code: "KeyZ", down: true },
      ),
    );
    expect(s).toMatchObject({ sessionId: "p01", events: 4, durationMs: 2500, hasReplay: true, filler: "llm", startedAt: 1_760_000_000_000 });
    expect(s.bytes).toBeGreaterThan(100);
  });

  it("a log from before replay existed is flagged as having none", () => {
    const s = summarizeLog("dev.20261008011131-hvspul", jl({ type: "session", t: 286, filler: "llm" }, { type: "patrol", t: 3296, beatable: true, ms: 8 }));
    expect(s.hasReplay).toBe(false);
    expect(s.durationMs).toBe(3010);
    expect(s.startedAt).toBe(Date.UTC(2026, 9, 8, 1, 11, 31)); // from the id
  });

  it("skips junk lines and handles an empty log", () => {
    expect(summarizeLog("x", "not json\n{}\n{\"type\":\"key\"}\n").events).toBe(0);
    expect(summarizeLog("x", "")).toMatchObject({ events: 0, durationMs: 0, hasReplay: false });
  });
});

describe("listSessionSummaries", () => {
  it("lists newest first, ignores rejected-event files, and reports the total", async () => {
    const store = new MemoryStore();
    await store.append(logKey("dev.20261008000000-aaaaaa"), jl({ type: "session", t: 0, filler: "llm" }));
    await store.append(logKey("dev.20261105000000-bbbbbb"), jl({ type: "session", t: 0, filler: "llm" }, { type: "snapshot", t: 5 }));
    await store.append(logKey("p01"), jl({ type: "session", t: 0, filler: "llm", startedAt: Date.UTC(2026, 10, 1) }));
    await store.append(rejectedLogKey("p01"), '{"error":"x"}\n');
    const { sessions, total } = await listSessionSummaries(store);
    expect(sessions.map((s) => s.sessionId)).toEqual(["dev.20261105000000-bbbbbb", "p01", "dev.20261008000000-aaaaaa"]);
    expect(total).toBe(3);
  });

  it("reads only the newest `limit` logs but still reports every session in the total", async () => {
    const store = new MemoryStore();
    for (let d = 1; d <= 20; d++) await store.append(logKey(`dev.202611${String(d).padStart(2, "0")}000000-x`), jl({ type: "session", t: 0 }));
    const { sessions, total } = await listSessionSummaries(store, 5);
    expect(sessions).toHaveLength(5);
    expect(total).toBe(20);
    expect(sessions[0].sessionId).toBe("dev.20261120000000-x");
  });
});
