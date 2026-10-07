/**
 * G-23 — whole-level patrol and the local fallback repair.
 *
 * Patrol: after config.patrolIdleMs without edits, the playtest agent plays
 * from the level start (or from the last point known beatable, when nothing
 * left of it changed since) to the person's frontier, in the worker, cap
 * config.patrolCapMs. If it cannot get through, `onBlocked` receives the
 * blocking point and a reason written for the model; the caller builds a
 * FillRequest in mode "patrol" (`patrolRequest`) and verifies the answer with
 * `verifyPatrolFix`, which falls back to `proposeRepair` when the model's fix
 * fails.
 *
 * A run that only times out (the agent neither found a way nor exhausted the
 * search) is NOT reported as blocked unless the rule check agrees: a Fix that
 * interrupts the person must rest on a real failure, not on a slow search.
 *
 * proposeRepair: the audit's clingo repair() idea (fewest tiles that make the
 * exit reachable; aspgen.py, repair_demos.json: two tiles for a 14-wide pit)
 * as a bounded search: every edit of <= 3 tiles in a row (adds of a
 * horizontal run of stones, removes of the top of a wall or the underside of a
 * ceiling) near the blocking point, cheapest first, screened by the rule check
 * and confirmed by the agent.
 */
import {
  checkRules,
  isStandable,
  makeSolid,
  reachability,
  settleStart,
  type AgentQuery,
  type AgentResult,
  type SolidGrid,
  type TileRect,
  type XRange,
} from "@physsim";
import { DESIGN_TIER, FULL_RUNWAY, knightLimits, maxGap } from "@jump-tables";
import {
  TILE,
  type FillRequest,
  type Filler,
  type LevelSnapshot,
  type LogEvent,
  type Point,
  type Suggestion,
  type TileId,
  type Verdict,
} from "../contracts";
import { config as liveConfig, type GhostConfig } from "../suggest/config";
import { nowMs, snapshotOf, solidGridOf, spanText, type LevelSource } from "./merge";
import type { AgentLike } from "./playability";
import { verifyWithSendBack, type VerifyDeps, type VerifyOutcome } from "./pipeline";

// ---------------------------------------------------------------------------
// Patrol
// ---------------------------------------------------------------------------

/** The part of AgentClient patrol uses. */
export interface PatrolAgent {
  patrol(q: AgentQuery, o?: { signal?: AbortSignal }): Promise<AgentResult>;
}

/** What patrol needs from the level model (LevelModel fits). */
export interface PatrolLevel {
  snapshot(): LevelSnapshot;
  readonly revision: number;
  subscribe(fn: (c: { cells: { x: number }[]; source: string; start?: Point }) => void): () => void;
}

export interface PatrolBlocked {
  /** Furthest standing cell the knight reaches (LEVEL coordinates). */
  blockedAt: Point;
  /** Written for the model. */
  reason: string;
  /** Where the patrol started and the column it had to reach. */
  from: Point;
  goalX: number;
}

