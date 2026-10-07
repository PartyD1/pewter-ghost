import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { knightLimits, maxGap } from "@jump-tables";
import { AUDIT_CAPS, capsFor, ladderGap } from "./caps";
import { chunkMetrics, chunkRows, chunkTags, generateChunk, PIECE_KINDS, profileFor, THEMES, type Difficulty, type StyleProfile, type Theme } from "./generator";
import { profileFromMeasured, typicalGap } from "./profile";
import { checkChunk, generateValidChunk, retrySeed } from "./validate";

const themes = Object.keys(THEMES) as Theme[];
const arbProfile: fc.Arbitrary<StyleProfile> = fc
  .record({
    d: fc.integer({ min: 1, max: 5 }),
    theme: fc.constantFrom(...themes),
    fillDepth: fc.oneof(fc.constant(Infinity), fc.integer({ min: 1, max: 4 })),
    coinEvery: fc.integer({ min: 1, max: 3 }),
    upP: fc.double({ min: 0, max: 1, noNaN: true }),
    kinds: fc.array(fc.constantFrom(...PIECE_KINDS), { minLength: 1, maxLength: 6 }),
    useKinds: fc.boolean(),
  })
  .map(({ d, theme, fillDepth, coinEvery, upP, kinds, useKinds }) => ({
    ...profileFor(d as Difficulty, theme),
    fillDepth,
    coinEvery,
    upP,
    ...(useKinds ? { kinds } : {}),
  }));

describe("caps", () => {
  it("jump-table caps agree with the audit's caps.json at NORMAL", () => {
    const c = capsFor("NORMAL");
    for (const r of [0, 1, 2, 3, 4, 5, 6, 7]) expect(ladderGap(c, r)).toBe(ladderGap(AUDIT_CAPS.NORMAL, r));
    expect(c.maxStepUp).toBe(AUDIT_CAPS.NORMAL.maxStepUp);
    expect(ladderGap(c, 0)).toBe(maxGap(0, false));
  });
});

describe("generateChunk", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = generateChunk({ seed: 11 });
    const b = generateChunk({ seed: 11 });
    expect(chunkRows(a)).toEqual(chunkRows(b));
    const distinct = new Set(Array.from({ length: 20 }, (_, s) => chunkRows(generateChunk({ seed: s })).join("\n")));
    expect(distinct.size).toBeGreaterThan(15);
  });

  it("keeps the start and end runs flat at the ground and bounds pits by the ladder", () => {
    for (let s = 0; s < 50; s++) {
      const c = generateChunk({ seed: s, profile: profileFor(5, "timing") });
      expect(c.heights.slice(0, 3)).toEqual([8, 8, 8]);
      const end = c.heights.slice(-3);
      expect(end.every((h) => h === c.endY)).toBe(true);
      expect(chunkMetrics(c).maxPit).toBeLessThanOrEqual(knightLimits().maxGapRun);
    }
  });

  it("fillDepth thins the ground without changing the layout", () => {
    const full = generateChunk({ seed: 3, profile: profileFor(3, "mixed") });
    const thin = generateChunk({ seed: 3, profile: { ...profileFor(3, "mixed"), fillDepth: 2 } });
    expect(thin.heights).toEqual(full.heights);
    expect(thin.desc).toEqual(full.desc);
    const solids = (g: Uint8Array) => g.reduce((a, b) => a + b, 0);
    expect(solids(thin.grid)).toBeLessThan(solids(full.grid));
    for (let x = 0; x < thin.w; x++) {
      const h = thin.heights[x];
      if (h === null) continue;
      expect(thin.grid[h * thin.w + x]).toBe(1);
      if (h + 2 < thin.h) expect(thin.grid[(h + 2) * thin.w + x]).toBe(0);
    }
  });

  it("coinEvery spaces the coins of a coin arc", () => {
    const p: StyleProfile = { ...profileFor(1, "reward"), kinds: ["coin_row"] };
    const dense = generateChunk({ seed: 1, profile: p });
    const sparse = generateChunk({ seed: 1, profile: { ...p, coinEvery: 2 } });
    expect(sparse.coins.length).toBeLessThan(dense.coins.length);
    expect(sparse.desc).toEqual(dense.desc);
  });

  it("tags describe the pieces", () => {
    const c = generateChunk({ seed: 0, profile: { ...profileFor(3, "timing"), kinds: ["pit"] } });
    expect(chunkTags(c)).toContain("pit");
    expect(c.pieces.every((p) => p.x0 <= p.x1)).toBe(true);
  });

  it("rejects bad sizes and grounds", () => {
    expect(() => generateChunk({ w: 0 })).toThrow(RangeError);
    expect(() => generateChunk({ ground: 40 })).toThrow(RangeError);
    expect(() => generateChunk({ profile: { ...profileFor(), kinds: [] } })).toThrow(RangeError);
  });

  it("costs well under 2 ms per candidate including the rule check", () => {
    const t0 = performance.now();
    const n = 400;
    for (let s = 0; s < n; s++) checkChunk(generateChunk({ seed: s, profile: profileFor(((s % 5) + 1) as Difficulty, themes[s % 4]) }));
    expect((performance.now() - t0) / n).toBeLessThan(2);
  });
});

