/**
 * AgentClient (G-16): promise-per-request access to the playtest agent.
 *
 *   const agent = new AgentClient();                 // Web Worker when available
 *   const r = await agent.verify({ grid, from, to, xRange: [40, 66] }, { signal });
 *   if (r.found) ...  r.path  // route for the overlay
 *   const p = await agent.patrol({ grid, from: level.start, to: { x0: frontierX } });
 *
 * - Runs in a Web Worker (worker.ts) when `Worker` exists, otherwise in
 *   process with the same runner, sliced so the event loop keeps turning
 *   (Node tests, environments without workers).
 * - Every request has a time cap (capMs, default from config) enforced in
 *   the search, plus a watchdog at capMs + slack: a request still running at
 *   the watchdog resolves as timedOut (a fail) and a stuck worker is
 *   replaced, re-sending any requests it still held.
 * - `signal` / `cancel(id)` reject the promise with an AbortError and stop
 *   the search at its next slice.
 */
import { config } from "../../../apps/editor/src/suggest/config";
import type { Point } from "../../../apps/editor/src/contracts";
import type { SolidGrid, TileRect, XRange } from "./grid";
import {
  AgentRunner,
  type AgentMessage,
  type AgentReply,
  type AgentRequest,
  type AgentRequestType,
  type AgentResult,
  type AgentRuleOptions,
} from "./protocol";
import type { SearchPass } from "./sim";

/** The part of the Worker API the client uses (real Worker or a test double). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent | Event) => void) | null;
}

/** What callers pass; the client fills in id, type and the flat grid. */
export interface AgentQuery {
  grid: SolidGrid;
  from: Point;
  to: Point | TileRect;
  capMs?: number;
  xRange?: XRange;
  maxNodes?: number;
  passes?: SearchPass[];
  weight?: number;
  rules?: boolean | AgentRuleOptions;
  rulesGate?: boolean;
}

export interface AgentCallOptions {
  signal?: AbortSignal;
}

export interface AgentClientOptions {
  /**
   * Worker to use: an instance, a factory, or null to force in-process.
   * Default: `createAgentWorker()` (null when Workers are unavailable).
   */
  worker?: WorkerLike | null | (() => WorkerLike | null);
  /** Extra ms past capMs before the watchdog gives up on a request. Default 250. */
  slackMs?: number;
  /** Slice length for the in-process runner, ms. Default 8. */
  sliceMs?: number;
}

/** Create the real module worker, or null when Workers are unavailable. */
export function createAgentWorker(): WorkerLike | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
  } catch {
    return null;
  }
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("agent request aborted", "AbortError");
  const e = new Error("agent request aborted");
  e.name = "AbortError";
  return e;
}

