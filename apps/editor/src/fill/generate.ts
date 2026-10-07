/**
 * G-35 — pure generation: fill a level screen by screen with any Filler
 * (the LLM or the algorithm), verifying every piece exactly as a live ghost
 * is verified (validator, rule check, playtest agent), and return a new
 * snapshot. The caller's level is never modified.
 *
 * Each step:
 *   1. frontier = the rightmost standing cell the rule check reaches from the
 *      start (so every piece grows the part of the level the knight can get to);
 *   2. a FillRequest (mode "requested", no recent placements) whose window
 *      puts the frontier a quarter of the way in, with measured numbers, the
 *      brief and the pieces generated so far as lastGhosts;
 *   3. filler.fill -> verifyOnce; a failure goes back to the filler as
 *      previousFailure (up to maxAttempts), then generation stops as "stuck";
 *   4. the verified piece is applied (authored as Ghost) and becomes history.
 * It stops when the frontier reaches `toX` (default: the last screen), and
 * puts the goal on the rightmost reachable standing cell.
 *
 * Not wired into the UI: `installGenerateHook()` exposes
 * `window.__pewter.generate(filler?, options?)` for studies and the console.
 */
import { AgentClient, reachability, type SolidGrid } from "@physsim";
import { knightLimits } from "@jump-tables";
import {
  TILE,
  type Filler,
  type FillerName,
  type FillRequest,
  type GhostHistoryItem,
  type LevelSnapshot,
  type Point,
  type Suggestion,
  type Verdict,
  type VerdictStage,
} from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { config as liveConfig } from "../suggest/config";
import { solidGridOf } from "../verify/merge";
import type { AgentLike } from "../verify/playability";
import { verifyOnce } from "../verify/pipeline";
import type { RecentGhost } from "../verify/validate";
import { AlgoFiller } from "./AlgoFiller";
import { buildBrief, measureRequestWindow } from "./brief";
import { FillerRegistry, isAbortError } from "./Filler";
import { levelSummary, PLACEHOLDER_BRIEF, PLACEHOLDER_BRIEF_VERSION, renderGrid, type MeasureFn, type Rect } from "./window";

export const SCREEN_COLS = 24;

export interface GenerateOptions {
  /** Stop once the frontier reaches this column (default: w - 6, the level's last few columns). */
  toX?: number;
  /** Alternatively: generate this many screens past the starting frontier (capped by toX). */
  screens?: number;
  /** Playtest agent (default a new AgentClient: a Worker in the browser, in-process in Node; disposed after). */
  agent?: AgentLike;
  /** Verify each piece (default true). Without it, pieces are only checked to move the frontier. */
  verify?: boolean;
  /** Filler calls per piece, including send-backs (default 4). */
  maxAttempts?: number;
  /** Most pieces in one run (default 64). */
  maxPieces?: number;
  /** Window size (default config.windowCols x windowRows). */
  cols?: number;
  rows?: number;
  /** Measured numbers for the window (default the brief's measureRequestWindow). */
  measure?: MeasureFn;
  /** Brief text for each request: false = the placeholder; default buildBrief over the level so far. */
  brief?: false | ((ctx: { level: LevelSnapshot; frontierX: number; lastGhosts: GhostHistoryItem[] }) => { text: string; version: string });
  /** Past pieces sent as lastGhosts (default config.historyCount). */
  historyCount?: number;
  /** Lay a short floor under the start when the level has nothing to stand on (default true). */
  seedFloor?: boolean;
  /** Put the goal on the rightmost reachable standing cell at the end (default true). */
  placeGoal?: boolean;
  signal?: AbortSignal;
  /** Progress callbacks. */
  onPiece?: (piece: GeneratedPiece) => void;
  onFailure?: (failure: GenerateFailure) => void;
  clock?: () => number;
}

