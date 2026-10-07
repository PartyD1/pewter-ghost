/**
 * G-16 — playability: can the knight get through the section a suggestion
 * changes, with the suggestion accepted?
 *
 *  1. Section: from the nearest standable cell BEFORE the suggestion (left of
 *     its leftmost column; preferring cells the rules can reach from the
 *     level start) to the first standable column AFTER it (right of its
 *     rightmost column). With nothing standable after it (an Extend at the
 *     frontier), the goal is the rightmost standable column inside it. The
 *     search is bounded to the section plus `margin` (2) columns each side,
 *     so long levels stay under the cap and the agent cannot leave the level
 *     for a run-up.
 *  2. Rule check (@physsim checkRules, jump tables, design tier): a fast
 *     pre-filter. Fail = stage "rules".
 *  3. Playtest agent (AgentClient.verify, in the worker), cap
 *     config.agentCapMs; over the cap counts as a fail. Fail = stage "agent".
 *
 * A Fix is checked the same way on the repaired level: the repaired section
 * must be beatable. The verdict carries the agent's route for the overlay.
 */
import {
  checkRules,
  isStandable,
  reachability,
  type AgentQuery,
  type AgentResult,
  type RuleOptions,
  type SolidGrid,
  type TileRect,
  type XRange,
} from "@physsim";
import type { Point, Suggestion, Verdict } from "../contracts";
import { config as liveConfig, type GhostConfig } from "../suggest/config";
import { mergeSuggestion, nowMs, snapshotOf, solidGridOf, suggestionBounds, type LevelSource } from "./merge";

/** The part of AgentClient the verifier uses (a real client or a test double). */
export interface AgentLike {
  verify(q: AgentQuery, o?: { signal?: AbortSignal }): Promise<AgentResult>;
}

export interface PlayabilityOptions {
  /** Columns of slack each side of the section. Default 2 (plan G-16). */
  margin?: number;
  /** How far left of the suggestion to look for a standable start, in columns. Default 12. */
  lookBehind?: number;
  /** How far right of the suggestion to look for a standable goal, in columns. Default 12. */
  lookAhead?: number;
  /** Rule check options (tier, arc). xRange is set by the verifier. */
  rules?: Omit<RuleOptions, "xRange">;
  signal?: AbortSignal;
  now?: () => number;
}

export type PlayabilityConfig = Pick<GhostConfig, "agentCapMs">;

/** Where the section starts and ends. */
export interface Section {
  from: Point;
  to: TileRect;
  xRange: XRange;
  /** True when the goal is inside the suggestion (nothing standable after it). */
  goalInside: boolean;
}

export interface PlayabilityVerdict extends Verdict {
  section?: Section;
  /** True when the agent ran over its cap (counted as a fail). */
  timedOut?: boolean;
  /** Agent result, when the agent ran. */
  agent?: AgentResult;
}

const inRect = (r: TileRect, p: Point) =>
  p.x >= (r.x0 ?? -Infinity) && p.x <= (r.x1 ?? Infinity) && p.y >= (r.y0 ?? -Infinity) && p.y <= (r.y1 ?? Infinity);

const standableIn = (g: SolidGrid, x: number): number[] => {
  const ys: number[] = [];
  for (let y = 0; y + 1 < g.h; y++) if (isStandable(g, x, y)) ys.push(y);
  return ys;
};

/**
 * Choose the section to play for a suggestion on `merged` (the level after
 * the suggestion). `before` is used to prefer starts reachable from the level
 * start. Null when nothing in or around the suggestion can be stood on.
 */
