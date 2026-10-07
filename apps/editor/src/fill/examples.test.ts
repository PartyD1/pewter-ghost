import { describe, expect, it } from "vitest";
import { measuredDistance, snapshotFromAscii, type Chunk } from "@measure";
import type { MeasuredNumbers } from "../contracts";
import {
  EXAMPLES_HEADER,
  ExampleLibrary,
  renderExample,
  seedLibrary,
  selectExamples,
  toWindowGlyphs,
} from "./examples";
import { estimateTokens } from "./window";

const target = (over: Partial<MeasuredNumbers> = {}): MeasuredNumbers => ({
  density: 0.2,
  gapHist: [0, 0.5, 0.5, 0, 0],
  verticality: 0.2,
  rewardSpacing: 6,
  pressure: 0,
  difficulty: 0.3,
  patterns: ["coin-arc", "pit"],
  ...over,
});

describe("toWindowGlyphs", () => {
  it("redraws @measure ASCII in the window's alphabet", () => {
    expect(toWindowGlyphs(["#d=B?", "cfsUFiP."])).toEqual(["GDHBQ", "o*SUF!@."]);
  });
});

describe("seed library", () => {
  it("slices the reference sections into tagged chunks", () => {
    const lib = seedLibrary();
    expect(lib.size).toBeGreaterThanOrEqual(8);
    const tags = new Set(lib.chunks.flatMap((c) => c.tags));
    for (const t of ["coin-arc", "pillar-hop", "tunnel", "rest", "pit"]) expect(tags, t).toContain(t);
    expect(seedLibrary()).toBe(lib);
  });

  it("can be built from level snapshots", () => {
    const rows = [
      "........................",
      "........c...............",
      ".......c.c..............",
      "........................",
      "######....######...#####",
      "dddddd....dddddd...ddddd",
    ];
    const level = snapshotFromAscii(rows);
    const lib = ExampleLibrary.fromLevels([{ name: "lab-1", level }]);
    expect(lib.size).toBeGreaterThan(0);
    expect(lib.chunks.every((c) => c.source === "lab-1")).toBe(true);
  });
});

describe("selectExamples", () => {
  const chunks = seedLibrary().chunks;

  it("picks the nearest chunks by measured distance, nearest first", () => {
    const t = target();
    const sel = selectExamples(chunks, t, { k: 3, maxTokens: 10_000, maxDistance: 1 });
    expect(sel.picked).toHaveLength(3);
    const ds = sel.picked.map((p) => p.distance);
    expect([...ds].sort((a, b) => a - b)).toEqual(ds);
    // Nothing skipped was nearer than the first pick.
    const best = Math.min(...chunks.map((c) => measuredDistance(c.numbers, t)));
    expect(sel.picked[0].distance).toBeCloseTo(best, 10);
    expect(sel.text.startsWith(EXAMPLES_HEADER)).toBe(true);
  });

  it("never picks two chunks from the same source with the same tags", () => {
    const dup: Chunk[] = [...chunks, ...chunks.map((c) => ({ ...c, id: c.id + "-copy" }))];
    const sel = selectExamples(dup, target(), { k: 3, maxTokens: 10_000, maxDistance: 1 });
    const keys = sel.picked.map((p) => `${p.chunk.source}|${p.chunk.tags.join(",")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("respects the token budget, the distance cut-off and exclusions", () => {
    const small = selectExamples(chunks, target(), { k: 3, maxTokens: 120, maxDistance: 1 });
    expect(small.tokens).toBeLessThanOrEqual(120);
    expect(selectExamples(chunks, target(), { maxDistance: 0 }).picked).toHaveLength(0);
    expect(selectExamples(chunks, target(), { maxDistance: 0 }).text).toBe("");
    const none = selectExamples(chunks, target(), { exclude: () => true });
    expect(none.picked).toHaveLength(0);
    const tiny = selectExamples(chunks, target(), { maxTokens: estimateTokens(EXAMPLES_HEADER) + 2 });
    expect(tiny.picked).toHaveLength(0);
  });

  it("is deterministic", () => {
    expect(selectExamples(chunks, target(), { k: 3 })).toEqual(selectExamples(chunks, target(), { k: 3 }));
  });

  it("renders a chunk with its tags and numbers, cropped to maxCols", () => {
    const c = chunks.reduce((a, b) => (b.rect.w > a.rect.w ? b : a));
    const text = renderExample(c, 0.25, 10);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^\[.*\] 10x\d+, density \d\.\d\d, difficulty \d\.\d\d, coins on arcs \d+%, distance 0\.25$/);
    expect(lines.slice(1).every((l) => l.length <= 10)).toBe(true);
    for (const row of lines.slice(1)) expect(row).not.toMatch(/[#dc=?fsiP]/);
  });
});
