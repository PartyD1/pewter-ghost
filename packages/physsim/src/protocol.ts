/**
 * Agent request protocol (G-16 worker part), shared by the Web Worker entry
 * (worker.ts) and the in-process fallback (client.ts).
 *
 * Messages in:  AgentRequest  {id, type: "verify" | "patrol", grid, w, h, from, to, capMs, xRange, ...}
 *               AgentCancel   {id, type: "cancel"}
 * Messages out: AgentResponse {id, type, ok: true, found, path, ...}
 *               AgentFailure  {id, type, ok: false, error, cancelled?}
 *
 * The runner processes one request at a time, in slices of a few ms, so a
 * cancel message posted while a search is running is seen between slices
 * (a Worker cannot receive messages while it runs synchronous code).
 */
import { DEFAULT_CONFIG } from "../../../apps/editor/src/suggest/config";
import type { Point } from "../../../apps/editor/src/contracts";
import type { Tier } from "@jump-tables";
import { isPoint, settleStart, type SolidGrid, type Surface, type TileRect, type XRange } from "./grid";
import { checkRules, type ArcCheck } from "./rules";
import { AgentSearch, type Input, type SearchPass, type SearchResult } from "./sim";

export type AgentRequestType = "verify" | "patrol";

export interface AgentRuleOptions {
  tier?: Tier;
  arc?: ArcCheck;
}

/** One agent job. All coordinates in level tiles. */
export interface AgentRequest {
  id: number | string;
  type: AgentRequestType;
  /** Row-major solid map, length w*h (truthy = solid). */
  grid: Uint8Array | ArrayLike<number | boolean>;
  w: number;
  h: number;
  /** Start: a standing cell (snapped onto the surface below if needed). */
  from: Point;
  /**
   * Goal: a standing cell, or a rectangle of cells (patrol: `{x0: frontierX}`
   * = anywhere at or past the frontier column).
   */
  to: Point | TileRect;
  /** Wall-clock cap, ms. Defaults: verify config.agentCapMs, patrol config.patrolCapMs. */
  capMs?: number;
  /** Only simulate inside these columns (inclusive). */
  xRange?: XRange;
  maxNodes?: number;
  passes?: SearchPass[];
  weight?: number;
  /** Run the rule check too (default true). `false` skips it. */
  rules?: boolean | AgentRuleOptions;
  /** When the rule check fails, skip the agent and fail at once (default false). */
  rulesGate?: boolean;
}

export interface AgentCancel {
  id: number | string;
  type: "cancel";
}

export type AgentMessage = AgentRequest | AgentCancel;

export interface AgentRulesSummary {
  ok: boolean;
  reason?: string;
  path: Point[];
  unreachable: Surface[];
  blockedAt?: Point;
  ms: number;
}

/** Agent verdict. `found` is the playability verdict; over cap is a fail. */
export interface AgentResult {
  found: boolean;
  /** Body centre cells along the agent's route (for the path overlay). */
  path: Point[];
  /** Frame inputs at 60 fps that replay the route in the game. */
  inputs?: Input[];
  frames?: number;
  nodes: number;
  /** Total ms for this request (rules + agent). */
  ms: number;
  timedOut: boolean;
  exhausted: boolean;
  /** Furthest standing cell toward the goal (patrol's blocking point). */
  blockedAt?: Point;
  /** The settled start cell. */
  start?: Point;
  /** Readable reason when not found, written for the model. */
  reason?: string;
  rules?: AgentRulesSummary;
  /** True when the agent was skipped because the rule check failed (rulesGate). */
  gated?: boolean;
}

export interface AgentResponse extends AgentResult {
  id: number | string;
  type: AgentRequestType;
  ok: true;
}

export interface AgentFailure {
  id: number | string;
  type: AgentRequestType | "cancel";
  ok: false;
  error: string;
  cancelled?: boolean;
}

export type AgentReply = AgentResponse | AgentFailure;