export interface GeneratedPiece {
  index: number;
  suggestion: Suggestion;
  verdict: Verdict | null;
  /** Filler calls this piece took. */
  attempts: number;
  /** Frontier column before and after the piece. */
  fromX: number;
  toX: number;
}

export interface GenerateFailure {
  piece: number;
  attempt: number;
  stage: VerdictStage | "none" | "progress" | "error";
  reason: string;
}

export type GenerateStop = "done" | "stuck" | "aborted" | "maxPieces";

export interface GenerateResult {
  snapshot: LevelSnapshot;
  pieces: GeneratedPiece[];
  failures: GenerateFailure[];
  stopped: GenerateStop;
  /** Frontier column at the end. */
  frontierX: number;
  goal?: Point;
  filler: FillerName;
  ms: number;
}

const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The rightmost standing cell the rule check reaches from the start (ties:
 * the highest), or null when the start has nothing under it.
 */
export function reachableFrontier(grid: SolidGrid, start: Point): Point | null {
  let r;
  try {
    r = reachability(grid, start);
  } catch {
    return null;
  }
  if (!r.start) return null;
  let best: Point = r.start;
  for (const p of r.cells()) if (p.x > best.x || (p.x === best.x && p.y < best.y)) best = p;
  return best;
}

/** The request generation sends for a frontier standing cell `f` (level coordinates). */
export function generationRequest(
  model: LevelModel,
  f: Point,
  o: {
    cols?: number;
    rows?: number;
    measure?: MeasureFn;
    brief?: { text: string; version: string };
    lastGhosts?: GhostHistoryItem[];
    previousFailure?: FillRequest["previousFailure"];
    idleMs?: number;
  } = {},
): FillRequest {
  const w = Math.min(o.cols ?? liveConfig.windowCols, model.w);
  const h = Math.min(o.rows ?? liveConfig.windowRows, model.h);
  const surfaceY = f.y + 1;
  const rect: Rect = {
    x: clamp(f.x - Math.floor(w / 4), 0, model.w - w),
    y: clamp(surfaceY - (h - 4), 0, model.h - h),
    w,
    h,
  };
  const origin = { x: rect.x, y: rect.y };
  const req: FillRequest = {
    grid: renderGrid(model, rect),
    origin,
    size: { w, h },
    recent: [],
    frontier: { x: f.x - origin.x, y: surfaceY - origin.y, idleMs: Math.round(o.idleMs ?? liveConfig.longPauseMs) },
    knight: knightLimits(),
    measured: (o.measure ?? measureRequestWindow)(model, rect),
    brief: o.brief?.text ?? PLACEHOLDER_BRIEF,
    briefVersion: o.brief?.version ?? PLACEHOLDER_BRIEF_VERSION,
    lastGhosts: (o.lastGhosts ?? []).map((g) => ({ ...g })),
    mode: "requested",
    summary: levelSummary(model, rect),
  };
  if (o.previousFailure) req.previousFailure = { ...o.previousFailure };
  return req;
}

/** Lay a 6-column floor (grass over dirt) under the start when nothing there can be stood on. */
function seedStartFloor(model: LevelModel): boolean {
  const s = model.start;
  if (s.y + 1 >= model.h) return false;
  for (let y = s.y + 1; y < model.h; y++) if (model.isSolid(s.x, y)) return false;
  const cells = [];
  for (let x = Math.max(0, s.x - 2); x <= Math.min(model.w - 1, s.x + 3); x++) {
    cells.push({ x, y: s.y + 1, tile: TILE.GRASS });
    if (s.y + 2 < model.h) cells.push({ x, y: s.y + 2, tile: TILE.DIRT });
  }
  model.applySuggestion({ id: "generate-seed", adds: cells, removes: [], entities: [] });
  return true;
}

const abortError = () => {
  const e = new Error("generation aborted");
  e.name = "AbortError";
  return e;
};

/**
 * Generate the rest of a level with `filler`. Resolves with a new snapshot
 * (the input is untouched); never rejects except for a programming error.
 */