export interface PatrolReport {
  /** true = got through, false = blocked, null = inconclusive (over cap, rules agree it is fine) or nothing to check. */
  beatable: boolean | null;
  blocked?: PatrolBlocked;
  ms: number;
  from?: Point;
  goalX?: number;
  path?: Point[];
  timedOut: boolean;
  /** True when the run started from the last known beatable point, not the level start. */
  incremental: boolean;
  /** Level revision the report is about. */
  revision: number;
  /** True when the answer was reused from a run on the same revision and frontier. */
  cached?: boolean;
}

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PatrolOptions {
  level: PatrolLevel;
  agent: PatrolAgent;
  config?: Pick<GhostConfig, "patrolIdleMs" | "patrolCapMs">;
  /** The person's frontier column (FillRequest.frontier.x). Default: the rightmost column with content. */
  frontier?: () => number | undefined;
  onReport?: (r: PatrolReport) => void;
  onBlocked?: (b: PatrolBlocked, r: PatrolReport) => void;
  /** Receives the `patrol` log event of every conclusive run (beatable true or false). */
  log?: (e: Extract<LogEvent, { type: "patrol" }>) => void;
  clock?: () => number;
  timers?: TimerApi;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function abortError(): Error {
  const e = new Error("patrol aborted");
  e.name = "AbortError";
  return e;
}
const isAbort = (e: unknown) => !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";

/** Rightmost column with a solid tile or an entity, or -1. */
export function contentFrontier(snap: LevelSnapshot): number {
  let fx = -1;
  for (let i = 0; i < snap.cells.length; i++) if (snap.cells[i]) fx = Math.max(fx, i % snap.w);
  for (const e of snap.entities) fx = Math.max(fx, e.x);
  return fx;
}

/** Rightmost column <= x that has a standable cell, or -1. */
export function standableColumnAtOrBefore(g: SolidGrid, x: number): number {
  for (let cx = Math.min(g.w - 1, x); cx >= 0; cx--)
    for (let y = 0; y + 1 < g.h; y++) if (isStandable(g, cx, y)) return cx;
  return -1;
}

export class Patrol {
  private readonly o: PatrolOptions;
  private readonly timers: TimerApi;
  private readonly clock: () => number;
  private timer: unknown = null;
  private unsub: (() => void) | null = null;
  private inflight: AbortController | null = null;
  /** Last standing cell known beatable from the start, valid while no column <= x changes. */
  private checkpointCell: Point | null = null;
  private last: { revision: number; goalX: number; report: PatrolReport } | null = null;

  constructor(o: PatrolOptions) {
    this.o = o;
    this.timers = o.timers ?? defaultTimers;
    this.clock = o.clock ?? nowMs;
  }

  private get cfg() {
    return this.o.config ?? liveConfig;
  }

  /** Last point known beatable (null after an edit to its left or a start move). */
  get checkpoint(): Point | null {
    return this.checkpointCell ? { ...this.checkpointCell } : null;
  }

  get running(): boolean {
    return this.inflight !== null;
  }

  /** Subscribe to the level and arm the idle timer. */
  start(): void {
    if (this.unsub) return;
    this.unsub = this.o.level.subscribe((c) => this.onChange(c));
    this.poke();
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.inflight?.abort();
    this.inflight = null;
  }

  /** Activity: cancel a running patrol and restart the idle countdown. */
  poke(): void {
    this.inflight?.abort();
    this.inflight = null;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.runNow().catch(() => undefined);
    }, this.cfg.patrolIdleMs);
  }

  /** Forget the checkpoint and cached result. */
  invalidate(): void {
    this.checkpointCell = null;
    this.last = null;
  }

  private onChange(c: { cells: { x: number }[]; source: string; start?: Point }): void {
    if (c.source === "load" || c.start) this.invalidate();
    else if (this.checkpointCell) {
      const cp = this.checkpointCell;
      // A change at or left of the checkpoint can change the route into it.
      if (c.cells.some((p) => p.x <= cp.x)) this.checkpointCell = null;
    }
    this.poke();
  }

  /** Run a patrol now (cancels a running one). Resolves with the report; rejects only on abort. */
  async runNow(): Promise<PatrolReport> {
    this.inflight?.abort();
    const ac = new AbortController();
    this.inflight = ac;
    const t0 = this.clock();
    const level = this.o.level;
    const revision = level.revision;
    const snap = level.snapshot();
    const grid = solidGridOf(snap);
    const frontier = this.o.frontier?.() ?? contentFrontier(snap);
    const goalX = standableColumnAtOrBefore(grid, Math.min(snap.w - 1, frontier));
    const finish = (r: PatrolReport): PatrolReport => {
      if (this.inflight === ac) this.inflight = null;
      this.last = { revision, goalX, report: r };
      // Inconclusive runs (over the cap with the rules agreeing, or nothing to
      // check) are not logged: the event's boolean would count them as "not
      // beatable" and skew the beatable-at-save metric.
      if (r.beatable !== null)
        this.o.log?.({ type: "patrol", t: this.clock(), beatable: r.beatable, blockedAt: r.blocked?.blockedAt, ms: r.ms });
      this.o.onReport?.(r);
      if (r.blocked && r.beatable === false) this.o.onBlocked?.(r.blocked, r);
      return r;
    };

    if (this.last && this.last.revision === revision && this.last.goalX === goalX) {
      if (this.inflight === ac) this.inflight = null;
      return { ...this.last.report, cached: true };
    }

    const start = settleStart(grid, snap.start);
    if (!start || goalX < 0 || goalX <= start.x) {
      return finish({
        beatable: start ? null : false,
        blocked: start
          ? undefined
          : { blockedAt: snap.start, reason: `the knight's start (${snap.start.x},${snap.start.y}) has no ground under it`, from: snap.start, goalX },
        ms: this.clock() - t0,
        timedOut: false,
        incremental: false,
        revision,
      });
    }

    const cp = this.checkpointCell;
    const incremental = !!cp && cp.x < goalX && isStandable(grid, cp.x, cp.y);
    if (cp && cp.x >= goalX) {
      // Everything up to the frontier is unchanged since it was beaten.
      return finish({ beatable: true, ms: this.clock() - t0, from: start, goalX, timedOut: false, incremental: true, revision });
    }
    const from = incremental ? cp! : start;
    const xRange: XRange = [0, Math.min(grid.w - 1, goalX + 2)];
    let r: AgentResult;
    try {
      r = await this.o.agent.patrol(
        { grid, from, to: { x0: goalX }, xRange, capMs: this.cfg.patrolCapMs, rules: true },
        { signal: ac.signal },
      );
    } catch (e) {
      if (this.inflight === ac) this.inflight = null;
      throw e;
    }
    if (ac.signal.aborted || level.revision !== revision) {
      if (this.inflight === ac) this.inflight = null;
      throw abortError();
    }
    const ms = this.clock() - t0;
    if (r.found) {
      const end = r.path[r.path.length - 1];
      const cell = end && isStandable(grid, end.x, end.y) ? end : end ? settleStart(grid, end) : null;
      if (cell) this.checkpointCell = cell;
      return finish({ beatable: true, ms, from, goalX, path: r.path, timedOut: r.timedOut, incremental, revision });
    }
    const rulesFail = r.rules && !r.rules.ok;
    if (r.timedOut && !r.exhausted && !rulesFail) {
      return finish({ beatable: null, ms, from, goalX, timedOut: true, incremental, revision });
    }
    const blockedAt = (r.timedOut ? r.rules?.blockedAt : undefined) ?? r.blockedAt ?? r.rules?.blockedAt ?? from;
    const reason =
      (r.timedOut ? r.rules?.reason : undefined) ??
      r.reason ??
      r.rules?.reason ??
      `the knight cannot get from (${from.x},${from.y}) to column ${goalX}`;
    return finish({
      beatable: false,
      blocked: { blockedAt, reason, from, goalX },
      ms,
      from,
      goalX,
      timedOut: r.timedOut,
      incremental,
      revision,
    });
  }
}

