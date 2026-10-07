import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gridRows } from "../../apps/editor/src/fill/window";
import {
  buildCaseRequest,
  canRebuild,
  caseState,
  casesFromRecordings,
  filterCases,
  hashRequest,
  isEvalCase,
  levelFor,
  levelFromRequest,
  needsRebuild,
  parseCaseLines,
  requestFor,
} from "./cases";
import { quickCases, recordingFor, nextToFrontier } from "./__fixtures__/fakes";
import { SEED_FIXTURES } from "./fixtures/levels";

const SEED = path.resolve(__dirname, "../data/seed.jsonl");

describe("seed set", () => {
  const { cases } = parseCaseLines(readFileSync(SEED, "utf8"), SEED);

  it("has at least 40 realistic requests across every family, with patrol cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.length).toBe(SEED_FIXTURES.length);
    const families = new Set(cases.map((c) => c.family));
    for (const f of ["staircase", "gaps", "platforms", "coins", "maze", "patrol", "enemies", "misc"]) expect(families).toContain(f);
    const patrol = cases.filter((c) => c.request.mode === "patrol");
    expect(patrol.length).toBeGreaterThanOrEqual(4);
    for (const p of patrol) {
      expect(p.blocked).toBeDefined();
      expect(p.request.blockedAt).toBeDefined();
      expect(p.request.previousFailure?.stage).toBe("agent");
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("stores requests built by the real window builder and brief, hashed", () => {
    for (const c of cases) {
      expect(isEvalCase(c)).toBe(true);
      expect(hashRequest(c.request)).toBe(c.requestHash);
      expect(gridRows(c.request.grid)).toHaveLength(c.request.size.h);
      expect(c.request.briefVersion).toMatch(/^brief\.v1-/);
      expect(c.request.size).toEqual({ w: 24, h: 12 });
    }
  });

  it("rebuilds every stored request exactly from its level and stream state (stale seed => rerun `seed`)", () => {
    for (const c of cases) {
      const st = caseState(c)!;
      expect(st).not.toBeNull();
      expect(buildCaseRequest(st)).toEqual(c.request);
    }
  });
});

describe("requestFor", () => {
  it("returns the recorded request when nothing changes and rebuilds for another window", async () => {
    const [c] = await quickCases(["stairs-up-2wide"]);
    expect(requestFor(c, {})).toBe(c.request);
    expect(needsRebuild(c, { window: { cols: 24, rows: 12 } })).toBe(false);
    const small = requestFor(c, { window: { cols: 16, rows: 10 } })!;
    expect(small.size).toEqual({ w: 16, h: 10 });
    expect(gridRows(small.grid)).toHaveLength(10);
    const noSum = requestFor(c, { summary: false })!;
    expect(noSum.summary).toBeUndefined();
    const ex = requestFor(c, { examples: true })!;
    expect(ex.brief.length).toBeGreaterThan(c.request.brief.length);
  });

  it("cannot re-window a recording but can drop its summary", async () => {
    const [c] = await quickCases(["gap-run-3"]);
    const [rec] = casesFromRecordings([recordingFor(c, nextToFrontier(c.request))]);
    expect(canRebuild(rec)).toBe(false);
    expect(requestFor(rec, { window: { cols: 16, rows: 10 } })).toBeNull();
    expect(requestFor(rec, { summary: false })!.summary).toBeUndefined();
    expect(requestFor(rec, { summary: true })).toBe(rec.request);
  });
});

describe("levelFromRequest", () => {
  it("reconstructs the window's tiles, entities and start", async () => {
    const [c] = await quickCases(["coin-arcs-next-pit"]);
    const full = levelFor(c);
    const rebuilt = levelFromRequest(c.request);
    const { origin, size } = c.request;
    for (let y = origin.y; y < origin.y + size.h; y++)
      for (let x = origin.x; x < origin.x + size.w; x++) expect(rebuilt.cells[y * rebuilt.w + x]).toBe(full.cells[y * full.w + x]);
    const inWin = (e: { x: number; y: number }) => e.x >= origin.x && e.x < origin.x + size.w && e.y >= origin.y && e.y < origin.y + size.h;
    expect(rebuilt.entities.map((e) => [e.kind, e.x, e.y]).sort()).toEqual(full.entities.filter(inWin).map((e) => [e.kind, e.x, e.y]).sort());
    // Outside the window: empty.
    expect(rebuilt.cells[15 * rebuilt.w + 0]).toBe(0);
    // A start on solid ground somewhere in the window.
    expect(rebuilt.cells[(rebuilt.start.y + 1) * rebuilt.w + rebuilt.start.x]).not.toBe(0);
  });
});

describe("recordings", () => {
  it("become cases grouped by session in time order", async () => {
    const cs = await quickCases(["gap-run-3", "pillar-hop"]);
    const recs = [
      recordingFor(cs[1], null, { sessionId: "b", t: "2026-01-01T00:00:02Z" }),
      recordingFor(cs[0], null, { sessionId: "b", t: "2026-01-01T00:00:01Z" }),
      recordingFor(cs[0], null, { sessionId: "a", t: "2026-01-01T00:00:05Z" }),
    ];
    const out = casesFromRecordings(recs);
    expect(out.map((c) => c.id)).toEqual(["a#0", "b#0", "b#1"]);
    expect(out[1].requestHash).toBe(cs[0].requestHash);
    expect(out[0].recorded?.model).toBe("gemini-test");
    const text = recs.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n{}\n";
    const parsed = parseCaseLines(text);
    expect(parsed.recordings).toHaveLength(3);
    expect(parsed.bad.map((b) => b.line)).toEqual([4, 5]);
  });

  it("filters", async () => {
    const cs = await quickCases(["gap-run-3", "pillar-hop", "erasing"]);
    expect(filterCases(cs, { family: "gaps" }).map((c) => c.id)).toEqual(["gap-run-3"]);
    expect(filterCases(cs, { match: "hop" }).map((c) => c.id)).toEqual(["pillar-hop"]);
    expect(filterCases(cs, { limit: 1 })).toHaveLength(1);
    expect(filterCases(cs, { mode: "patrol" })).toHaveLength(0);
  });
});