export async function generateLevel(
  level: LevelModel | LevelSnapshot,
  filler: Filler,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const clock = opts.clock ?? defaultClock;
  const t0 = clock();
  const snap0 = level instanceof LevelModel ? level.snapshot() : level;
  const model = LevelModel.fromSnapshot(snap0, { clock });
  const ownAgent = opts.agent ? null : new AgentClient();
  const agent: AgentLike = opts.agent ?? ownAgent!;
  const pieces: GeneratedPiece[] = [];
  const failures: GenerateFailure[] = [];
  const history: GhostHistoryItem[] = [];
  const recentGhosts: RecentGhost[] = [];
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const maxPieces = Math.max(1, opts.maxPieces ?? 64);
  const historyCount = opts.historyCount ?? liveConfig.historyCount;
  const verify = opts.verify !== false;
  let stopped: GenerateStop = "done";

  const fail = (f: GenerateFailure) => {
    failures.push(f);
    opts.onFailure?.(f);
  };
  const frontierNow = () => reachableFrontier(solidGridOf(model.snapshot()), model.start);

  try {
    if (opts.seedFloor !== false && !frontierNow()) seedStartFloor(model);
    let f = frontierNow();
    const lastX = model.w - 6;
    let toX = Math.min(lastX, opts.toX ?? lastX);
    if (opts.screens !== undefined && f) toX = Math.min(toX, f.x + Math.max(0, opts.screens) * SCREEN_COLS);

    while (f && f.x < toX) {
      if (opts.signal?.aborted) throw abortError();
      if (pieces.length >= maxPieces) {
        stopped = "maxPieces";
        break;
      }
      const index = pieces.length;
      let previousFailure: FillRequest["previousFailure"];
      let placed: GeneratedPiece | null = null;
      for (let attempt = 1; attempt <= maxAttempts && !placed; attempt++) {
        if (opts.signal?.aborted) throw abortError();
        const snap = model.snapshot();
        const lastGhosts = history.slice(-Math.max(0, historyCount));
        let brief: { text: string; version: string } | undefined;
        if (opts.brief === undefined) {
          try {
            const b = buildBrief({ level: snap, frontierX: f.x, lastGhosts });
            brief = { text: b.text, version: b.version };
          } catch {
            brief = undefined; // over budget: the placeholder brief
          }
        } else if (opts.brief) brief = opts.brief({ level: snap, frontierX: f.x, lastGhosts });
        const req = generationRequest(model, f, { cols: opts.cols, rows: opts.rows, measure: opts.measure, brief, lastGhosts, previousFailure });

        let s: Suggestion | null = null;
        try {
          s = await filler.fill(req, opts.signal);
        } catch (e) {
          if (isAbortError(e)) throw e;
          fail({ piece: index, attempt, stage: "error", reason: e instanceof Error ? e.message : String(e) });
          previousFailure = undefined;
          continue;
        }
        if (!s) {
          fail({ piece: index, attempt, stage: "none", reason: "the filler offered nothing" });
          previousFailure = { reason: "no suggestion was given; extend the level to the right of the frontier", stage: "shape" };
          continue;
        }
        const rightmost = Math.max(-1, ...s.adds.map((a) => a.x));
        if (rightmost <= f.x) {
          const reason = `the piece must add terrain to the right of column ${f.x - req.origin.x} (window), extending the level`;
          fail({ piece: index, attempt, stage: "progress", reason });
          previousFailure = { reason, stage: "shape" };
          continue;
        }
        let verdict: Verdict | null = null;
        if (verify) {
          verdict = await verifyOnce(snap, s, {
            agent,
            validate: { lastGhosts: recentGhosts.slice(-2), frontierX: f.x },
            signal: opts.signal,
          });
          if (!verdict.ok) {
            const reason = verdict.reason ?? `failed at ${verdict.stage}`;
            fail({ piece: index, attempt, stage: verdict.stage, reason });
            previousFailure = { reason, stage: verdict.stage };
            continue;
          }
        }
        model.applySuggestion(s);
        const next = frontierNow();
        if (!next || next.x <= f.x) {
          // Verified but it did not move the reachable frontier (e.g. only
          // decoration past a gap the rules will not cross): take it back.
          model.undo();
          const reason = "the piece did not let the knight get any further right";
          fail({ piece: index, attempt, stage: "progress", reason });
          previousFailure = { reason, stage: "agent" };
          continue;
        }
        const tags = (verdict as (Verdict & { tags?: string[] }) | null)?.tags;
        history.push({ kind: s.kind, label: s.label, outcome: "accepted", ...(tags?.length ? { patterns: [...tags] } : {}) });
        recentGhosts.push({ kind: s.kind, adds: s.adds, removes: s.removes, entities: s.entities, ...(tags ? { patterns: tags } : {}) });
        placed = { index, suggestion: s, verdict, attempts: attempt, fromX: f.x, toX: next.x };
        f = next;
      }
      if (!placed) {
        stopped = "stuck";
        break;
      }
      pieces.push(placed);
      opts.onPiece?.(placed);
    }
  } catch (e) {
    if (!isAbortError(e)) throw e;
    stopped = "aborted";
  } finally {
    ownAgent?.dispose();
  }

  const end = frontierNow();
  let goal: Point | undefined;
  if (opts.placeGoal !== false && end && stopped !== "aborted") {
    goal = end;
    model.setGoal(goal);
  }
  return {
    snapshot: model.snapshot(),
    pieces,
    failures,
    stopped,
    frontierX: end?.x ?? -1,
    ...(goal ? { goal } : {}),
    filler: filler.name,
    ms: clock() - t0,
  };
}

