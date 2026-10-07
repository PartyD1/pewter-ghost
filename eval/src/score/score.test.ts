import { describe, expect, it } from "vitest";
import { LEVEL_H, LEVEL_W, TILE, type FillRequest, type LevelSnapshot, type ModelAnswer } from "../../../apps/editor/src/contracts";
import { scoreSchema } from "./schema";
import { groups, scoreCoords } from "./coords";
import { jaccard, repeatsHistory, scoreVariety, type VarietyItem } from "./variety";
import { percentile, scoreLatency } from "./latency";
import { auc, calibrationBins, calibrationStats, suggestThresholds, thresholdFor } from "./calibration";

const ok: ModelAnswer = {
  act: true,
  kind: "finish",
  adds: [{ x: 5, y: 7, tile: "block" }],
  removes: [],
  entities: [],
  confidence: 0.8,
  label: "one more",
};

describe("scoreSchema", () => {
  it("parses text samples and reports the first error", () => {
    const s = scoreSchema({ texts: [JSON.stringify(ok), "```json\n" + JSON.stringify(ok) + "\n```"] });
    expect(s.ok).toBe(true);
    expect(s.answers).toHaveLength(2);
    const bad = scoreSchema({ texts: [JSON.stringify({ ...ok, kind: "teleport" }), null] });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/kind/);
    expect(bad.errors[1]).toBe("no text");
  });

  it("re-validates recorded answers and treats an empty call as not ok", () => {
    expect(scoreSchema({ texts: [null], parsed: [ok] }).ok).toBe(true);
    expect(scoreSchema({ texts: [null], parsed: [null] }).ok).toBe(false);
    const empty = scoreSchema({ texts: [], error: "upstream 500" });
    expect(empty.ok).toBe(false);
    expect(empty.errors).toContain("upstream 500");
  });
});

/** Level with ground on row 15 from x=0..29 and the window at (10, 8) 24x12. */
function setup(): { level: LevelSnapshot; req: FillRequest } {
  const w = LEVEL_W;
  const cells = new Array<number>(w * LEVEL_H).fill(0);
  const authors = new Array<number>(w * LEVEL_H).fill(0);
  for (let x = 0; x < 30; x++) {
    cells[15 * w + x] = TILE.GRASS;
    authors[15 * w + x] = 1;
  }
  const level: LevelSnapshot = { w, h: LEVEL_H, cells, authors, provenance: {}, entities: [{ id: "c1", kind: "coin", x: 31, y: 12 }], entityAuthors: { c1: 1 }, start: { x: 2, y: 14 } };
  const req = {
    grid: "",
    origin: { x: 10, y: 8 },
    size: { w: 24, h: 12 },
    recent: [{ dt: 100, x: 19, y: 7, tile: "grass", tool: "paint" as const }],
    frontier: { x: 19, y: 7, idleMs: 900 },
    knight: { maxGapStand: 8, maxGapRun: 11, maxRise: 6 },
    measured: { density: 0, gapHist: [0, 0, 0, 0, 0], verticality: 0, rewardSpacing: 0, pressure: 0 },
    brief: "",
    briefVersion: "x",
    lastGhosts: [],
    mode: "auto" as const,
  } satisfies FillRequest;
  return { level, req };
}

describe("scoreCoords", () => {
  it("accepts a continuation of the floor", () => {
    const { level, req } = setup();
    const a: ModelAnswer = { ...ok, adds: [{ x: 20, y: 7, tile: "grass" }, { x: 21, y: 7, tile: "grass" }] };
    const s = scoreCoords(a, req, level);
    expect(s).toMatchObject({ items: 2, inWindow: 2, free: 2, groups: 1, anchoredGroups: 1, local: true, accurate: true });
    expect(s.share).toBe(1);
  });

  it("flags level coordinates, occupied cells and floating junk", () => {
    const { level, req } = setup();
    // (30, 15) in level coords = window (20, 7) -> outside the window as given.
    const asLevel = scoreCoords({ ...ok, adds: [{ x: 30, y: 15, tile: "grass" }] }, req, level);
    expect(asLevel.inWindow).toBe(0);
    expect(asLevel.levelCoords).toBe(1);
    expect(asLevel.accurate).toBe(false);
    // Window (5, 7) = level (15, 15): already grass.
    const over = scoreCoords({ ...ok, adds: [{ x: 5, y: 7, tile: "block" }] }, req, level);
    expect(over.free).toBe(0);
    expect(over.issues.join()).toMatch(/occupied/);
    // A tile in the sky far above anything.
    const sky = scoreCoords({ ...ok, adds: [{ x: 22, y: 0, tile: "block" }] }, req, level);
    expect(sky.anchoredGroups).toBe(0);
    expect(sky.accurate).toBe(false);
  });

  it("checks enemies have floor and removes hit something", () => {
    const { level, req } = setup();
    const floating = scoreCoords({ ...ok, adds: [], entities: [{ kind: "slime", x: 15, y: 3 }] }, req, level);
    expect(floating.groundedEnemies).toBe(0);
    const standing = scoreCoords({ ...ok, adds: [], entities: [{ kind: "slime", x: 15, y: 6 }] }, req, level);
    expect(standing.groundedEnemies).toBe(1);
    const fix = scoreCoords({ ...ok, kind: "fix", adds: [], removes: [{ x: 15, y: 7 }, { x: 15, y: 2 }] }, req, level);
    expect(fix.free).toBe(1);
    const coinOnCoin = scoreCoords({ ...ok, adds: [], entities: [{ kind: "coin", x: 21, y: 4 }] }, req, level);
    expect(coinOnCoin.free).toBe(0);
  });

  it("measures distance to the action", () => {
    const { level, req } = setup();
    const far = scoreCoords({ ...ok, adds: [{ x: 0, y: 6, tile: "grass" }] }, { ...req, recent: [], frontier: { x: 23, y: 0, idleMs: 0 } }, level, { radius: 5 });
    expect(far.local).toBe(false);
    expect(far.focusDistance).toBeGreaterThan(5);
  });

  it("groups points 8-connected", () => {
    expect(groups([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }]).map((g) => g.length).sort()).toEqual([1, 2]);
  });
});

