import { describe, expect, it } from "vitest";
import { AuthError, fetchSessionLog, listSessions, parseHash, shareLink } from "./source";

const reply = (status: number, body: unknown, text = false) => async () =>
  new Response(text ? String(body) : JSON.stringify(body), { status });

describe("source", () => {
  it("lists sessions with the bearer password", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const f = async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("Authorization") };
      return new Response(JSON.stringify({ sessions: [{ sessionId: "p01", bytes: 10 }] }));
    };
    expect(await listSessions("http://x/", "pw", f)).toEqual({ sessions: [{ sessionId: "p01", bytes: 10 }], total: 1 });
    expect(seen).toEqual({ url: "http://x/replay/sessions", auth: "Bearer pw" });
  });

  it("fetches a log, encoding the id", async () => {
    let url = "";
    const f = async (u: string) => ((url = u), new Response("a\nb\n"));
    expect(await fetchSessionLog("http://x", "p 1", "pw", f)).toBe("a\nb\n");
    expect(url).toBe("http://x/replay/sessions/p%201");
  });

  it("maps failures to clear errors", async () => {
    await expect(listSessions("http://x", "bad", reply(401, {}))).rejects.toBeInstanceOf(AuthError);
    await expect(listSessions("http://x", "bad", reply(403, {}))).rejects.toBeInstanceOf(AuthError);
    await expect(fetchSessionLog("http://x", "p9", "pw", reply(404, {}))).rejects.toThrow("no such session");
    await expect(listSessions("http://x", "pw", reply(503, {}))).rejects.toThrow("not enabled");
    await expect(listSessions("http://x", "pw", reply(500, {}))).rejects.toThrow("500");
    await expect(
      listSessions("http://x", "pw", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("could not reach");
  });

  it("builds and parses share links", () => {
    const link = shareLink("https://lab.github.io/pewter/replay.html?old=1#zzz", "https://proxy.example/", "P07");
    expect(link).toBe("https://lab.github.io/pewter/replay.html?api=https%3A%2F%2Fproxy.example&P07".replace("&P07", "#P07"));
    expect(shareLink("https://a/replay.html", "https://p", "P07", 12_345.6)).toContain("#P07@12346");
    expect(parseHash("#P07@12346")).toEqual({ sessionId: "P07", t: 12346 });
    expect(parseHash("#P07")).toEqual({ sessionId: "P07", t: 0 });
    expect(parseHash("")).toBeNull();
    expect(parseHash("#../etc/passwd")).toBeNull();
  });
});