export const DEFAULT_CAP_MS: Record<AgentRequestType, number> = {
  verify: DEFAULT_CONFIG.agentCapMs,
  patrol: DEFAULT_CONFIG.patrolCapMs,
};

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

function fmt(p: Point | TileRect): string {
  if (isPoint(p)) return `(${p.x},${p.y})`;
  const r = p as TileRect;
  if (r.x0 !== undefined && r.x1 === undefined && r.y0 === undefined && r.y1 === undefined) return `column ${r.x0}`;
  return `cells x ${r.x0 ?? "-"}..${r.x1 ?? "-"}, y ${r.y0 ?? "-"}..${r.y1 ?? "-"}`;
}

/** Validate a request's shape; returns an error string or null. */
export function validateRequest(req: AgentRequest): string | null {
  if (req.type !== "verify" && req.type !== "patrol") return `unknown request type ${String(req.type)}`;
  if (!Number.isInteger(req.w) || !Number.isInteger(req.h) || req.w <= 0 || req.h <= 0) return "bad grid size";
  if (!req.grid || req.grid.length !== req.w * req.h) return `grid length ${req.grid?.length} != w*h ${req.w * req.h}`;
  if (!isPoint(req.from)) return "bad from";
  if (!req.to || typeof req.to !== "object") return "bad to";
  return null;
}

/**
 * A job in progress. `step(sliceMs)` advances it and returns the reply once
 * there is a verdict.
 */
export class AgentJob {
  readonly req: AgentRequest;
  private readonly t0 = now();
  private search: AgentSearch | null = null;
  private rules?: AgentRulesSummary;
  private reply: AgentReply | null = null;

  constructor(req: AgentRequest) {
    this.req = req;
    const bad = validateRequest(req);
    if (bad) {
      this.reply = { id: req.id, type: req.type, ok: false, error: bad };
      return;
    }
    const grid: SolidGrid = { w: req.w, h: req.h, solid: req.grid };
    const capMs = req.capMs ?? DEFAULT_CAP_MS[req.type];
    const start = settleStart(grid, req.from);
    let to: Point | TileRect = req.to;
    if (isPoint(to)) to = settleStart(grid, to) ?? to;

    if (req.rules !== false) {
      const ro = typeof req.rules === "object" ? req.rules : {};
      const v = checkRules(grid, req.from, to, { ...ro, xRange: req.xRange });
      this.rules = {
        ok: v.ok,
        reason: v.reason,
        path: v.path,
        unreachable: v.unreachable,
        blockedAt: v.blockedAt,
        ms: v.ms,
      };
    }

    if (!start) {
      this.reply = this.done({
        found: false,
        path: [],
        nodes: 0,
        ms: 0,
        timedOut: false,
        exhausted: true,
        reason: `the start (${req.from.x},${req.from.y}) has no ground to stand on`,
        rules: this.rules,
      });
      return;
    }
    if (req.rulesGate && this.rules && !this.rules.ok) {
      this.reply = this.done({
        found: false,
        path: [],
        nodes: 0,
        ms: 0,
        timedOut: false,
        exhausted: false,
        start,
        blockedAt: this.rules.blockedAt,
        reason: this.rules.reason ?? "the jump rules cannot reach the goal",
        rules: this.rules,
        gated: true,
      });
      return;
    }
    const spent = now() - this.t0;
    this.search = new AgentSearch(grid, start, to, {
      capMs: Math.max(1, capMs - spent),
      xRange: req.xRange,
      maxNodes: req.maxNodes,
      passes: req.passes,
      weight: req.weight,
    });
  }

  private done(r: AgentResult): AgentResponse {
    return { ...r, ms: now() - this.t0, id: this.req.id, type: this.req.type, ok: true };
  }

