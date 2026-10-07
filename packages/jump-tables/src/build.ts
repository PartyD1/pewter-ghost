/**
 * Build the jump tables from the fork's frame-accurate jump solver.
 *
 * Pure and deterministic: `buildTables()` always produces the same object for
 * the same physics, and `serializeTables()` always the same bytes, which is
 * what the regeneration test (build.test.ts) checks against the checked-in
 * tables.json. Run `npx tsx packages/jump-tables/src/export.ts` after any
 * change under apps/editor/src/player/ to refresh it.
 *
 * ---------------------------------------------------------------------------
 * Comparison with the audit's export (audit-prototypes/generators/caps.json,
 * written by export_caps.ts against the same fork commit b36ff59). A copy is
 * kept as audit-caps.json and caps.test.ts pins the comparison:
 *
 *  - Same engine, same numbers. For GUARANTEED / NORMAL / EXPERT the flat
 *    ladder {0,1,2,4,7}, maxStepUp, maxGap, standingGap and impossibleGap are
 *    identical, and so is every one of the 220 per-rise frontier cells but
 *    one. The design-tier KnightLimits {maxGapStand: 8, maxGapRun: 11,
 *    maxRise: 6} equal caps.json NORMAL {standingGap, maxGap, maxStepUp}.
 *  - The one difference: EXPERT, runway 4, rise 5 is 9 in caps.json and 8
 *    here. caps.json is the raw solve at exactly that run-up (8.993 is
 *    reachable at runway 4 but only ~8.9 at runway 7). The discrete sweep
 *    (sub-pixel takeoff phase vs the fixed 1/60 physics step) makes the raw
 *    reach wobble by ~0.1 tile with run-up length; a level cannot make the
 *    player start their run on an exact pixel, so a cell here means "works
 *    with AT LEAST this much run-up": the minimum over this and every
 *    longer run-up (sampled to 10 tiles, past top speed). The same rule is
 *    why maxGapRun is 11 and not 12: the NORMAL flat reach is 12.04-12.07 at
 *    run-ups 5, 6 and 10 but 11.94 at 7, i.e. 12 is a coin toss on phase.
 *    The impossibility bound is the opposite (best-case) question, so it
 *    takes the maximum instead.
 *  - Wider coverage. caps.json samples runways {0,1,2,4,7} and rises +6..-8
 *    and drops entries whose gap floors to 0. Here runways are every tile
 *    0..7 and dy runs from 9 tiles up to 19 down (the whole 20-row level),
 *    and a rise the knight can still climb with no gap is recorded as 0
 *    instead of being omitted (-1 means truly unreachable).
 *  - ULTRA is tabulated too (caps.json stopped at EXPERT), so the agent and
 *    the rule check can reject geometry against the physical bound while the
 *    brief designs to NORMAL.
 *  - Coordinates follow the contracts (y down): dy = -rise.
 *  - Arcs are new; the audit had no trajectory export.
 * ---------------------------------------------------------------------------
 */
import type { KnightLimits } from "../../../apps/editor/src/contracts";
import {
  gapForTier,
  solveJump,
  SOLVER_FRAME_RATES,
} from "../../../apps/editor/src/player/jumpSolver";
import {
  PLAYER_BODY_PX,
  PLAYER_PHYSICS,
  TILE,
} from "../../../apps/editor/src/player/playerPhysics";
import { ARC_RENDER_DT, traceArcs } from "./arcs";
import { TIERS, type ArcEntry, type JumpTables, type Tier } from "./types";

export const DESIGN_TIER: Tier = "NORMAL";
export const RUNWAYS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
/**
 * Run-ups actually solved. Past ~6 tiles the knight is at top speed and
 * longer run-ups only change the sub-pixel takeoff phase; 8..10 are sampled
 * so the last table row (7 = "full run-up") is the worst of several
 * steady-state solves rather than one lucky or unlucky phase.
 */
export const SAMPLE_RUNWAYS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
/** 9 tiles up is beyond the 6.3-tile apex; the solver's own probe bound. */
export const DY_MIN = -(Math.ceil(PLAYER_PHYSICS.JUMP_HEIGHT) + 2);
/** A drop across the whole 20-row level. */
export const DY_MAX = 19;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function dyList(): number[] {
  const out: number[] = [];
  for (let dy = DY_MIN; dy <= DY_MAX; dy++) out.push(dy);
  return out;
}

interface ReachBuild {
  reach: Record<Tier, number[][]>;
  reachRaw: Record<Tier, number[][]>;
  impossible: number[][];
  limits: Record<Tier, KnightLimits>;
}

