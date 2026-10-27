/**
 * Playability hints for the LLM from @measure surface transitions in the window.
 */
import { analyzeWindow, measuresOf, type Rect } from "@measure";
import { DESIGN_TIER, knightLimits } from "@jump-tables";
import type { FillRequest, KnightLimits } from "../contracts";
import type { WindowGrid } from "./windowGrid";

export interface ReachabilityHint {
  /** Window-relative column of the gap or step. */
  x: number;
  gap: number;
  dy: number;
  runway: number;
  reachable: boolean;
  /** design recommendation when gap is wide but still reachable */
  comfort: boolean;
  label: string;
  evidence: string;
}

export interface ReachabilityOptions {
  knight?: KnightLimits;
  /** Flag jumps at or above this empty width (default 5). */
  comfortGap?: number;
  /** Only transitions whose landing is within this many columns of the frontier. */
  frontierBand?: number;
}

function windowRect(g: WindowGrid): Rect {
  return { x: 0, y: 0, w: g.w, h: g.h };
}

function snapshotFromWindow(g: WindowGrid) {
  const n = g.w * g.h;
  return {
    w: g.w,
    h: g.h,
    cells: Array.from(g.tiles),
    entities: g.entities.map((e, i) => ({ id: `w${i}`, kind: e.kind, x: e.x, y: e.y })),
  };
}

/**
 * The first jump/step transition near the frontier worth fixing, or undefined.
 */
export function detectReachabilityHint(
  req: Pick<FillRequest, "frontier" | "knight">,
  g: WindowGrid,
  opts: ReachabilityOptions = {},
): ReachabilityHint | undefined {
  const limits = opts.knight ?? req.knight ?? knightLimits(DESIGN_TIER);
  const comfortGap = opts.comfortGap ?? 5;
  const band = opts.frontierBand ?? 10;
  const fx = req.frontier.x;

  const snap = snapshotFromWindow(g);
  const analysis = analyzeWindow(snap, snap.entities, windowRect(g), { tier: DESIGN_TIER });
  const m = measuresOf(analysis);
  if (m.counts.unreachable === 0 && m.counts.gaps === 0) return undefined;

  const { transitions, surfaces } = analysis.graph;
  const clears = (t: (typeof transitions)[0]) => {
    if (!t.reachable) return -1;
    return t.gap <= limits.maxGapRun ? t.gap : limits.maxGapRun;
  };

  type Cand = { t: (typeof transitions)[0]; prio: number };
  const cands: Cand[] = [];

  for (const t of transitions) {
    if (t.kind === "drop") continue;
    const land = t.landing;
    if (Math.abs(land.x - fx) > band) continue;
    const unreachable = !t.reachable;
    const wideComfort = t.kind === "jump" && t.reachable && t.gap >= comfortGap;
    if (!unreachable && !wideComfort) continue;
    const prio = (unreachable ? 1000 : 100) + t.gap * 10 + Math.abs(land.x - fx);
    cands.push({ t, prio });
  }
  cands.sort((a, b) => b.prio - a.prio);
  const pick = cands[0]?.t;
  if (!pick) return undefined;

  const gx = pick.landing.x;
  const height = pick.dy < 0 ? `, rise ${-pick.dy}` : pick.dy > 0 ? `, drop ${pick.dy}` : "";
  const clearText =
    pick.reachable && pick.gap >= comfortGap
      ? `gap ${pick.gap} is wide (comfort threshold ${comfortGap}); consider a stepping stone or lower landing`
      : pick.reachable
        ? `gap ${pick.gap} clears with run-up ${pick.runway}`
        : `gap ${pick.gap}${height}; knight clears ${clears(pick) >= 0 ? clears(pick) : limits.maxGapRun} with full run-up`;

  return {
    x: gx,
    gap: pick.gap,
    dy: pick.dy,
    runway: pick.runway,
    reachable: pick.reachable,
    comfort: pick.reachable && pick.gap >= comfortGap,
    label: pick.reachable && pick.gap >= comfortGap ? `gap ${pick.gap} · wide for this course` : `gap ${pick.gap} · needs fix`,
    evidence:
      `computed near frontier: ${clearText} at landing column x=${gx}. ` +
      `If fixing, use kind fix with the fewest tiles (stepping stone before bridging).`,
  };
}