/**
 * The patrol FillRequest: `base` is a request built around the blocking point
 * (fill/window.ts centres on it); this sets mode, the window-relative
 * blockedAt and the reason (as previousFailure, stage "agent", which the
 * prompt already shows to the model).
 */
export function patrolRequest(base: FillRequest, b: PatrolBlocked): FillRequest {
  return {
    ...base,
    mode: "patrol",
    blockedAt: { x: b.blockedAt.x - base.origin.x, y: b.blockedAt.y - base.origin.y },
    previousFailure: { reason: b.reason, stage: "agent" },
  };
}

// ---------------------------------------------------------------------------
// Fallback repair
// ---------------------------------------------------------------------------

export interface RepairOptions {
  /** Most tiles one repair may change. Default 3. */
  maxTiles?: number;
  /** Time budget for the rule-screened search, ms. Default 400. */
  budgetMs?: number;
  /** Agent to confirm candidates (cap config.agentCapMs). Without it the rule check decides. */
  agent?: AgentLike;
  /** Rule-passing candidates confirmed with the agent at most. Default 4. */
  agentTries?: number;
  config?: Pick<GhostConfig, "agentCapMs">;
  /** Columns the target may be right of the blocking point. Default maxGapRun + 4. */
  lookAhead?: number;
  /** Tile for added stones. Default grass. */
  tile?: TileId;
  /** Allow removing tiles (lower a wall, open a ceiling). Default true. */
  allowRemoves?: boolean;
  id?: string;
  requestHash?: string;
  signal?: AbortSignal;
  now?: () => number;
}