/** Reach tables, impossibility bounds and limits for every tier. */
export function buildReach(): ReachBuild {
  const dys = dyList();
  const maxRw = RUNWAYS.length - 1;

  // Raw solver output, [sampleRunwayIndex][dyIndex]. Sampled past the
  // last table runway so the suffix minimum below sees steady-state speed.
  const spectra = SAMPLE_RUNWAYS.map((runwayTiles) =>
    dys.map((dy) => solveJump({ runwayTiles, deltaYTiles: -dy })),
  );

  const reach = {} as Record<Tier, number[][]>;
  const reachRaw = {} as Record<Tier, number[][]>;
  const limits = {} as Record<Tier, KnightLimits>;

  for (const tier of TIERS) {
    // Requirable reach with AT LEAST r tiles of run-up = the minimum over
    // every longer run-up too (see the header: sub-pixel phase makes the raw
    // solve wobble by ~0.1 tile with run-up length, and a level cannot make
    // the player start their run on an exact pixel).
    const raw: number[][] = RUNWAYS.map((r) =>
      dys.map((_, i) => {
        let v = Infinity;
        for (let s = r; s < SAMPLE_RUNWAYS.length; s++) {
          v = Math.min(v, Math.max(0, gapForTier(spectra[s][i], tier)));
        }
        return v;
      }),
    );
    const floored = raw.map((row) => row.map((v) => Math.floor(v)));

    // Highest rise (dy < 0) at which a 1-tile gap still lands with full run-up.
    let maxRise = 0;
    dys.forEach((dy, i) => {
      if (dy < 0 && floored[maxRw][i] >= 1) maxRise = Math.max(maxRise, -dy);
    });

    reach[tier] = floored.map((row) =>
      row.map((g, i) => {
        if (g >= 1) return g;
        const dy = dys[i];
        // Level or lower: walking off / stepping across always works.
        // Higher but within maxRise: a jump straight up the face works.
        return dy >= 0 || -dy <= maxRise ? 0 : -1;
      }),
    );
    reachRaw[tier] = raw.map((row) => row.map(round3));

    const flat = dys.indexOf(0);
    limits[tier] = {
      maxGapStand: Math.max(0, reach[tier][0][flat]),
      maxGapRun: Math.max(0, reach[tier][maxRw][flat]),
      maxRise,
    };
  }

  // The impossibility bound is the opposite question (best case), so it
  // takes the MAXIMUM over every run-up the player could choose to use,
  // including the steady-state samples beyond the last row.
  const impossible: number[][] = RUNWAYS.map((r) =>
    dys.map((_, i) => {
      let v = 0;
      const limit =
        r === RUNWAYS[RUNWAYS.length - 1] ? SAMPLE_RUNWAYS.length - 1 : r;
      for (let s = 0; s <= limit; s++) {
        const sp = spectra[s][i];
        v = Math.max(v, sp.bestCaseUltraTiles > 0 ? sp.impossibleTiles : 0);
      }
      return v;
    }),
  );

  return { reach, reachRaw, impossible, limits };
}

/** Coin arcs for every (gap, dy) the design tier can land with full run-up. */
export function buildArcs(
  reach: Record<Tier, number[][]>,
  tier: Tier = DESIGN_TIER,
): ArcEntry[] {
  const dys = dyList();
  const row = reach[tier][RUNWAYS.length - 1];
  const traced = traceArcs(
    dys,
    (dy) => row[dy - DY_MIN],
    RUNWAYS[RUNWAYS.length - 1],
  );
  return traced.map((a) => ({
    gap: a.gap,
    dy: a.dy,
    cells: a.cells.flat(),
    coins: a.coins.flat(),
    sweep: a.sweep.flat(),
    apexDy: a.apexDy,
    input: a.input,
    overshootPx: Math.round(a.overshootPx * 100) / 100,
  }));
}

/** Everything in tables.json, computed in memory. */
export function buildTables(): JumpTables {
  const { reach, reachRaw, impossible, limits } = buildReach();
  const physics: Record<string, number> = {};
  for (const [k, v] of Object.entries(PLAYER_PHYSICS)) physics[k] = v;
  return {
    version: 1,
    source: {
      fork: "PartyD1/Pewter-The-Platformer@b36ff59 (apps/editor/src/player)",
      generator: "packages/jump-tables/src/export.ts",
      physics,
      bodyPx: { width: PLAYER_BODY_PX.width, height: PLAYER_BODY_PX.height },
      tilePx: TILE,
      frameRates: SOLVER_FRAME_RATES.map((dt) => Math.round(1 / dt)),
    },
    designTier: DESIGN_TIER,
    tiers: [...TIERS],
    runways: [...RUNWAYS],
    dyMin: DY_MIN,
    dyMax: DY_MAX,
    reach,
    reachRaw,
    impossible,
    limits,
    arcs: {
      tier: DESIGN_TIER,
      renderHz: Math.round(1 / ARC_RENDER_DT),
      entries: buildArcs(reach, DESIGN_TIER),
    },
  };
}

/**
 * Stable, diff-friendly JSON: objects indented, arrays of scalars on one
 * line, each arc entry on one line. Deterministic for identical input.
 */
export function serializeTables(t: JumpTables): string {
  const isScalar = (v: unknown) => v === null || typeof v !== "object";
  const fmt = (v: unknown, indent: string, inline: boolean): string => {
    if (isScalar(v)) return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.every(isScalar) || inline) {
        return "[" + v.map((x) => fmt(x, "", true)).join(",") + "]";
      }
      const inner = indent + "  ";
      return (
        "[\n" +
        v.map((x) => inner + fmt(x, inner, false)).join(",\n") +
        "\n" +
        indent +
        "]"
      );
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (inline) {
      return (
        "{" +
        entries
          .map(([k, x]) => JSON.stringify(k) + ":" + fmt(x, "", true))
          .join(",") +
        "}"
      );
    }
    const inner = indent + "  ";
    return (
      "{\n" +
      entries
        .map(([k, x]) => {
          // One arc entry per line keeps the file reviewable.
          const oneLine = k === "entries";
          const body = oneLine
            ? "[\n" +
              (x as unknown[])
                .map((e) => inner + "  " + fmt(e, "", true))
                .join(",\n") +
              "\n" +
              inner +
              "]"
            : fmt(x, inner, false);
          return inner + JSON.stringify(k) + ": " + body;
        })
        .join(",\n") +
      "\n" +
      indent +
      "}"
    );
  };
  return fmt(t, "", false) + "\n";
}
