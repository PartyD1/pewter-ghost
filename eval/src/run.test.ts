import { afterAll, describe, expect, it } from "vitest";
import { AgentClient } from "@physsim";
import type { FillRequest, ModelAnswer, RenderedPrompt } from "../../apps/editor/src/contracts";
import { answerJson } from "../../apps/editor/src/fill/prompt";
import { casesFromRecordings, requestFor } from "./cases";
import { UpstreamCaller } from "./live";
import { DEFAULT_RUN_CONFIG, recordedCall, renderFor, runSuite, samplesFor } from "./run";
import { compareReport, runReport } from "./report";
import { decline, FakeUpstream, levelCoordAnswer, nextToFrontier, quickCases, recordingFor } from "./__fixtures__/fakes";
import type { EvalCase, RunConfig } from "./types";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());

/** A fake model answering per request (looked up by the rendered user message). */
function fakeModel(cases: EvalCase[], cfg: RunConfig, answer: (req: FillRequest, call: number) => ModelAnswer | string) {
  const byUser = new Map<string, FillRequest>();
  for (const c of cases) {
    const r = requestFor(c, cfg)!;
    byUser.set(renderFor(r, cfg).user, r);
  }
  return new FakeUpstream("gemini-fake", (p: RenderedPrompt, _s, call) => {
    let req = byUser.get(p.user);
    if (!req) {
      // A send-back: the same request with previousFailure.
      for (const [u, r] of byUser) if (p.user.startsWith(u.slice(0, 200))) req = r;
    }
    if (!req) return null;
    const a = answer(req, call);
    return typeof a === "string" ? a : answerJson(a);
  });
}

const cfg = (o: Partial<RunConfig> = {}): RunConfig => ({ ...DEFAULT_RUN_CONFIG, model: "gemini-fake", name: "t", ...o });

describe("runSuite with a fake upstream", () => {
  it("scores schema, coordinates, verification, tags and latency", async () => {
    const cases = await quickCases(["stairs-up-2wide", "gap-run-3", "erasing"]);
    const c = cfg();
    const up = fakeModel(cases, c, (req) => (req.recent.some((r) => r.tool === "erase") ? decline : nextToFrontier(req)));
    const run = await runSuite(cases, c, { caller: new UpstreamCaller(up), agent });
    expect(run.cases).toHaveLength(3);
    const erasing = run.cases.find((r) => r.id === "erasing")!;
    expect(erasing).toMatchObject({ act: false, schemaOk: true, expectMet: true });
    const stairs = run.cases.find((r) => r.id === "stairs-up-2wide")!;
    expect(stairs.schemaOk).toBe(true);
    expect(stairs.act).toBe(true);
    expect(stairs.coord?.inWindow).toBe(1);
    expect(stairs.validatorStage).toBeDefined();
    expect(typeof stairs.firstTryOk).toBe("boolean");
    expect(stairs.confidence).toMatchObject({ stated: 0.8, used: 0.8 });
    expect(run.summary.schemaOk).toBe(1);
    expect(run.summary.acted).toBe(2);
    expect(run.summary.declined).toBe(1);
    expect(run.summary.promptTokens).toBe(1000);
    const md = runReport(run);
    expect(md).toContain("| Schema ok | 100.0% |");
    expect(md).toContain("erasing");
  });

  it("sends a failed answer back once and scores the second try", async () => {
    const cases = await quickCases(["gap-run-3"]);
    const c = cfg({ sendBack: "always" });
    // First answer: in level coordinates (nothing usable is left -> shape fail is pre-validator);
    // use an answer that lands on occupied terrain instead so the validator fails it.
    const up = fakeModel(cases, c, (req, call) =>
      call === 0 ? { ...nextToFrontier(req), adds: [{ x: req.frontier.x, y: req.frontier.y, tile: "grass" }] } : nextToFrontier(req),
    );
    const run = await runSuite(cases, c, { caller: new UpstreamCaller(up), agent });
    const r = run.cases[0];
    expect(r.firstTryOk).toBe(false);
    expect(r.firstStage).toBe("shape");
    expect(r.sendBack).toBe(true);
    expect(up.calls).toHaveLength(2);
    expect(up.calls[1].prompt.user).toContain(r.firstReason!.slice(0, 20));
    expect(run.summary.sendBacks).toBe(1);

    const never = await runSuite(cases, cfg({ sendBack: "never" }), { caller: new UpstreamCaller(fakeModel(cases, c, (req) => ({ ...nextToFrontier(req), adds: [{ x: req.frontier.x, y: req.frontier.y, tile: "grass" }] }))), agent });
    expect(never.cases[0].sendBack).toBe(false);
  });

  it("counts level-coordinate answers and schema misses", async () => {
    const cases = await quickCases(["gap-run-3", "pillar-hop"]);
    const c = cfg();
    const up = fakeModel(cases, c, (req) => (req.origin.x === cases[0].request.origin.x && req.grid === cases[0].request.grid ? levelCoordAnswer(req) : "{not json"));
    const run = await runSuite(cases, c, { caller: new UpstreamCaller(up), agent });
    const [a, b] = run.cases;
    expect(a.coord?.levelCoords).toBe(1);
    expect(a.firstTryOk).toBe(false);
    expect(b.schemaOk).toBe(false);
    expect(b.schemaError).toBe("not JSON");
    expect(run.summary.levelCoordItems).toBe(1);
    expect(run.summary.schemaOk).toBe(0.5);
  });

  it("twoSample confidence asks for two samples and uses their agreement", async () => {
    const cases = await quickCases(["stairs-up-1wide"]);
    const c = cfg({ confidenceSource: "twoSample", samples: 2 });
    expect(samplesFor(c)).toBe(2);
    const up = fakeModel(cases, c, (req) => nextToFrontier(req, 0.6));
    const run = await runSuite(cases, c, { caller: new UpstreamCaller(up), agent });
    expect(up.calls[0].samples).toBe(2);
    expect(run.cases[0].confidence).toMatchObject({ stated: 0.6, twoSample: 1, used: 1 });
  });

  it("skips cases it cannot rebuild and reports call errors", async () => {
    const [seed] = await quickCases(["gap-run-3"]);
    const [rec] = casesFromRecordings([recordingFor(seed, nextToFrontier(seed.request))]);
    const c = cfg({ window: { cols: 16, rows: 10 } });
    const up = new FakeUpstream("gemini-fake", () => new Error("boom"));
    const run = await runSuite([seed, rec], c, { caller: new UpstreamCaller(up, { retry: { retries: 0 } }), agent });
    expect(run.cases[1].skipped).toMatch(/cannot rebuild/);
    expect(run.cases[0].error).toMatch(/boom/);
    expect(run.summary).toMatchObject({ skipped: 1, errors: 1 });
  });
});

