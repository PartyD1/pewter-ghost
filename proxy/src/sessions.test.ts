import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileTokenStore } from "./node/fileTokens";
import { TokenBucketLimiter } from "./rateLimit";
import {
  ChainTokenStore,
  generateToken,
  isWellFormedToken,
  parseTokenFile,
  sessionBelongsTo,
  sessionResponse,
  StaticTokenStore,
  tokenActive,
} from "./sessions";
import { runTokenCommand } from "./tokens-cli";

describe("token store", () => {
  it("looks up configured tokens and applies defaults", async () => {
    const s = new StaticTokenStore({ tokens: { abcdef: {}, ghijkl: { condition: "none", sessionId: "p9", overrides: { pauseMs: 1 } } } });
    const a = await s.lookup("abcdef");
    expect(a).toMatchObject({ condition: "llm", overrides: {} });
    expect(a!.sessionId).toMatch(/^t-[0-9a-f]{12}$/);
    expect(await s.lookup("ghijkl")).toMatchObject({ condition: "none", sessionId: "p9", overrides: { pauseMs: 1 } });
    expect(await s.lookup("missing")).toBeNull();
    expect(await s.lookup("dev")).toBeNull();
    expect(await s.lookup("toString")).toBeNull();
    expect(await s.lookup("bad token!")).toBeNull();
  });

  it("rejects entries with unknown conditions or unsafe session ids", async () => {
    const s = new StaticTokenStore({ tokens: { aaaaaa: { condition: "magic" as never }, bbbbbb: { sessionId: "../x" } } });
    expect(await s.lookup("aaaaaa")).toBeNull();
    expect(await s.lookup("bbbbbb")).toBeNull();
  });

  it("open mode accepts the dev token", async () => {
    const info = await new StaticTokenStore({ tokens: {} }, true).lookup("dev");
    expect(info).toMatchObject({ dev: true, condition: "llm" });
    expect(sessionResponse(info!, () => "abc").sessionId).toBe("dev.abc");
    expect(sessionBelongsTo(info!, "anything-safe")).toBe(true);
    expect(sessionBelongsTo(info!, "../no")).toBe(false);
  });

  it("expiry and revocation", async () => {
    const s = new StaticTokenStore({ tokens: { aaaaaa: { expiresAt: "2026-01-01T00:00:00Z" }, bbbbbb: { disabled: true } } });
    const a = (await s.lookup("aaaaaa"))!;
    expect(tokenActive(a, Date.parse("2025-12-31"))).toBe(true);
    expect(tokenActive(a, Date.parse("2026-01-02"))).toBe(false);
    expect(tokenActive((await s.lookup("bbbbbb"))!, 0)).toBe(false);
  });

  it("chain store: first hit wins", async () => {
    const c = new ChainTokenStore([
      new StaticTokenStore({ tokens: { aaaaaa: { condition: "algo" } } }),
      new StaticTokenStore({ tokens: { aaaaaa: { condition: "none" }, cccccc: { condition: "stub" } } }),
    ]);
    expect((await c.lookup("aaaaaa"))!.condition).toBe("algo");
    expect((await c.lookup("cccccc"))!.condition).toBe("stub");
  });

  it("parseTokenFile validates the shape", () => {
    expect(parseTokenFile('{"tokens":{}}')).toEqual({ tokens: {} });
    expect(() => parseTokenFile("[]")).toThrow();
    expect(() => parseTokenFile('{"tokens":[]}')).toThrow();
  });

  it("generated tokens are well formed and distinct", () => {
    const a = generateToken();
    expect(isWellFormedToken(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(generateToken()).not.toBe(a);
  });

  it("FileTokenStore reloads when the file changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pg-tok-"));
    try {
      const file = path.join(dir, "tokens.json");
      const s = new FileTokenStore(file);
      expect(await s.lookup("abcdef")).toBeNull();
      await writeFile(file, JSON.stringify({ tokens: { abcdef: { condition: "algo" } } }));
      expect((await s.lookup("abcdef"))!.condition).toBe("algo");
      await writeFile(file, JSON.stringify({ tokens: { abcdef: { condition: "none" } } }));
      const later = new Date(Date.now() + 5000);
      await utimes(file, later, later);
      expect((await s.lookup("abcdef"))!.condition).toBe("none");
      const errors: string[] = [];
      const broken = new FileTokenStore(file, false, (m) => errors.push(m));
      await writeFile(file, "{oops");
      await utimes(file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
      expect(await broken.lookup("abcdef")).toBeNull();
      expect(errors[0]).toMatch(/unreadable/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TokenBucketLimiter", () => {
  it("allows a burst then refills at the configured rate", () => {
    const l = new TokenBucketLimiter({ capacity: 2, perMinute: 60 });
    expect(l.take("a", 0).ok).toBe(true);
    expect(l.take("a", 0).ok).toBe(true);
    const r = l.take("a", 0);
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBe(1000);
    expect(l.take("b", 0).ok).toBe(true);
    expect(l.take("a", 999).ok).toBe(false);
    expect(l.take("a", 2000).ok).toBe(true);
  });
  it("never exceeds capacity after idle time and evicts when full", () => {
    const l = new TokenBucketLimiter({ capacity: 3, perMinute: 60 }, 2);
    l.take("a", 0);
    expect(l.take("a", 10 * 60_000).remaining).toBe(2);
    l.take("b", 0);
    l.take("c", 0); // evicts something; must not throw
    expect(l.take("c", 0).ok).toBe(true);
  });
  it("rejects nonsense config", () => {
    expect(() => new TokenBucketLimiter({ capacity: 0, perMinute: 1 })).toThrow();
  });
});

describe("tokens-cli", () => {
  let n = 0;
  const mint = () => `tok_${++n}_xyz`;

  it("add writes entries and prints launcher URLs", () => {
    const r = runTokenCommand(
      ["add", "--condition", "algo", "--count", "2", "--label", "pilot", "--overrides", '{"pauseMs":900}', "--editor", "https://lab.example/editor/"],
      { tokens: {} },
      mint,
    );
    expect(r.changed).toBe(true);
    const toks = Object.keys(r.file.tokens);
    expect(toks).toHaveLength(2);
    expect(r.file.tokens[toks[0]]).toEqual({ condition: "algo", label: "pilot-1", overrides: { pauseMs: 900 } });
    expect(r.out[0]).toContain(`https://lab.example/editor/?token=${toks[0]}`);
  });

  it("validates arguments", () => {
    expect(() => runTokenCommand(["add", "--condition", "magic"], { tokens: {} }, mint)).toThrow(/condition/);
    expect(() => runTokenCommand(["add", "--count", "0"], { tokens: {} }, mint)).toThrow(/count/);
    expect(() => runTokenCommand(["add", "--session", "a/b"], { tokens: {} }, mint)).toThrow(/session/);
    expect(() => runTokenCommand(["add", "--overrides", "[1]"], { tokens: {} }, mint)).toThrow(/overrides/);
    expect(() => runTokenCommand(["frobnicate"], { tokens: {} }, mint)).toThrow(/usage/);
  });

  it("list, revoke, export", () => {
    const file = { tokens: { abcdef: { condition: "llm" as const, label: "x" } } };
    expect(runTokenCommand(["list"], file).out[0]).toContain("abcdef");
    const r = runTokenCommand(["revoke", "abcdef"], file);
    expect(r.file.tokens.abcdef.disabled).toBe(true);
    expect(file.tokens.abcdef).not.toHaveProperty("disabled");
    expect(JSON.parse(runTokenCommand(["export"], file).out[0])).toEqual(file);
    expect(() => runTokenCommand(["revoke", "nope"], file)).toThrow();
  });
});
