/**
 * Pins the comparison with the audit's export (audit-caps.json is a verbatim
 * copy of audit-prototypes/generators/caps.json, produced by export_caps.ts
 * from the same fork commit). The reasons for every difference are in the
 * header of build.ts; this test fails if a new one appears.
 */
import { describe, expect, it } from "vitest";
import caps from "./audit-caps.json";
import tables from "./tables.json";
import type { JumpTables, Tier } from "./types";

const T = tables as unknown as JumpTables;
type CapsTier = {
  ladder: { runwayTiles: number; gapTiles: number }[];
  maxStepUp: number;
  maxGap: number;
  standingGap: number;
  impossibleGap: number;
  frontier: Record<string, { rise: number; gap: number }[]>;
};
const C = caps as unknown as Record<
  "GUARANTEED" | "NORMAL" | "EXPERT",
  CapsTier
>;
const AUDIT_TIERS = ["GUARANTEED", "NORMAL", "EXPERT"] as const;

const reachAt = (tier: Tier, runway: number, rise: number) =>
  T.reach[tier][T.runways.indexOf(runway)][-rise - T.dyMin];

/** Cells where we deliberately differ (see build.ts header). */
const KNOWN_DIFFERENCES = [
  { tier: "EXPERT", runway: 4, rise: 5, caps: 9, ours: 8 },
];

describe("agreement with the audit's caps.json", () => {
  it("flat-ground ladder, step-up, max/standing gap and impossible gap match", () => {
    for (const tier of AUDIT_TIERS) {
      const c = C[tier];
      for (const rung of c.ladder) {
        expect(
          reachAt(tier, rung.runwayTiles, 0),
          `${tier} runway ${rung.runwayTiles}`,
        ).toBe(rung.gapTiles);
      }
      expect(T.limits[tier].maxRise).toBe(c.maxStepUp);
      expect(T.limits[tier].maxGapRun).toBe(c.maxGap);
      expect(T.limits[tier].maxGapStand).toBe(c.standingGap);
      expect(T.impossible[T.runways.length - 1][-T.dyMin]).toBe(
        c.impossibleGap,
      );
    }
  });

  it("design-tier knight limits equal the audit's NORMAL caps", () => {
    expect(T.designTier).toBe("NORMAL");
    expect(T.limits.NORMAL).toEqual({
      maxGapStand: C.NORMAL.standingGap,
      maxGapRun: C.NORMAL.maxGap,
      maxRise: C.NORMAL.maxStepUp,
    });
  });

  it("every frontier cell matches except the documented run-up monotonicity case", () => {
    const diffs: {
      tier: string;
      runway: number;
      rise: number;
      caps: number;
      ours: number;
    }[] = [];
    let compared = 0;
    for (const tier of AUDIT_TIERS) {
      for (const [rw, list] of Object.entries(C[tier].frontier)) {
        for (const e of list) {
          compared++;
          const ours = reachAt(tier, Number(rw), e.rise);
          if (ours !== e.gap)
            diffs.push({
              tier,
              runway: Number(rw),
              rise: e.rise,
              caps: e.gap,
              ours,
            });
        }
      }
    }
    expect(compared).toBe(220);
    expect(diffs).toEqual(KNOWN_DIFFERENCES);
  });

  it("rises the audit omitted (gap floors to 0) are 0 or -1 here, never a positive gap", () => {
    for (const tier of AUDIT_TIERS) {
      for (const [rw, list] of Object.entries(C[tier].frontier)) {
        const listed = new Set(list.map((e) => e.rise));
        for (let rise = -8; rise <= 6; rise++) {
          if (listed.has(rise)) continue;
          expect(
            reachAt(tier, Number(rw), rise),
            `${tier} rw ${rw} rise ${rise}`,
          ).toBeLessThanOrEqual(0);
        }
      }
    }
  });
});
