import { describe, expect, it } from "vitest";
import { FLAT, GAP_RUN, PILLAR_HOP, REFERENCE_ROWS, RISING_STEPS, TUNNEL } from "./__fixtures__/levels";
import {
  expressiveFeatures,
  expressiveHistogram,
  FEATURE_KEYS,
  levelDistance,
  meanPairwiseDistance,
  pairwiseDistances,
} from "./expressive";
import { snapshotFromAscii } from "./grid";
import { measureLevel } from "./level";

const levels = [FLAT.rows, GAP_RUN.rows, PILLAR_HOP.rows, RISING_STEPS.rows, TUNNEL.rows, REFERENCE_ROWS].map((r) =>
  measureLevel(snapshotFromAscii(r)),
);

describe("expressive range", () => {
  it("features are all in [0, 1]", () => {
    for (const l of levels) {
      const f = expressiveFeatures(l);
      for (const k of FEATURE_KEYS) {
        expect(f[k]).toBeGreaterThanOrEqual(0);
        expect(f[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it("a flat level is linear and lenient; pillar hops are not lenient", () => {
    const flat = expressiveFeatures(levels[0]);
    expect(flat.linearity).toBe(1);
    expect(flat.leniency).toBe(1);
    expect(expressiveFeatures(levels[2]).leniency).toBeLessThan(0.5);
  });

  it("2D histogram counts every level once", () => {
    const h = expressiveHistogram(levels, { bins: 5 });
    expect(h.x).toBe("linearity");
    expect(h.y).toBe("leniency");
    expect(h.counts.flat().reduce((a, b) => a + b, 0)).toBe(levels.length);
    expect(h.counts[4][4]).toBeGreaterThanOrEqual(1); // flat: linearity 1, leniency 1 -> top bin
    expect(h.coverage).toBeGreaterThan(0);
    expect(h.coverage).toBeLessThanOrEqual(1);
  });

  it("histogram accepts other axes and raw features", () => {
    const h = expressiveHistogram(levels.map(expressiveFeatures), { bins: 2, x: "density", y: "difficulty" });
    expect(h.counts).toHaveLength(2);
    expect(h.total).toBe(levels.length);
  });

  it("distances are a metric-like matrix in [0, 1]", () => {
    const m = pairwiseDistances(levels);
    for (let i = 0; i < m.length; i++) {
      expect(m[i][i]).toBe(0);
      for (let j = 0; j < m.length; j++) {
        expect(m[i][j]).toBe(m[j][i]);
        expect(m[i][j]).toBeGreaterThanOrEqual(0);
        expect(m[i][j]).toBeLessThanOrEqual(1);
        for (let k = 0; k < m.length; k++) expect(m[i][k]).toBeLessThanOrEqual(m[i][j] + m[j][k] + 1e-12);
      }
    }
    expect(levelDistance(levels[0], levels[0])).toBe(0);
    expect(levelDistance(levels[0], levels[2])).toBeGreaterThan(0);
  });

  it("a varied set is more diverse than copies of one level", () => {
    expect(meanPairwiseDistance([levels[0], levels[0], levels[0]])).toBe(0);
    expect(meanPairwiseDistance(levels)).toBeGreaterThan(0.05);
    expect(meanPairwiseDistance([levels[0]])).toBe(0);
  });

  it("window measures work as input too", () => {
    const f = expressiveFeatures(levels[1].whole);
    expect(f.gapMean).toBeCloseTo(0.3, 5);
  });
});