interface Candidate {
  adds: Point[];
  removes: Point[];
  cost: number;
  dist: number;
}

let repairCounter = 0;

/** The local section a repair must open: from the blocking point to the next surface the rules cannot reach. */
export function repairTarget(
  grid: SolidGrid,
  start: Point,
  blockedAt: Point,
  lookAhead: number,
): { from: Point; to: TileRect; xRange: XRange; target: Point } | null {
  const from = isStandable(grid, blockedAt.x, blockedAt.y) ? blockedAt : settleStart(grid, blockedAt);
  if (!from) return null;
  const reach = reachability(grid, start);
  for (let x = from.x + 1; x <= Math.min(grid.w - 1, from.x + lookAhead); x++) {
    for (let y = 0; y + 1 < grid.h; y++) {
      if (!isStandable(grid, x, y) || reach.has({ x, y })) continue;
      return {
        from,
        to: { x0: x },
        xRange: [Math.max(0, from.x - FULL_RUNWAY - 1), Math.min(grid.w - 1, x + 2)],
        target: { x, y },
      };
    }
  }
  return null;
}

/**
 * Propose the cheapest local repair (<= maxTiles tiles) that lets the knight
 * past `blockedAt`. Returns an UNVERIFIED Suggestion (kind fix, mode patrol,
 * filler "algo"); verify it like any other (verifyPatrolFix does).
 */
