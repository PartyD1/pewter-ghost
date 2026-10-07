import { describe, expect, it } from "vitest";
import { PATTERN_TAGS, snapshotFromAscii } from "@measure";
import type { GhostHistoryItem } from "../contracts";
import {
  assertBriefBudget,
  BRIEF_BUDGET,
  BRIEF_STATIC,
  BRIEF_VERSION,
  BriefBudgetError,
  BriefCache,
  briefRect,
  buildBrief,
  measureRequestWindow,
  varietyRule,
} from "./brief";
import { seedLibrary } from "./examples";
import { FIXTURES, midStaircase, verticalTower } from "./__fixtures__/states";
import { buildFillRequest, estimateTokens } from "./window";

const SNAP_DIR = "../../../../prompts/__snapshots__";

const history: GhostHistoryItem[] = [
  { kind: "extend", label: "flat run", outcome: "esc", patterns: ["rest"] },
  { kind: "finish", label: "staircase, three steps", outcome: "accepted", patterns: ["staircase"] },
  { kind: "extend", label: "gap run over a pit", outcome: "drawn-over", patterns: ["gap-run", "pit"] },
  { kind: "extend", label: "coin arc over a pit", outcome: "accepted", patterns: ["coin-arc", "pit"] },
  { kind: "finish", label: "floor to the edge", outcome: "replaced" },
];

describe("static brief", () => {
  it("is within budget and versioned", () => {
    expect(estimateTokens(BRIEF_STATIC)).toBeLessThanOrEqual(BRIEF_BUDGET.staticTokens);
    expect(BRIEF_VERSION).toMatch(/^brief\.v1-[0-9a-f]{8}$/);
  });

  it("names 12-20 patterns, including every tag the measure package detects", () => {
    const names = [...BRIEF_STATIC.matchAll(/^- \*\*([a-z-]+)\*\*/gm)].map((m) => m[1]);
    const catalogue = names.filter((n) => !["parkour", "maze", "collect-a-thon", "story", "speedrun"].includes(n));
    // Patterns come before the level types in the text.
    const patterns = catalogue.slice(0, catalogue.indexOf("coin-row-on-floor") + 1);
    expect(patterns.length).toBeGreaterThanOrEqual(12);
    expect(patterns.length).toBeLessThanOrEqual(20);
    for (const tag of PATTERN_TAGS) expect(patterns, tag).toContain(tag);
  });

  it("has type rules, classic styles, placement rules with the arc table, variety and fix guidance", () => {
    for (const t of ["parkour", "maze", "collect-a-thon", "story", "speedrun"]) expect(BRIEF_STATIC).toContain(`**${t}**`);
    expect(BRIEF_STATIC).toContain("Classic Mario");
    expect(BRIEF_STATIC).toContain("Classic Sonic");
    expect(BRIEF_STATIC).toContain("gap 5: (1,-1) (2,-4) (3,-6) (4,-6) (5,-5)");
    expect(BRIEF_STATIC).not.toContain("{{");
    expect(BRIEF_STATIC).toMatch(/at least 4 tiles wide/);
    expect(BRIEF_STATIC).toMatch(/at least 2 tiles from where the knight lands/);
    expect(BRIEF_STATIC).toMatch(/every two to three screens/);
    expect(BRIEF_STATIC).toMatch(/fewest tiles/);
    expect(BRIEF_STATIC).toMatch(/different pattern from the last two accepted/);
  });
});

describe("briefRect", () => {
  it("covers the frontier's screen and the one before, clipped to the level", () => {
    expect(briefRect({ w: 200, h: 20 }, 56)).toEqual({ x: 24, y: 0, w: 48, h: 20 });
    expect(briefRect({ w: 200, h: 20 }, 5)).toEqual({ x: 0, y: 0, w: 24, h: 20 });
    expect(briefRect({ w: 200, h: 20 }, 199)).toEqual({ x: 168, y: 0, w: 32, h: 20 });
    expect(briefRect({ w: 200, h: 20 }, 100, 3)).toEqual({ x: 48, y: 0, w: 72, h: 20 });
  });
});