// ---------------------------------------------------------------------------
// window.__pewter.generate
// ---------------------------------------------------------------------------

export interface GenerateHookDeps {
  /** The live level (default window.__pewter.model). */
  getModel?: () => LevelModel | undefined;
  /** Fillers by name (default: a registry with an AlgoFiller). */
  fillers?: FillerRegistry;
  /** Object to attach `generate` to (default window.__pewter, created if missing). */
  target?: Record<string, unknown>;
}

export type GenerateHook = (
  filler?: FillerName,
  options?: GenerateOptions & { apply?: boolean },
) => Promise<GenerateResult>;

/**
 * Expose `generate(fillerName = "algo", { apply?, ...GenerateOptions })` on
 * window.__pewter (or `deps.target`). It generates from the live level and
 * resolves with the result; `apply: true` loads the generated snapshot into
 * the live model (one load, clears undo history). Returns the hook and an
 * uninstall function.
 */
export function installGenerateHook(deps: GenerateHookDeps = {}): { generate: GenerateHook; uninstall: () => void } {
  const g = globalThis as unknown as { window?: { __pewter?: Record<string, unknown> } };
  const target: Record<string, unknown> | undefined =
    deps.target ?? (g.window ? (g.window.__pewter ??= {} as Record<string, unknown>) : undefined);
  const registry = deps.fillers ?? new FillerRegistry([new AlgoFiller()]);
  const getModel = deps.getModel ?? (() => (target?.model instanceof LevelModel ? (target.model as LevelModel) : undefined));
  const generate: GenerateHook = async (name = "algo", options = {}) => {
    const model = getModel();
    if (!model) throw new Error("generate: no level model");
    const filler = registry.get(name);
    if (!filler) throw new Error(`generate: filler "${name}" is not registered (have ${registry.names().join(", ") || "none"})`);
    const { apply, ...rest } = options;
    const result = await generateLevel(model, filler, rest);
    if (apply) model.load(result.snapshot);
    return result;
  };
  if (target) target.generate = generate;
  return {
    generate,
    uninstall: () => {
      if (target && target.generate === generate) delete target.generate;
    },
  };
}
