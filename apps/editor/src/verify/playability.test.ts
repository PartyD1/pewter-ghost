import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { AgentClient, checkRules, type AgentQuery, type AgentResult } from "@physsim";
import { TILE } from "../contracts";
import { ents, GROUND, groundRows, H, modelFrom, rect, sugg } from "./__fixtures__/levels";
import { mergeSuggestion, solidGridOf } from "./merge";
import { verifyPlayability, type AgentLike } from "./playability";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());
const cfg = { agentCapMs: 300 };

/** Records queries; answers with a fixed result. */
function fakeAgent(result: Partial<AgentResult>): AgentLike & { queries: AgentQuery[] } {
  const queries: AgentQuery[] = [];
  return {
    queries,
    async verify(q) {
      queries.push(q);
      return { found: false, path: [], nodes: 0, ms: 0, timedOut: false, exhausted: false, ...result };
    },
  };
}

describe("verifyPlayability", () => {
  it("passes a beatable gap and returns the agent's route", async () => {
    const m = modelFrom(groundRows([[0, 19]]));
    const v = await verifyPlayability(m, sugg({ adds: rect(24, 31, GROUND, H - 1) }), agent, cfg);
    expect(v).toMatchObject({ ok: true, stage: "agent" });
    expect(v.path!.length).toBeGreaterThan(1);
    expect(v.section).toMatchObject({ from: { x: 19, y: GROUND - 1 }, goalInside: true });
    expect(v.section!.to.x0).toBe(31);
  });

  it("bounds the agent to the section plus two tiles each side, with the configured cap", async () => {
    const m = modelFrom(groundRows([[0, 19], [36, 47]]));
    const fake = fakeAgent({ found: true, path: [{ x: 19, y: 7 }] });
    const v = await verifyPlayability(m, sugg({ adds: rect(24, 31, GROUND, H - 1) }), fake, { agentCapMs: 123 });
    expect(v.ok).toBe(true);
    expect(fake.queries).toHaveLength(1);
    const q = fake.queries[0];
    expect(q.from).toEqual({ x: 19, y: 7 });
    expect(q.to).toEqual({ x0: 36, x1: 36 });
    expect(q.xRange).toEqual([17, 38]);
    expect(q.capMs).toBe(123);
  });

  it("fails at the rule check for a gap the knight cannot clear (agent not run)", async () => {
    const m = modelFrom(groundRows([[0, 19]]));
    const fake = fakeAgent({ found: true });
    const v = await verifyPlayability(m, sugg({ adds: rect(33, 40, GROUND, H - 1) }), fake, cfg);
    expect(v).toMatchObject({ ok: false, stage: "rules" });
    expect(v.reason).toMatch(/13 empty tiles away/);
    expect(fake.queries).toHaveLength(0);
  });

  it("fails at the agent when the rules are fooled (pit under a low tunnel)", async () => {
    // Pit 20..26 (7 wide), the suggestion adds a ceiling 2 tiles above the ground over it.
    const m = modelFrom(groundRows([[0, 19], [27, 47]]));
    const ceiling = rect(17, 28, 0, GROUND - 3, TILE.DIRT);
    const s = sugg({ adds: ceiling });
    const v = await verifyPlayability(m, s, agent, cfg);
    expect(v).toMatchObject({ ok: false, stage: "agent" });
    expect(v.reason).toBeTruthy();
    // The rules alone said yes.
    const grid = solidGridOf(mergeSuggestion(m.snapshot(), s));
    expect(checkRules(grid, v.section!.from, v.section!.to, { xRange: v.section!.xRange }).ok).toBe(true);
  });

  it("counts an agent run over the cap as a fail, with a reason for the model", async () => {
    const m = modelFrom(groundRows([[0, 19]]));
    const v = await verifyPlayability(
      m,
      sugg({ adds: rect(24, 31, GROUND, H - 1) }),
      fakeAgent({ timedOut: true, blockedAt: { x: 19, y: 7 } }),
      cfg,
    );
    expect(v).toMatchObject({ ok: false, stage: "agent", timedOut: true });
    expect(v.reason).toMatch(/within 300 ms; it got as far as \(19,7\)/);
  });

  it("verifies a fix on the repaired level: the repaired section must be beatable", async () => {
    // 14-wide pit (20..33): unbeatable as drawn.
    const m = modelFrom(groundRows([[0, 19], [34, 47]]));
    const bad = await verifyPlayability(m, sugg({ kind: "fix", adds: rect(21, 21, GROUND + 3, GROUND + 3) }), agent, cfg);
    expect(bad.ok).toBe(false);
    const good = await verifyPlayability(m, sugg({ kind: "fix", adds: rect(26, 28, GROUND - 1, GROUND - 1) }), agent, cfg);
    expect(good).toMatchObject({ ok: true, stage: "agent" });
    expect(good.section!.to.x0).toBe(34);
  });

  it("lets an entity-only suggestion over standable ground through", async () => {
    const m = modelFrom(groundRows([[0, 47]]));
    const v = await verifyPlayability(m, sugg({ entities: ents("coin", [[10, 5], [11, 4], [12, 5]]) }), agent, cfg);
    expect(v.ok).toBe(true);
  });

  it("rejects terrain nothing can stand on", async () => {
    const m = modelFrom(groundRows([], 48, 12));
    const v = await verifyPlayability(m, sugg({ adds: rect(10, 12, 0, 0) }), fakeAgent({}), cfg);
    expect(v).toMatchObject({ ok: false, stage: "rules" });
  });

  it("property: verified => the rule check passes on the section", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: -3, max: 4 }),
        fc.integer({ min: 2, max: 8 }),
        async (gap, rise, width) => {
          const m = modelFrom(groundRows([[0, 19]]));
          const x0 = 20 + gap;
          const top = GROUND - rise;
          const s = sugg({ adds: rect(x0, x0 + width - 1, top, H - 1) });
          const v = await verifyPlayability(m, s, agent, cfg);
          if (!v.ok) return;
          const grid = solidGridOf(mergeSuggestion(m.snapshot(), s));
          const sec = v.section!;
          expect(checkRules(grid, sec.from, sec.to, { xRange: sec.xRange }).ok).toBe(true);
          expect(v.path!.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 30 },
    );
  });
});
