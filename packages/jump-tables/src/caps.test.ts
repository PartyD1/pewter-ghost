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

/**
 * HISTORY (2026-10-08 feel retune). audit-caps.json is the audit's export for
 * the OLD knight (6.3-tile jump, 16 tiles/s). Until the retune this file
 * asserted that our tables equalled it, bar one documented cell. The knight now
 * reaches less on purpose (Gravity 125%, Run speed 85%, Jump power 90%), so
 * equality cannot hold. What the audit data is still good for:
 *   - nothing the audit measured got WIDER (the retune only narrowed reach);
 *   - the tables' structure matches the audit's (ladders, tiers, omitted rises).
 * The design-tier numbers are pinned to the new values below.
 */
describe("agreement with the audit's caps.json (history: the retune narrowed reach)", () => {
  it("no audited cell is wider after the retune", () => {
    const wider: { tier: string; runway: number; rise: number; caps: number; ours: number }[] = [];
    let compared = 0;
    for (const tier of AUDIT_TIERS) {
      for (const [rw, list] of Object.entries(C[tier].frontier)) {
        for (const e of list) {
          compared++;
          const ours = reachAt(tier, Number(rw), e.rise);
          if (ours > e.gap) wider.push({ tier, runway: Number(rw), rise: e.rise, caps: e.gap, ours });
        }
      }
    }
    expect(compared).toBe(220);
    expect(wider).toEqual([]);
  });

  it("the flat-ground ladder never gets wider than the audit's, and never shrinks with run-up", () => {
    for (const tier of AUDIT_TIERS) {
      const c = C[tier];
      for (const rung of c.ladder) {
        expect(reachAt(tier, rung.runwayTiles, 0), `${tier} runway ${rung.runwayTiles}`).toBeLessThanOrEqual(rung.gapTiles);
      }
      let prev = -1;
      for (const r of T.runways) {
        const g = reachAt(tier, r, 0);
        expect(g, `${tier} runway ${r}`).toBeGreaterThanOrEqual(prev);
        prev = g;
      }
      expect(T.limits[tier].maxRise).toBeLessThanOrEqual(c.maxStepUp);
      expect(T.limits[tier].maxGapRun).toBeLessThanOrEqual(c.maxGap);
      expect(T.limits[tier].maxGapStand).toBeLessThanOrEqual(c.standingGap);
      expect(T.limits[tier].maxGapStand).toBeLessThanOrEqual(T.limits[tier].maxGapRun);
      expect(T.impossible[T.runways.length - 1][-T.dyMin]).toBeLessThanOrEqual(c.impossibleGap);
    }
  });

  it("design-tier knight limits are the retuned ones (was 8 / 11 / 6)", () => {
    expect(T.designTier).toBe("NORMAL");
    expect(T.limits.NORMAL).toEqual({ maxGapStand: 5, maxGapRun: 7, maxRise: 4 });
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