export async function proposeRepair(
  level: LevelSource,
  blockedAt: Point,
  opts: RepairOptions = {},
): Promise<Suggestion | null> {
  const clock = opts.now ?? nowMs;
  const t0 = clock();
  const snap = snapshotOf(level);
  const grid = solidGridOf(snap);
  const limits = knightLimits(DESIGN_TIER);
  const maxTiles = Math.max(1, Math.min(3, opts.maxTiles ?? 3));
  const budget = opts.budgetMs ?? 400;
  const start = settleStart(grid, snap.start) ?? snap.start;
  const sec = repairTarget(grid, start, blockedAt, opts.lookAhead ?? limits.maxGapRun + 4);
  if (!sec) return null;
  const { from, to, xRange, target } = sec;

  const solid = makeSolid(grid);
  const occupied = new Set(snap.entities.map((e) => `${e.x},${e.y}`));
  occupied.add(`${snap.start.x},${snap.start.y}`);
  const yTop = Math.max(1, Math.min(from.y, target.y) - limits.maxRise);
  const yBot = Math.min(grid.h - 1, Math.max(from.y, target.y) + 2);
  const xLo = from.x;
  const xHi = target.x;
  const mid = { x: (from.x + target.x) / 2, y: (from.y + target.y) / 2 };

  const cands: Candidate[] = [];
  const free = (x: number, y: number) => !solid(x, y) && !occupied.has(`${x},${y}`);
  for (let k = 1; k <= maxTiles; k++) {
    // Adds: a horizontal run of k stones, each with room to stand on.
    for (let y = yTop; y <= yBot; y++)
      for (let x = xLo; x + k - 1 <= xHi; x++) {
        let ok = true;
        for (let i = 0; i < k && ok; i++) ok = free(x + i, y) && !solid(x + i, y - 1);
        if (!ok) continue;
        // A stone right under the takeoff/target cell would bury it.
        const adds = Array.from({ length: k }, (_, i) => ({ x: x + i, y }));
        if (adds.some((p) => (p.x === from.x && p.y === from.y) || (p.x === target.x && p.y === target.y))) continue;
        cands.push({ adds, removes: [], cost: k, dist: Math.hypot(x + (k - 1) / 2 - mid.x, y - mid.y) });
      }
    if (opts.allowRemoves === false) continue;
    // Removes: k tiles off the top of a column, or k off the underside of a ceiling.
    for (let x = xLo; x <= xHi; x++)
      for (let y = 0; y < grid.h; y++) {
        if (!solid(x, y)) continue;
        if (!solid(x, y - 1) && y > 0) {
          const run = Array.from({ length: k }, (_, i) => ({ x, y: y + i }));
          if (run.every((p) => solid(p.x, p.y)) && run[k - 1].y < grid.h - 1)
            cands.push({ adds: [], removes: run, cost: k + 0.5, dist: Math.hypot(x - mid.x, y - mid.y) });
        }
        if (!solid(x, y + 1) && y + 1 < grid.h && y > 0) {
          const run = Array.from({ length: k }, (_, i) => ({ x, y: y - i }));
          if (run.every((p) => p.y > 0 && solid(p.x, p.y)))
            cands.push({ adds: [], removes: run, cost: k + 0.5, dist: Math.hypot(x - mid.x, y - mid.y) });
        }
      }
  }
  cands.sort((a, b) => a.cost - b.cost || a.dist - b.dist);

  const work = new Uint8Array(grid.solid);
  const g2: SolidGrid = { w: grid.w, h: grid.h, solid: work };
  const passing: Candidate[] = [];
  let tierCost = Infinity;
  for (const c of cands) {
    if (c.cost > tierCost) break; // keep only the cheapest tier that works
    if (clock() - t0 > budget) break;
    if (opts.signal?.aborted) throw abortError();
    for (const p of c.adds) work[p.y * grid.w + p.x] = 1;
    for (const p of c.removes) work[p.y * grid.w + p.x] = 0;
    const ok = checkRules(g2, from, to, { xRange }).ok;
    for (const p of c.adds) work[p.y * grid.w + p.x] = 0;
    for (const p of c.removes) work[p.y * grid.w + p.x] = 1;
    if (ok) {
      passing.push(c);
      tierCost = c.cost;
    }
  }
  if (passing.length === 0) return null;

  let chosen: Candidate | null = null;
  if (opts.agent) {
    const capMs = (opts.config ?? liveConfig).agentCapMs;
    for (const c of passing.slice(0, opts.agentTries ?? 4)) {
      const solid2 = new Uint8Array(grid.solid);
      for (const p of c.adds) solid2[p.y * grid.w + p.x] = 1;
      for (const p of c.removes) solid2[p.y * grid.w + p.x] = 0;
      const r = await opts.agent.verify(
        { grid: { w: grid.w, h: grid.h, solid: solid2 }, from, to, xRange, capMs },
        { signal: opts.signal },
      );
      if (r.found) {
        chosen = c;
        break;
      }
    }
  } else chosen = passing[0];
  if (!chosen) return null;

  const tile = opts.tile ?? TILE.GRASS;
  const gap = Math.max(0, target.x - from.x - 1);
  const dy = target.y - from.y;
  let label: string;
  if (chosen.adds.length) {
    const xs = chosen.adds.map((p) => p.x);
    const clears = maxGap(dy, FULL_RUNWAY, DESIGN_TIER);
    label =
      gap > 0
        ? `${chosen.adds.length}-tile stepping stone at ${spanText(Math.min(...xs), Math.max(...xs))} · gap ${gap} · knight clears ${Math.max(0, clears)}`
        : `${chosen.adds.length}-tile step at ${spanText(Math.min(...xs), Math.max(...xs))} · rise ${-dy} · knight climbs ${limits.maxRise}`;
  } else {
    const x = chosen.removes[0].x;
    label = `remove ${chosen.removes.length} tile${chosen.removes.length === 1 ? "" : "s"} at x=${x} · the knight is stuck at x=${from.x}`;
  }
  const anchor = chosen.adds[0] ?? chosen.removes[0];
  return {
    id: opts.id ?? `repair-${++repairCounter}`,
    kind: "fix",
    adds: chosen.adds.map((p) => ({ x: p.x, y: p.y, tile })),
    removes: chosen.removes.map((p) => ({ x: p.x, y: p.y })),
    entities: [],
    confidence: 0.9,
    label,
    anchor: { x: anchor.x, y: anchor.y },
    requestHash: opts.requestHash ?? "local-repair",
    filler: "algo",
    latencyMs: clock() - t0,
    mode: "patrol",
    verified: false,
    attempts: 1,
  };
}