interface Pending {
  id: number;
  msg: AgentRequest;
  resolve: (r: AgentResult) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export class AgentClient {
  private worker: WorkerLike | null = null;
  private readonly factory: (() => WorkerLike | null) | null;
  private runner: AgentRunner | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly slackMs: number;
  private readonly sliceMs: number;
  private disposed = false;

  constructor(opts: AgentClientOptions = {}) {
    this.slackMs = opts.slackMs ?? 250;
    this.sliceMs = opts.sliceMs ?? 8;
    const w = opts.worker === undefined ? createAgentWorker : opts.worker;
    if (typeof w === "function") {
      this.factory = w;
      this.worker = this.spawn();
    } else {
      this.factory = null;
      this.worker = w ? this.wire(w) : null;
    }
  }

  /** "worker" when requests go to a Web Worker, else "inprocess". */
  get mode(): "worker" | "inprocess" {
    return this.worker ? "worker" : "inprocess";
  }

  /** Requests in flight. */
  get inFlight(): number {
    return this.pending.size;
  }

  /** Verify a section: from the standing cell before it to the one after. Cap default config.agentCapMs. */
  verify(q: AgentQuery, o: AgentCallOptions = {}): Promise<AgentResult> {
    return this.request("verify", { capMs: config.agentCapMs, ...q }, o);
  }

  /** Whole-level patrol: start to the frontier. Cap default config.patrolCapMs. */
  patrol(q: AgentQuery, o: AgentCallOptions = {}): Promise<AgentResult> {
    return this.request("patrol", { capMs: config.patrolCapMs, ...q }, o);
  }

  request(type: AgentRequestType, q: AgentQuery, o: AgentCallOptions = {}): Promise<AgentResult> {
    if (this.disposed) return Promise.reject(new Error("AgentClient disposed"));
    if (o.signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    const solid = new Uint8Array(q.grid.w * q.grid.h);
    for (let i = 0; i < solid.length; i++) solid[i] = q.grid.solid[i] ? 1 : 0;
    const capMs = q.capMs ?? config.agentCapMs;
    const msg: AgentRequest = {
      id,
      type,
      grid: solid,
      w: q.grid.w,
      h: q.grid.h,
      from: q.from,
      to: q.to,
      capMs,
      xRange: q.xRange,
      maxNodes: q.maxNodes,
      passes: q.passes,
      weight: q.weight,
      rules: q.rules,
      rulesGate: q.rulesGate,
    };
    return new Promise<AgentResult>((resolve, reject) => {
      const onAbort = () => this.cancel(id);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      // The watchdog's clock starts when the request is sent; queued requests
      // behind a slow one get their own full allowance via `queuedSlack`.
      const timer = setTimeout(() => this.watchdog(id), capMs + this.slackMs + this.queuedSlack());
      const p: Pending = {
        id,
        msg,
        resolve,
        reject,
        timer,
        cleanup: () => {
          clearTimeout(p.timer);
          o.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending.set(id, p);
      this.send(msg);
    });
  }

  /** Cancel one request: its promise rejects with an AbortError. */
  cancel(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.cleanup();
    this.post({ id, type: "cancel" });
    p.reject(abortError());
  }

  /** Cancel everything in flight. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  /** Cancel everything and stop the worker. */
  dispose(): void {
    this.cancelAll();
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.runner = null;
  }

  // -------------------------------------------------------------------------

  /** Time the requests already queued may take before a new one starts. */
  private queuedSlack(): number {
    let t = 0;
    for (const p of this.pending.values()) t += (p.msg.capMs ?? 0) + 20;
    return t;
  }

  private spawn(): WorkerLike | null {
    if (!this.factory) return null;
    let w: WorkerLike | null = null;
    try {
      w = this.factory();
    } catch {
      w = null;
    }
    return w ? this.wire(w) : null;
  }

  private wire(w: WorkerLike): WorkerLike {
    w.onmessage = (e: MessageEvent) => this.receive(e.data as AgentReply);
    w.onerror = (e) => {
      if (e && typeof (e as Event).preventDefault === "function") (e as Event).preventDefault();
      const m = (e as Partial<ErrorEvent> | null)?.message;
      this.crashed(typeof m === "string" && m ? m : "agent worker error");
    };
    return w;
  }

  private send(msg: AgentRequest): void {
    if (this.worker) {
      // Copy, so a resend after a worker restart still has the grid.
      const copy = { ...msg, grid: new Uint8Array(msg.grid as Uint8Array) };
      this.worker.postMessage(copy, [copy.grid.buffer]);
    } else {
      this.local().submit(msg);
    }
  }

  private post(msg: AgentMessage): void {
    if (this.worker) this.worker.postMessage(msg);
    else this.runner?.handle(msg);
  }

  private local(): AgentRunner {
    if (!this.runner) this.runner = new AgentRunner((r) => this.receive(r), this.sliceMs);
    return this.runner;
  }

  private receive(reply: AgentReply): void {
    if (!reply || typeof reply !== "object") return;
    const p = this.pending.get(reply.id as number);
    if (!p) return; // cancelled or timed out already
    this.pending.delete(p.id);
    p.cleanup();
    if (reply.ok) {
      const { id: _id, type: _type, ok: _ok, ...result } = reply;
      p.resolve(result);
    } else if (reply.cancelled) {
      p.reject(abortError());
    } else {
      p.reject(new Error(`agent: ${reply.error}`));
    }
  }

  /** A request outlived capMs + slack: fail it, and replace a stuck worker. */
  private watchdog(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.cleanup();
    p.resolve({
      found: false,
      path: [],
      nodes: 0,
      ms: (p.msg.capMs ?? 0) + this.slackMs,
      timedOut: true,
      exhausted: false,
      reason: `The playtest agent did not answer within ${p.msg.capMs} ms.`,
    });
    if (this.worker && this.factory) {
      this.worker.terminate();
      this.worker = this.spawn();
      for (const q of this.pending.values()) this.send(q.msg);
    } else {
      this.post({ id, type: "cancel" });
    }
  }

  private crashed(message: string): void {
    const err = new Error(`agent worker crashed: ${message}`);
    for (const p of [...this.pending.values()]) {
      this.pending.delete(p.id);
      p.cleanup();
      p.reject(err);
    }
    this.worker?.terminate();
    this.worker = this.factory ? this.spawn() : null;
  }
}