describe("buildBrief", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))("golden brief for %s", async (_n, make) => {
    const f = make();
    const b = buildBrief({
      level: f.model.snapshot(),
      frontierX: f.stream.last?.x,
      lastGhosts: f.lastGhosts,
      lastGuess: "parkour",
      historyCount: 5,
    });
    expect(b.version).toBe(BRIEF_VERSION);
    expect(b.tokens).toBeLessThanOrEqual(BRIEF_BUDGET.dynamicTokens);
    await expect(b.text + "\n").toMatchFileSnapshot(`${SNAP_DIR}/brief-${f.name}.txt`);
  });

  it("reports measured numbers and detected patterns for the last two screens", () => {
    const f = midStaircase();
    const b = buildBrief({ level: f.model.snapshot(), frontierX: 56, historyCount: 5 });
    expect(b.rect).toEqual({ x: 24, y: 0, w: 48, h: 20 });
    expect(b.patterns).toContain("staircase");
    expect(b.text).toMatch(/density \d\.\d\d/);
    expect(b.text).toContain("patterns here: ");
    expect(b.text).toContain("staircase");
    expect(b.text).toContain("You have not guessed the level type yet");
  });

  it("states the model's last guess", () => {
    const b = buildBrief({ lastGuess: "  collect-a-thon,   coins on arcs ", historyCount: 5 });
    expect(b.text).toContain("Your last guess at the level type: collect-a-thon, coins on arcs.");
  });

  it("handles an empty level and a missing level", () => {
    const empty = snapshotFromAscii(["....", "...."], { w: 48, h: 20 });
    expect(buildBrief({ level: empty, historyCount: 5 }).text).toContain("nothing drawn here yet");
    expect(buildBrief({ historyCount: 5 }).text).toContain("not measured");
  });

  it("lists the last ghosts with outcomes and the variety rule", () => {
    const b = buildBrief({ lastGhosts: history, historyCount: 5 });
    expect(b.text).toContain('1. extend "flat run" [rest]: dismissed with Esc');
    expect(b.text).toContain('4. extend "coin arc over a pit" [coin-arc, pit]: accepted');
    expect(b.text).toContain("replaced by a newer ghost");
    expect(b.text).toContain("the last two accepted were staircase and coin-arc+pit");
    expect(b.text).toContain('Do not offer again: "flat run", "gap run over a pit" (dismissed).');
  });

  it("keeps only historyCount ghosts", () => {
    const b = buildBrief({ lastGhosts: history, historyCount: 2 });
    expect(b.text).not.toContain("flat run");
    expect(b.text).toContain('1. extend "coin arc over a pit"');
  });

  it("variety rule without accepted ghosts", () => {
    expect(varietyRule([])).toContain("nothing accepted yet");
    expect(varietyRule([{ kind: "extend", label: "x", outcome: "partial" }])).toContain('the last accepted ghost was "x"');
  });

  it("drops the oldest history before exceeding the budget, then throws", () => {
    const long = Array.from({ length: 5 }, (_, i) => ({
      kind: "extend" as const,
      label: `idea ${i} ` + "very long label ".repeat(30),
      outcome: "esc" as const,
    }));
    const b = buildBrief({ lastGhosts: long, historyCount: 5 });
    expect(b.tokens).toBeLessThanOrEqual(BRIEF_BUDGET.dynamicTokens);
    expect(b.text).not.toContain("idea 0");
    expect(() => buildBrief({ lastGuess: "x", lastGhosts: long, historyCount: 5, maxTokens: 20 })).toThrow(BriefBudgetError);
    expect(() => assertBriefBudget({ text: "x".repeat(4 * (BRIEF_BUDGET.dynamicTokens + BRIEF_BUDGET.examplesTokens) + 8) })).toThrow(
      BriefBudgetError,
    );
  });

  it("appends reference examples within the examples budget (G-31)", () => {
    const f = midStaircase();
    const b = buildBrief({
      level: f.model.snapshot(),
      frontierX: 56,
      lastGhosts: f.lastGhosts,
      historyCount: 5,
      examples: { library: seedLibrary(), k: 3 },
    });
    expect(b.examples.length).toBeGreaterThan(0);
    expect(b.text).toContain("Sections others have drawn");
    expect(() => assertBriefBudget(b)).not.toThrow();
    const without = buildBrief({ level: f.model.snapshot(), frontierX: 56, lastGhosts: f.lastGhosts, historyCount: 5 });
    expect(b.tokens - without.tokens).toBeLessThanOrEqual(BRIEF_BUDGET.examplesTokens + 1);
  });

  it("is deterministic", () => {
    const f = verticalTower();
    const ctx = { level: f.model.snapshot(), frontierX: 103, lastGhosts: history, historyCount: 5, examples: { library: seedLibrary() } };
    expect(buildBrief(ctx)).toEqual(buildBrief(ctx));
  });
});

describe("BriefCache", () => {
  it("reuses the brief while the key is unchanged", () => {
    const f = midStaircase();
    const cache = new BriefCache();
    const level = f.model.snapshot();
    const a = cache.get({ level, frontierX: 56, revision: 3, historyCount: 5 });
    const b = cache.get({ level, frontierX: 60, revision: 3, historyCount: 5 }); // same screen
    expect(b).toBe(a);
    expect(cache.hits).toBe(1);
    cache.get({ level, frontierX: 80, revision: 3, historyCount: 5 }); // next screen
    cache.get({ level, frontierX: 80, revision: 4, historyCount: 5 }); // level changed
    cache.get({ level, frontierX: 80, revision: 4, historyCount: 5, lastGhosts: history });
    expect(cache.misses).toBe(4);
  });
});

describe("measureRequestWindow", () => {
  it("fills FillRequest.measured with real numbers", () => {
    const f = midStaircase();
    const req = buildFillRequest(f.model, f.stream, { now: f.now, measure: measureRequestWindow });
    expect(req.measured.density).toBeGreaterThan(0);
    expect(req.measured.patterns).toContain("staircase");
    expect(req.measured.gapHist).toHaveLength(5);
  });
});