export function sectionFor(
  before: SolidGrid,
  merged: SolidGrid,
  start: Point,
  s: Pick<Suggestion, "adds" | "removes" | "entities">,
  o: PlayabilityOptions = {},
): Section | null {
  const b = suggestionBounds(s);
  if (!b) return null;
  const margin = o.margin ?? 2;
  const lookBehind = o.lookBehind ?? 12;
  const lookAhead = o.lookAhead ?? 12;
  const midY = (b.y0 + b.y1) / 2;

  // From: nearest standable column left of the suggestion; prefer cells the
  // rules reach from the level start (the person's drawing is assumed sound up
  // to there), then the cell closest in height to the suggestion.
  let reach: ReturnType<typeof reachability> | null = null;
  try {
    reach = reachability(before, start, { xRange: [0, Math.max(0, b.x0 - 1)] });
  } catch {
    reach = null;
  }
  let from: Point | null = null;
  for (let x = b.x0 - 1; x >= Math.max(0, b.x0 - lookBehind) && !from; x--) {
    const ys = standableIn(merged, x);
    if (!ys.length) continue;
    const reachable = reach ? ys.filter((y) => reach!.has({ x, y })) : [];
    const pool = reachable.length ? reachable : ys;
    pool.sort((p, q) => Math.abs(p - midY) - Math.abs(q - midY) || q - p);
    from = { x, y: pool[0] };
  }
  // Nothing before it: start inside the suggestion's leftmost standable column.
  if (!from) {
    for (let x = Math.max(0, b.x0); x <= Math.min(merged.w - 1, b.x1) && !from; x++) {
      const ys = standableIn(merged, x);
      if (ys.length) from = { x, y: ys.reduce((m, y) => (Math.abs(y - midY) < Math.abs(m - midY) ? y : m)) };
    }
  }
  if (!from) return null;

  // To: first standable column right of the suggestion.
  let goalX = -1;
  let goalInside = false;
  for (let x = b.x1 + 1; x <= Math.min(merged.w - 1, b.x1 + lookAhead); x++)
    if (standableIn(merged, x).length) {
      goalX = x;
      break;
    }
  let to: TileRect | null = null;
  if (goalX < 0) {
    goalInside = true;
    // Nothing after it (an Extend at the frontier): the knight must stand on
    // the suggestion's rightmost new surface, or else its rightmost standable column.
    const added = new Set(s.adds.map((p) => `${p.x},${p.y}`));
    for (let x = Math.min(merged.w - 1, b.x1); x >= Math.max(0, b.x0) && !to; x--) {
      const ys = standableIn(merged, x).filter((y) => added.has(`${x},${y + 1}`));
      if (ys.length) to = { x0: x, x1: x, y0: Math.min(...ys), y1: Math.max(...ys) };
    }
    for (let x = Math.min(merged.w - 1, b.x1); x >= Math.max(from.x, b.x0) && !to; x--)
      if (standableIn(merged, x).length) to = { x0: x, x1: x };
  }
  if (!to) to = goalX >= 0 ? { x0: goalX, x1: goalX } : { x0: from.x, x1: from.x };
  const x0 = Math.max(0, Math.min(from.x, b.x0) - margin);
  const x1 = Math.min(merged.w - 1, Math.max(to.x1!, b.x1) + margin);
  return { from, to, xRange: [x0, x1], goalInside };
}

/**
 * Rule check, then the agent, on the level with `suggestion` applied.
 * Never throws for a bad level; rejects only with the AbortError of `signal`.
 */
export async function verifyPlayability(
  level: LevelSource,
  suggestion: Pick<Suggestion, "kind" | "adds" | "removes" | "entities">,
  agent: AgentLike,
  cfg: PlayabilityConfig = liveConfig,
  o: PlayabilityOptions = {},
): Promise<PlayabilityVerdict> {
  const clock = o.now ?? nowMs;
  const t0 = clock();
  const snap = snapshotOf(level);
  const merged = mergeSuggestion(snap, suggestion);
  const beforeGrid = solidGridOf(snap);
  const grid = solidGridOf(merged);
  const section = sectionFor(beforeGrid, grid, snap.start, suggestion, o);
  if (!section) {
    // Nothing standable in or around it: an entity-only suggestion in mid air,
    // or terrain the knight can never stand on. Only the former is harmless.
    const terrain = suggestion.adds.length + suggestion.removes.length > 0;
    return terrain
      ? { ok: false, stage: "rules", reason: "nothing in or next to the suggestion can be stood on, so the knight cannot get through it", ms: clock() - t0 }
      : { ok: true, stage: "agent", path: [], ms: clock() - t0 };
  }

  const rules = checkRules(grid, section.from, section.to, { ...o.rules, xRange: section.xRange });
  if (!rules.ok) {
    return {
      ok: false,
      stage: "rules",
      reason: `${rules.reason ?? "the jump rules cannot get the knight through"} (going from (${section.from.x},${section.from.y}) to column ${section.to.x0})`,
      section,
      ms: clock() - t0,
    };
  }
  if (inRect(section.to, section.from)) return { ok: true, stage: "agent", path: [section.from], section, ms: clock() - t0 };

  const r = await agent.verify(
    { grid, from: section.from, to: section.to, xRange: section.xRange, capMs: cfg.agentCapMs },
    { signal: o.signal },
  );
  if (r.found) return { ok: true, stage: "agent", path: r.path, section, agent: r, ms: clock() - t0 };
  const reason = r.timedOut
    ? `the playtest agent found no way from (${section.from.x},${section.from.y}) to column ${section.to.x0} within ${cfg.agentCapMs} ms${r.blockedAt ? `; it got as far as (${r.blockedAt.x},${r.blockedAt.y})` : ""}. Make the section simpler or easier`
    : (r.reason ?? `the knight cannot get from (${section.from.x},${section.from.y}) to column ${section.to.x0}`);
  return { ok: false, stage: "agent", reason, section, agent: r, timedOut: r.timedOut, ms: clock() - t0 };
}