/**
 * The check a patrol fix must pass on top of the usual section check: with
 * the fix merged in, the agent must get from where the patrol started
 * (`blocked.from`) past the blocking point to the surface that was out of
 * reach (repairTarget), or to the patrol's goal column when no such surface is
 * near. A fix drawn away from the block fails here, so the send-back and the
 * fallback repair still run.
 */
export function patrolFixCheck(
  original: LevelSource,
  blocked: PatrolBlocked,
  agent: AgentLike,
  opts: { capMs?: number; lookAhead?: number } = {},
): (merged: LevelSnapshot, s: Suggestion, signal?: AbortSignal) => Promise<Verdict | null> {
  const snap0 = snapshotOf(original);
  const grid0 = solidGridOf(snap0);
  const start0 = settleStart(grid0, snap0.start) ?? snap0.start;
  const sec = repairTarget(grid0, start0, blocked.blockedAt, opts.lookAhead ?? knightLimits(DESIGN_TIER).maxGapRun + 4);
  const goalX = Math.min(grid0.w - 1, Math.max(0, sec ? sec.target.x : blocked.goalX));
  const bx = blocked.blockedAt.x;
  const by = blocked.blockedAt.y;
  const capMs = opts.capMs ?? liveConfig.patrolCapMs;
  return async (merged, _s, signal) => {
    const grid = solidGridOf(merged);
    const from = isStandable(grid, blocked.from.x, blocked.from.y) ? blocked.from : settleStart(grid, blocked.from);
    if (!from)
      return { ok: false, stage: "agent", reason: `the fix leaves no ground at (${blocked.from.x},${blocked.from.y}) where the knight starts this section`, ms: 0 };
    if (goalX <= from.x) return null;
    const r = await agent.verify(
      { grid, from, to: { x0: goalX }, xRange: [0, Math.min(grid.w - 1, goalX + 2)], capMs },
      { signal },
    );
    if (r.found) return { ok: true, stage: "agent", path: r.path, ms: r.ms };
    const why = r.timedOut ? "the agent ran out of time" : r.reason ?? `it is stuck at (${(r.blockedAt ?? from).x},${(r.blockedAt ?? from).y})`;
    return {
      ok: false,
      stage: "agent",
      reason: `the fix does not get the knight past (${bx},${by}): it still cannot reach column ${goalX} (${why}); put the fix at the blocking point`,
      ms: r.ms,
    };
  };
}

/**
 * Verify a patrol answer (send-back as usual), falling back to the local
 * repair when the model's fix fails or the model declined.
 *
 * Every candidate (model answers and the fallback) must also pass
 * patrolFixCheck: the merged level must be beatable from `blocked.from` past
 * the blocking point (cap config.patrolCapMs when given, else the live one).
 *
 * The fallback runs after the last ALLOWED model attempt: after two failures
 * when the send-back ran, after one when the first answer was too slow for a
 * send-back (>= sendBackIfUnderMs), and at once when the model declined.
 */
export function verifyPatrolFix(
  level: LevelSource,
  request: FillRequest,
  answer: Suggestion | null,
  filler: Pick<Filler, "fill">,
  blocked: PatrolBlocked,
  deps: VerifyDeps & { repair?: Omit<RepairOptions, "agent" | "signal"> },
): Promise<VerifyOutcome> {
  const snap = snapshotOf(level);
  const cfg = (deps.config ?? liveConfig) as Partial<GhostConfig>;
  const fixCheck = patrolFixCheck(snap, blocked, deps.agent, {
    capMs: cfg.patrolCapMs ?? liveConfig.patrolCapMs,
    lookAhead: deps.repair?.lookAhead,
  });
  const extra = deps.extraCheck;
  return verifyWithSendBack(snap, request, answer, filler, {
    ...deps,
    extraCheck: async (merged, s, signal) => {
      const v = extra ? await extra(merged, s, signal) : null;
      if (v && !v.ok) return v;
      return fixCheck(merged, s, signal);
    },
    fallback:
      deps.fallback ??
      (() =>
        proposeRepair(snap, blocked.blockedAt, {
          ...deps.repair,
          agent: deps.agent,
          config: deps.config,
          signal: deps.signal,
          requestHash: deps.repair?.requestHash ?? answer?.requestHash,
        })),
  });
}