describe("every generated chunk passes the @physsim rule check", () => {
  it("raw chunks over profiles, sizes and seeds (property)", () => {
    fc.assert(
      fc.property(
        arbProfile,
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 10, max: 40 }),
        fc.integer({ min: 4, max: 10 }),
        (profile, seed, w, ground) => {
          const c = generateChunk({ seed, profile, w, h: 12, ground });
          const v = checkChunk(c);
          if (!v.ok) throw new Error(`seed ${seed} ${profile.name} ${w}: ${v.reason}\n${chunkRows(c).join("\n")}`);
        },
      ),
      { numRuns: 400, seed: 20261007 },
    );
  });

  it("generateValidChunk only returns passing chunks, and retries deterministically", () => {
    for (let s = 0; s < 100; s++) {
      const r = generateValidChunk({ seed: s, profile: profileFor(((s % 5) + 1) as Difficulty, themes[s % 4]) });
      expect(r).not.toBeNull();
      expect(checkChunk(r!.chunk).ok).toBe(true);
      expect(r!.chunk.seed).toBe(retrySeed(s, r!.tries - 1));
    }
  });

  it("generateValidChunk honours an extra acceptance test and gives up after maxTries", () => {
    const r = generateValidChunk({ seed: 5, accept: (c) => c.desc.some((d) => d.startsWith("pit")) });
    expect(r!.chunk.desc.some((d) => d.startsWith("pit"))).toBe(true);
    expect(generateValidChunk({ seed: 5, maxTries: 3, accept: () => false })).toBeNull();
  });
});

describe("profileFromMeasured", () => {
  const knight = knightLimits();
  const base = { density: 0.2, gapHist: [0, 0, 0, 0, 0], verticality: 0, rewardSpacing: 0, pressure: 0 };

  it("is neutral with nothing measured", () => {
    const p = profileFromMeasured(base, knight);
    expect(p.gap).toEqual([2, 4]);
    expect(p.rise).toEqual([1, 1]);
    expect(p.enemyP).toBe(0);
    expect(p.kinds).not.toContain("coin_row");
    expect(p.fillDepth).toBe(2);
  });

  it("follows gaps, rise, rewards and pressure", () => {
    expect(typicalGap([0, 0, 1, 0, 0], 11)).toBe(6);
    expect(typicalGap([0, 0, 0, 0, 0], 11)).toBeNull();
    const p = profileFromMeasured({ ...base, gapHist: [0, 0, 1, 0, 0], verticality: 0.5, rewardSpacing: 5, pressure: 0.5 }, knight);
    expect(p.gap).toEqual([5, 7]);
    expect(p.rise[1]).toBeGreaterThan(1);
    expect(p.kinds.filter((k) => k === "step").length).toBe(2);
    expect(p.kinds).toContain("coin_row");
    expect(p.coinEvery).toBe(2);
    expect(p.enemyP).toBeGreaterThan(0);
    // Gaps never exceed a standing jump unless the drawing is hard.
    const wide = profileFromMeasured({ ...base, gapHist: [0, 0, 0, 0, 1] }, knight);
    expect(wide.gap[1]).toBeLessThanOrEqual(knight.maxGapStand);
  });

  it("measured profiles still give rule-checked chunks", () => {
    const p = profileFromMeasured({ ...base, gapHist: [0, 0, 0, 1, 1], verticality: 0.6, rewardSpacing: 3, pressure: 1, difficulty: 0.9 }, knight);
    for (let s = 0; s < 100; s++) expect(checkChunk(generateChunk({ seed: s, profile: p, w: 14 })).ok).toBe(true);
  });
});
