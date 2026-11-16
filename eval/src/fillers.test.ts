import { AgentClient } from "@physsim";
import { afterAll, describe, expect, it } from "vitest";
import { quickCases } from "./__fixtures__/fakes";
import { isLocalFiller } from "./fillers";
import { DEFAULT_RUN_CONFIG, runSuite } from "./run";
import type { RunConfig } from "./types";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());

const cfg = (model: string): RunConfig => ({ ...DEFAULT_RUN_CONFIG, model, name: model });

describe("runSuite with a filler that makes no model call", () => {
  it("knows which names are local fillers", () => {
    expect(isLocalFiller("algo")).toBe(true);
    expect(isLocalFiller("markov")).toBe(true);
    expect(isLocalFiller("gemini-3.7-flash")).toBe(false);
    expect(isLocalFiller("recorded")).toBe(false);
  });

  it("algo: scores its answers like a model's, with no caller", async () => {
    const cases = await quickCases(["stairs-up-2wide", "gap-run-3", "erasing"]);
    const run = await runSuite(cases, cfg("algo"), { agent });
    expect(run.cases).toHaveLength(3);
    expect(run.promptVersion).toBe("algo");
    const stairs = run.cases.find((r) => r.id === "stairs-up-2wide")!;
    expect(stairs.schemaOk).toBe(true);
    expect(stairs.act).toBe(true);
    expect(stairs.kind).toBe("finish");
    expect(stairs.firstTryOk).toBe(true);
    expect(stairs.label!.split(" ").length).toBeLessThanOrEqual(8);
    expect(stairs.label).not.toMatch(/^(finish|repeat|extend)\b/);
    for (const r of run.cases) {
      expect(r.schemaOk, r.id).toBe(true);
      expect(r.latencyMs).toBeLessThan(1000);
    }
    expect(run.summary.schemaOk).toBe(1);
  });

  it("markov: runs too", async () => {
    const cases = await quickCases(["gap-run-3"]);
    const run = await runSuite(cases, cfg("markov"), { agent });
    expect(run.cases[0].schemaOk).toBe(true);
  });
});