describe("scoreVariety (G-25)", () => {
  const item = (seq: number, tags: string[], o: Partial<VarietyItem> = {}): VarietyItem => ({ sessionId: "s", seq, act: true, kind: "extend", label: `l${seq}`, tags, ...o });

  it("fails when a tag appears three times running", () => {
    const v = scoreVariety([item(0, ["pit", "rest"]), item(1, ["pit"]), item(2, ["pit", "coin-arc"]), item(3, ["pit"])]);
    expect(v.pass).toBe(false);
    expect(v.violations).toBe(1);
    expect(v.sessions[0].violations[0]).toMatchObject({ tag: "pit", length: 4 });
    expect(v.sessions[0].longestRun).toEqual({ tag: "pit", length: 4 });
  });

  it("ignores neutral tags and declined answers", () => {
    const v = scoreVariety([item(0, ["rest"]), item(1, ["rest"]), item(2, ["rest"]), item(3, ["pit"], { act: false })]);
    expect(v.pass).toBe(true);
    expect(v.sessions[0].distinct).toBe(0);
  });

  it("counts distinct tags per session and novelty", () => {
    const v = scoreVariety([
      item(0, ["pit"]),
      item(1, ["staircase"]),
      item(0, ["pit"], { sessionId: "t" }),
      item(1, ["pit"], { sessionId: "t" }),
    ]);
    expect(v.distinctPerSession).toBe(1.5);
    expect(v.distinctTotal).toBe(2);
    expect(v.sessions.find((s) => s.sessionId === "s")!.tagNovelty).toBe(1);
    expect(v.sessions.find((s) => s.sessionId === "t")!.tagNovelty).toBe(0);
  });

  it("detects an extend repeating both of the last two accepted extends", () => {
    const history = [
      { kind: "extend" as const, label: "a", outcome: "accepted" as const, patterns: ["gap-run"] },
      { kind: "extend" as const, label: "b", outcome: "accepted" as const, patterns: ["gap-run", "rest"] },
    ];
    expect(repeatsHistory("extend", ["gap-run"], history, ["rest"])).toBe(true);
    expect(repeatsHistory("extend", ["staircase"], history, ["rest"])).toBe(false);
    expect(repeatsHistory("finish", ["gap-run"], history, ["rest"])).toBe(false);
    expect(repeatsHistory("extend", ["gap-run"], [history[0]], ["rest"])).toBe(false);
    expect(jaccard(new Set(["a"]), new Set(["a", "b"]))).toBe(0.5);
  });
});

describe("scoreLatency", () => {
  it("computes nearest-rank percentiles and the budget share", () => {
    const s = scoreLatency([100, 200, 300, 400, 2000], 900);
    expect(s).toMatchObject({ n: 5, p50: 300, p90: 2000, max: 2000, withinBudget: 0.8 });
    expect(percentile([], 0.5)).toBe(0);
    expect(scoreLatency([], 900).withinBudget).toBe(0);
  });
});

describe("calibration scorer (G-27)", () => {
  const pts = [
    ...[0.1, 0.15, 0.2, 0.3].map((c) => ({ confidence: c, label: false })),
    { confidence: 0.35, label: true },
    ...[0.8, 0.85, 0.9].map((c) => ({ confidence: c, label: true })),
    { confidence: 0.95, label: false },
  ];

  it("bins and ranks", () => {
    const bins = calibrationBins(pts, 5);
    expect(bins.map((b) => b.n)).toEqual([2, 3, 0, 0, 4]);
    expect(bins[4].rate).toBe(0.75);
    expect(auc(pts)).toBeGreaterThan(0.7);
    expect(auc([{ confidence: 0.5, label: true }])).toBe(0.5);
  });

  it("reports bands, ratios and steepness", () => {
    const s = calibrationStats(pts);
    expect(s.bands.map((b) => b.n)).toEqual([5, 0, 4]);
    expect(s.bands[2].rate).toBe(0.75);
    expect(s.bandRatio).toBeCloseTo(0.75 / 0.2);
    expect(s.steepness).toBeCloseTo(s.auc - 0.5);
    expect(s.slope).toBeGreaterThan(0);
    expect(s.brier).toBeGreaterThan(0);
    // A flat source has no steepness.
    const flat = calibrationStats(pts.map((p) => ({ ...p, confidence: 0.5 })));
    expect(flat.auc).toBe(0.5);
  });

  it("suggests thresholds from the curve", () => {
    expect(thresholdFor(pts, 0.75, 4)).toBe(0.35);
    expect(thresholdFor(pts, 0.3, 2)).toBe(0.1);
    expect(thresholdFor(pts, 0.99, 2)).toBeUndefined();
    const t = suggestThresholds(pts, { nowRate: 0.7, pauseRate: 0.5, minN: 3 });
    expect(t.showNowAbove).toBeDefined();
    expect(t.showAtPauseAbove!).toBeLessThanOrEqual(t.showNowAbove!);
  });
});
