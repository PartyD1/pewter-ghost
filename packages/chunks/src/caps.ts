/**
 * Jump caps for the generator: the run-up ladder (widest flat gap per
 * run-up) and the highest step up. chunkgen.py read these from the audit's
 * caps.json; here the default comes from @jump-tables (the same solver
 * numbers the rule check uses), so every chunk the generator lays out is
 * inside what @physsim checkRules accepts. AUDIT_CAPS keeps the audit's
 * exact export for parity with the Python prototype. At the NORMAL tier
 * the two agree (see caps.test.ts).
 */
import { FULL_RUNWAY, knightLimits, maxGap, type Tier } from "@jump-tables";
import auditCaps from "@jump-tables/audit-caps.json";

export interface LadderRung {
  /** Flat standing tiles behind the takeoff. */
  runwayTiles: number;
  /** Widest flat gap (empty columns) clearable with at least that run-up. */
  gapTiles: number;
}

export interface Caps {
  ladder: LadderRung[];
  /** Highest rise (rows) the knight can step / jump up. */
  maxStepUp: number;
}

export type CapsTier = "GUARANTEED" | "NORMAL" | "EXPERT";

type AuditCapsJson = Record<CapsTier, { ladder: LadderRung[]; maxStepUp: number }>;
const AUDIT = auditCaps as unknown as AuditCapsJson;

/** The audit's caps.json (what chunkgen.py used). */
export const AUDIT_CAPS: Record<CapsTier, Caps> = {
  GUARANTEED: { ladder: AUDIT.GUARANTEED.ladder.map((r) => ({ ...r })), maxStepUp: AUDIT.GUARANTEED.maxStepUp },
  NORMAL: { ladder: AUDIT.NORMAL.ladder.map((r) => ({ ...r })), maxStepUp: AUDIT.NORMAL.maxStepUp },
  EXPERT: { ladder: AUDIT.EXPERT.ladder.map((r) => ({ ...r })), maxStepUp: AUDIT.EXPERT.maxStepUp },
};

const capsCache = new Map<Tier, Caps>();

/** Caps from @jump-tables for a tier: one rung per run-up 0..FULL_RUNWAY (flat jumps, dy 0). */
export function capsFor(tier: Tier = "NORMAL"): Caps {
  const hit = capsCache.get(tier);
  if (hit) return hit;
  const ladder: LadderRung[] = [];
  for (let r = 0; r <= FULL_RUNWAY; r++) ladder.push({ runwayTiles: r, gapTiles: Math.max(0, maxGap(0, r, tier)) });
  const caps: Caps = { ladder, maxStepUp: knightLimits(tier).maxRise };
  capsCache.set(tier, caps);
  return caps;
}

/** reachpy.ladder_gap: the widest gap for a run-up of `runway` tiles. */
export function ladderGap(caps: Caps, runway: number): number {
  let best = 0;
  for (const rung of caps.ladder) if (runway >= rung.runwayTiles) best = rung.gapTiles;
  return best;
}

/** The longest run-up the ladder distinguishes (chunkgen counts runway up to 7). */
export function fullRunway(caps: Caps): number {
  return caps.ladder.length ? caps.ladder[caps.ladder.length - 1].runwayTiles : 0;
}