describe("recorded mode", () => {
  it("scores the stored answers without calling a model", async () => {
    const cs = await quickCases(["gap-run-3", "pillar-hop"]);
    const recs = casesFromRecordings([
      recordingFor(cs[0], nextToFrontier(cs[0].request), { t: "2026-01-01T00:00:01Z" }),
      recordingFor(cs[1], null, { t: "2026-01-01T00:00:02Z" }),
    ]);
    expect(recordedCall(recs[0])?.parsed).toHaveLength(1);
    const run = await runSuite([...recs, cs[0]], cfg({ model: "recorded" }), { agent });
    expect(run.cases[0]).toMatchObject({ schemaOk: true, act: true, latencyMs: 700 });
    expect(run.cases[1].schemaOk).toBe(false);
    expect(run.cases[2].skipped).toBe("no recorded answer");
    expect(run.promptVersion).toBe("fill.v1-test");
    await expect(runSuite(recs, cfg(), { agent })).rejects.toThrow(/caller/);
  });
});

describe("compareReport", () => {
  it("shows deltas and the ship gate", async () => {
    const cases = await quickCases(["gap-run-3", "pillar-hop"]);
    const c = cfg();
    const good = await runSuite(cases, { ...c, name: "A" }, { caller: new UpstreamCaller(fakeModel(cases, c, (r) => nextToFrontier(r))), agent });
    const bad = await runSuite(cases, { ...c, name: "B" }, { caller: new UpstreamCaller(fakeModel(cases, c, () => "nope")), agent });
    const md = compareReport(good, bad);
    expect(md).toContain("| Schema ok | 100.0% | 0.0% | -100.0 pt | worse |");
    expect(md).toMatch(/2 requests scored by both/);
    const same = compareReport(good, good);
    expect(same).toContain("Ship gate");
    expect(same).toContain("PASS");
  });
});
