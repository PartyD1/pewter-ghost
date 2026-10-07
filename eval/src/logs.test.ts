import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { levelFor } from "./cases";
import { renderDashboard } from "./dashboard";
import { dedupe, exportJsonl, exportLine, pairsFromLogs, pairsFromRun } from "./export";
import { acceptanceByRequest, ghostsOf, hashPrefixOf, loadSessions, parseLog, type SessionLog } from "./logs";
import { computeMetrics } from "./metrics";
import { calibrate, calibrationMarkdown } from "./calibration";
import { quickCases, scriptedSession } from "./__fixtures__/fakes";
import type { CaseResult } from "./types";

async function fixture(): Promise<{ session: SessionLog; cases: Awaited<ReturnType<typeof quickCases>> }> {
  const cases = await quickCases(["stairs-up-2wide", "gap-run-3", "pillar-hop"]);
  const { events, recordings } = scriptedSession(cases);
  return { session: { sessionId: "s1", events, recordings, bad: 0 }, cases };
}

describe("logs", () => {
  it("parses JSONL logs and loads sessions with their recordings", async () => {
    const { session } = await fixture();
    const dir = mkdtempSync(path.join(os.tmpdir(), "eval-logs-"));
    mkdirSync(path.join(dir, "logs"));
    mkdirSync(path.join(dir, "recordings"));
    writeFileSync(path.join(dir, "logs", "s1.jsonl"), session.events.map((e) => JSON.stringify(e)).join("\n") + "\n{bad\n" + JSON.stringify({ type: "nope" }) + "\n");
    writeFileSync(path.join(dir, "logs", "s1.rejected.jsonl"), "{}\n");
    writeFileSync(path.join(dir, "recordings", "s1.jsonl"), session.recordings.map((r) => JSON.stringify(r)).join("\n"));
    const [s] = loadSessions([path.join(dir, "logs")], [path.join(dir, "recordings")]);
    expect(s.sessionId).toBe("s1");
    expect(s.events).toHaveLength(session.events.length);
    expect(s.bad).toBe(2);
    expect(s.recordings).toHaveLength(3);
    expect(parseLog("").events).toEqual([]);
  });

  it("joins ghosts to recordings, tags them and finds hand repair", async () => {
    const { session, cases } = await fixture();
    expect(hashPrefixOf(`llm-1-${cases[0].requestHash.slice(0, 8)}`)).toBe(cases[0].requestHash.slice(0, 8));
    expect(hashPrefixOf("stub-1")).toBeUndefined();
    const gs = ghostsOf(session);
    expect(gs.map((g) => g.outcome)).toEqual(["accepted", "drawn-over", "partial"]);
    expect(gs.every((g) => g.recording && g.levelCells?.length === 1)).toBe(true);
    expect(gs[0].repaired).toBe(true); // erased its cell 10 s after accepting
    expect(gs[2].repaired).toBe(false);
    expect(gs[1].repaired).toBeUndefined();
    expect(Array.isArray(gs[0].tags)).toBe(true);
    const acc = acceptanceByRequest([session]);
    expect(acc.get(cases[0].requestHash)).toBe(true);
    expect(acc.get(cases[1].requestHash)).toBe(false);
  });
});

describe("metrics and dashboard (G-29)", () => {
  it("computes the development signals", async () => {
    const { session, cases } = await fixture();
    const m = computeMetrics([session], [{ group: "ghost", levels: cases.map((c) => ({ name: c.id, level: levelFor(c) })) }], {
      survey: [{ sessionId: "s1", idea: true, feel: "fine", annoyed: "the coin arc" }],
    });
    expect(m.ghosts).toBe(3);
    expect(m.acceptance).toEqual({ n: 3, hits: 2, rate: 2 / 3 });
    expect(m.byKind.finish).toMatchObject({ n: 3, hits: 2, outcomes: { accepted: 1, "drawn-over": 1, partial: 1 } });
    expect(m.byBand.map((b) => b.r.n)).toEqual([1, 1, 1]);
    expect(m.byBand[2].r.rate).toBe(1);
    expect(m.drawnOver.hits).toBe(1);
    expect(m.drawnOverByMinute.map((x) => x.minute)).toEqual([0, 1, 2]);
    // fill.call: 3 verdicted acts; first try = ok and no send-back -> 2/4 verdicted (c1, c3 ok; c2 sent back; d agent fail)
    expect(m.verifiedFirstTry).toEqual({ n: 4, hits: 2, rate: 0.5 });
    expect(m.sendBackPass).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.dropForTime).toMatchObject({ n: 5, hits: 1 });
    expect(m.dropForVerify).toMatchObject({ n: 4, hits: 1 });
    expect(m.latency.n).toBe(4);
    expect(m.handRepair).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(m.sessions[0]).toMatchObject({ sessionId: "s1", filler: "llm", shown: 3, accepted: 2, saves: 1, beatableAtEnd: true });
    expect(m.levels[0]).toMatchObject({ group: "ghost", levels: 3 });
    expect(m.levels[0].diversity).toBeGreaterThan(0);
    expect(m.survey?.ideaYes.rate).toBe(1);
  });

  it("renders a stable static page (snapshot)", async () => {
    const { session, cases } = await fixture();
    const m = computeMetrics([session], [{ group: "ghost", levels: cases.map((c) => ({ name: c.id, level: levelFor(c) })) }]);
    const html = renderDashboard(m);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Ghost Dogfood Dashboard</title>");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).not.toMatch(/<script/);
    expect(html).toMatchSnapshot();
    // Empty logs still render.
    expect(renderDashboard(computeMetrics([]))).toContain("0 session(s)");
  });
});