  private fromSearch(s: SearchResult): AgentResponse {
    const req = this.req;
    let reason: string | undefined;
    if (!s.found) {
      const b = s.blockedAt ? ` It got as far as (${s.blockedAt.x},${s.blockedAt.y}).` : "";
      const head = s.timedOut
        ? `The playtest agent found no way from (${s.start.x},${s.start.y}) to ${fmt(req.to)} within ${req.capMs ?? DEFAULT_CAP_MS[req.type]} ms.`
        : `The knight cannot get from (${s.start.x},${s.start.y}) to ${fmt(req.to)}.`;
      reason = head + b + (this.rules && !this.rules.ok && this.rules.reason ? ` Rule check: ${this.rules.reason}.` : "");
    }
    return this.done({
      found: s.found,
      path: s.path,
      inputs: s.inputs,
      frames: s.frames,
      nodes: s.nodes,
      ms: 0,
      timedOut: s.timedOut,
      exhausted: s.exhausted,
      blockedAt: s.blockedAt,
      start: s.start,
      reason,
      rules: this.rules,
    });
  }

  /** Advance for at most sliceMs; returns the reply once finished. */
  step(sliceMs = Infinity): AgentReply | null {
    if (this.reply) return this.reply;
    try {
      const r = this.search!.run(sliceMs);
      if (r) this.reply = this.fromSearch(r);
    } catch (e) {
      this.reply = {
        id: this.req.id,
        type: this.req.type,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    return this.reply;
  }
}

/** Run one request to completion, synchronously. */
export function runRequest(req: AgentRequest): AgentReply {
  const job = new AgentJob(req);
  let r: AgentReply | null = null;
  while (!r) r = job.step();
  return r;
}

export type Scheduler = (fn: () => void) => void;

/** Yield to the event loop without the 4 ms setTimeout clamp where possible. */
export const defaultScheduler: Scheduler = (() => {
  const g = globalThis as { setImmediate?: (fn: () => void) => unknown };
  if (typeof g.setImmediate === "function") return (fn) => void g.setImmediate!(fn);
  if (typeof MessageChannel !== "undefined") {
    const ch = new MessageChannel();
    const q: (() => void)[] = [];
    ch.port1.onmessage = () => q.shift()?.();
    return (fn) => {
      q.push(fn);
      ch.port2.postMessage(0);
    };
  }
  return (fn) => void setTimeout(fn, 0);
})();

/**
 * FIFO job runner used by the worker and the in-process client. Jobs run
 * one at a time in slices; `cancel(id)` drops a queued job or stops the
 * running one at the next slice boundary and replies `cancelled`.
 */
export class AgentRunner {
  private queue: AgentRequest[] = [];
  private active: AgentJob | null = null;
  private scheduled = false;

  constructor(
    private readonly post: (reply: AgentReply) => void,
    private readonly sliceMs = 12,
    private readonly schedule: Scheduler = defaultScheduler,
  ) {}

  handle(msg: AgentMessage): void {
    if (msg.type === "cancel") this.cancel(msg.id);
    else this.submit(msg);
  }

  submit(req: AgentRequest): void {
    this.queue.push(req);
    this.kick();
  }

  cancel(id: number | string): void {
    const qi = this.queue.findIndex((r) => r.id === id);
    if (qi >= 0) {
      const [r] = this.queue.splice(qi, 1);
      this.post({ id, type: r.type, ok: false, error: "cancelled", cancelled: true });
      return;
    }
    if (this.active && this.active.req.id === id) {
      const r = this.active.req;
      this.active = null;
      this.post({ id, type: r.type, ok: false, error: "cancelled", cancelled: true });
      this.kick();
    }
  }

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  private kick(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.tick());
  }

  private tick(): void {
    this.scheduled = false;
    if (!this.active) {
      const next = this.queue.shift();
      if (!next) return;
      this.active = new AgentJob(next);
    }
    const job = this.active;
    const reply = job.step(this.sliceMs);
    if (reply) {
      if (this.active === job) this.active = null;
      this.post(reply);
    }
    if (this.active || this.queue.length) this.kick();
  }
}