describe("export (G-38)", () => {
  it("exports accepted pairs in the gemini, openai and raw formats", async () => {
    const { session } = await fixture();
    const pairs = pairsFromLogs([session]);
    expect(pairs.map((p) => p.source)).toEqual(["accepted"]);
    expect(pairsFromLogs([session], { includePartial: true }).map((p) => p.source)).toEqual(["accepted", "partial"]);
    const g = JSON.parse(exportLine(pairs[0]));
    expect(g.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model"]);
    expect(JSON.parse(g.contents[1].parts[0].text)).toEqual(pairs[0].answer);
    expect(g.systemInstruction.parts[0].text.length).toBeGreaterThan(1000);
    expect(JSON.parse(exportLine(pairs[0], { system: "none" })).systemInstruction).toBeUndefined();
    const o = JSON.parse(exportLine(pairs[0], { format: "openai" }));
    expect(o.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant"]);
    const raw = JSON.parse(exportLine(pairs[0], { format: "raw" }));
    expect(raw).toMatchObject({ source: "accepted", sessionId: "s1", requestHash: pairs[0].requestHash });
    expect(exportJsonl([...pairs, ...pairs]).trim().split("\n")).toHaveLength(1);
    expect(dedupe([...pairs, ...pairs])).toHaveLength(1);
    expect(exportJsonl([])).toBe("");
  });

  it("exports suite answers that verified first try", async () => {
    const { cases, session } = await fixture();
    const answer = session.recordings[0].answer;
    const run = {
      promptVersion: "p",
      config: { model: "m" },
      cases: [
        { id: cases[0].id, sessionId: "x", requestHash: cases[0].requestHash, firstTryOk: true, answer },
        { id: cases[1].id, sessionId: "x", requestHash: cases[1].requestHash, firstTryOk: false, answer },
      ],
    };
    const pairs = pairsFromRun(run, new Map(cases.map((c) => [c.id, c.request])));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ source: "suite", model: "m" });
  });
});

describe("calibrate (G-27)", () => {
  const r = (i: number, stated: number, twoSample: number, ok: boolean): CaseResult => ({
    id: `c${i}`, sessionId: "s", seq: i, mode: "auto", requestHash: `h${i}`, latencyMs: 1, schemaOk: true, act: true, cells: 1, dropped: 0,
    firstTryOk: ok, confidence: { stated, twoSample },
  });

  it("compares sources and picks the steepest", () => {
    // twoSample ranks perfectly; stated is flat.
    const results = Array.from({ length: 12 }, (_, i) => r(i, 0.8, i < 6 ? 0.1 + i * 0.01 : 0.8 + i * 0.01, i >= 6));
    const rep = calibrate(results);
    expect(rep.labelSource).toBe("verified");
    expect(rep.pick).toBe("twoSample");
    expect(rep.sources.find((s) => s.source === "logprob")!.n).toBe(0);
    expect(rep.sources.find((s) => s.source === "twoSample")!.stats.auc).toBe(1);
    expect(rep.meetsTarget).toBe(true);
    const md = calibrationMarkdown(rep);
    expect(md).toContain("twoSample (pick)");
    expect(md).toContain("No log-probabilities");
  });

  it("prefers acceptance from the logs when joined", () => {
    const results = [r(0, 0.9, 0.9, false), r(1, 0.1, 0.1, true)];
    const rep = calibrate(results, { labels: new Map([["h0", true], ["h1", false]]), minN: 1 });
    expect(rep.labelSource).toBe("logs");
    expect(rep.sources[0].stats.auc).toBe(1);
  });
});
