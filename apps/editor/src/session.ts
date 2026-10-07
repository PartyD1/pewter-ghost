/**
 * The whole Pewter Ghost loop (integration: G-17 / G-23 wiring, G-18 hooks, G-33 client).
 *
 *   LevelModel placements ──► PlacementStream ──► (debounced, newest wins)
 *     buildFillRequest + brief + measured numbers
 *       ──► active Filler (llm | stub | none) through FillScheduler
 *       ──► verifyWithSendBack (validator, rule check, agent; one send-back)
 *       ──► GhostSession.offer ──► SuggestionManager ──► GhostLayer / StatusStrip
 *   Tab ──► LevelModel.applySuggestion (ghost/session.ts)
 *   idle ──► Patrol (agent, start → frontier) ──► blocked ──► patrol FillRequest
 *       ──► verifyPatrolFix (send-back, then the local ≤3-tile repair) ──► Fix ghost
 *
 * Every step is logged through the research log: session (first), place / erase,
 * fill.call (superseded calls too, with the verdict stage and send-back),
 * ghost.show / ghost.end (ghost/session.ts), patrol, play.*, undo / redo, save
 * (editor). Events logged before the session resolves are buffered and written
 * after the `session` event.
 *
 * Config precedence: DEFAULT_CONFIG ← URL params (?filler=, ?proxy=,
 * ?callTimeoutMs=) ← GET /session overrides (launcher token, G-33). The
 * status strip never names the filler. filler "none" = human-only editing: no
 * calls, no patrol, no ghosts. "llm" needs a session token (?token=); without
 * one the session runs as "none" (the proxy would refuse every call).
 *
 * Two layers:
 *   FillLoop     — Phaser-free orchestration (Node-testable).
 *   PewterApp    — boot glue: session token, config, EventLog, fillers,
 *                  agent, and the Phaser ghost session once the editor is ready.
 */
import {
  AgentClient,
  type AgentQuery,
  type AgentResult,
} from "@physsim";
import type {
  FillMode,
  FillRequest,
  Filler,
  FillerName,
  GhostHistoryItem,
  GhostOutcome,
  LogEvent,
  PlacementEvent,
  Suggestion,
  VerdictStage,
  VerifiedSuggestion,
} from "./contracts";
import type { EditorApi } from "./editor/api";
import { BRIEF_VERSION, BriefCache, measureRequestWindow, type Brief } from "./fill/brief";
import { FillerRegistry, StubFiller, type ActiveFiller } from "./fill/Filler";
import { requestHash } from "./fill/hash";
import {
  FillScheduler,
  LLMFiller,
  fillCallEvent,
  type DetailedFiller,
  type FillCallEvent,
  type FillResult,
} from "./fill/LLMFiller";
import { PROMPT_VERSION } from "./fill/prompt";
import { PlacementStream } from "./fill/stream";
import { buildFillRequest } from "./fill/window";
import type { DevFillInfo } from "./ghost/devOverlay";
import type { GhostSession, GhostSessionOptions } from "./ghost/session";
import type { LevelModel } from "./level/LevelModel";
import { EventLog, setActiveLog } from "./research/log";
import { fetchSession, readTokenFromUrl, type SessionInfo } from "./research/session";
import { applyOverrides, config as liveConfig, DEFAULT_CONFIG, type GhostConfig } from "./suggest/config";
import type { ManagerListeners, OfferOptions, OfferResult } from "./suggest/SuggestionManager";
import {
  Patrol,
  patrolRequest,
  verifyPatrolFix,
  type PatrolBlocked,
  type PatrolReport,
  type TimerApi,
} from "./verify/patrol";
import { verifyWithSendBack, type AttemptVerdict, type VerifyDeps, type VerifyOutcome } from "./verify/pipeline";
import type { AgentLike } from "./verify/playability";
import type { RecentGhost } from "./verify/validate";

// ---------------------------------------------------------------------------
// Config resolution (G-33)
// ---------------------------------------------------------------------------

const FILLER_VALUES: readonly GhostConfig["filler"][] = ["llm", "algo", "stub", "none"];

/**
 * Config overrides from the page URL: ?filler=stub|llm|none|algo,
 * ?proxy=<url>, ?callTimeoutMs=<ms>. Unknown or malformed values are ignored.
 */
export function urlOverrides(search: string | URLSearchParams): Partial<GhostConfig> {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const out: Partial<GhostConfig> = {};
  const filler = p.get("filler");
  if (filler && (FILLER_VALUES as readonly string[]).includes(filler)) out.filler = filler as GhostConfig["filler"];
  const proxy = p.get("proxy");
  if (proxy && /^https?:\/\/[^\s]+$/i.test(proxy)) out.proxyUrl = proxy.replace(/\/+$/, "");
  const timeout = Number(p.get("callTimeoutMs"));
  if (p.has("callTimeoutMs") && Number.isFinite(timeout) && timeout > 0) out.callTimeoutMs = Math.round(timeout);
  return out;
}

/**
 * DEFAULT_CONFIG ← URL overrides ← the proxy's per-token overrides (only when
 * the proxy actually answered; the local fallback's condition is ignored).
 */
export function resolveConfig(
  url: Partial<GhostConfig>,
  session: Pick<SessionInfo, "fromProxy" | "overrides"> | null,
  base: GhostConfig = DEFAULT_CONFIG,
): GhostConfig {
  const out: GhostConfig = { ...structuredClone(base), ...url };
  if (session?.fromProxy) Object.assign(out, session.overrides);
  return out;
}

// ---------------------------------------------------------------------------
// Buffered research log
// ---------------------------------------------------------------------------

export interface LogTarget {
  log(e: LogEvent): void;
}

/**
 * The editor's logger. Until `open()` it buffers (the session id comes from
 * the proxy, and the `session` event must be first); then it writes the
 * session event, the buffer, and everything after straight to the target.
 */
export class SessionLog {
  private pending: LogEvent[] = [];
  private target: LogTarget | null = null;
  /** Events dropped because the pre-session buffer was full. */
  dropped = 0;

  constructor(private readonly maxPending = 5000) {}

  readonly log = (e: LogEvent): void => {
    if (this.target) {
      try {
        this.target.log(e);
      } catch {
        /* never throw into the editor */
      }
      return;
    }
    if (this.pending.length >= this.maxPending) {
      this.dropped++;
      return;
    }
    this.pending.push(e);
  };

  get isOpen(): boolean {
    return this.target !== null;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  open(target: LogTarget, sessionEvent: Extract<LogEvent, { type: "session" }>): void {
    if (this.target) return;
    target.log(sessionEvent);
    for (const e of this.pending.splice(0)) target.log(e);
    this.target = target;
  }
}

/** The `session` event (first in every log). The config is copied, never the token. */
export function sessionEvent(
  info: { sessionId: string; filler: FillerName | "none"; t: number; commit?: string },
  cfg: GhostConfig,
): Extract<LogEvent, { type: "session" }> {
  return {
    type: "session",
    t: info.t,
    sessionId: info.sessionId,
    commit: info.commit ?? buildCommit(),
    promptVersion: PROMPT_VERSION,
    briefVersion: BRIEF_VERSION,
    model: cfg.model,
    filler: info.filler,
    config: structuredClone(cfg) as unknown as Record<string, unknown>,
  };
}

/**
 * Build commit for the session event. ONLY a static property read (VITE_COMMIT):
 * reading the whole env object makes Vite inline every VITE_*
 * variable into the bundle (VITE_LLM_API_KEY included).
 */
function buildCommit(): string {
  try {
    return import.meta.env.VITE_COMMIT || "dev";
  } catch {
    return "dev";
  }
}

// ---------------------------------------------------------------------------
// FillLoop
// ---------------------------------------------------------------------------

/** What the loop needs from the ghost session (GhostSession fits). */
export interface GhostSink {
  offer(s: VerifiedSuggestion, o?: OfferOptions): OfferResult;
  reportFill?(info: DevFillInfo & { levelGuess?: string }): void;
}

/** The agent: section verification and whole-level patrol (AgentClient fits). */
export interface LoopAgent extends AgentLike {
  patrol(q: AgentQuery, o?: { signal?: AbortSignal }): Promise<AgentResult>;
}

export interface FillLoopOptions {
  model: LevelModel;
  agent: LoopAgent;
  registry: FillerRegistry;
  log: (e: LogEvent) => void;
  config?: () => GhostConfig;
  /** Session clock, same base as PlacementEvent.t (default performance.now). */
  clock?: () => number;
  timers?: TimerApi;
  /** Run whole-level patrol on idle (default true; also needs kinds.fix and an active filler). */
  patrol?: boolean;
  /** Called after every finished fill (tests, dev tools). */
  onOutcome?: (o: FillOutcome) => void;
}

/** One finished trip through the loop. */
export interface FillOutcome {
  mode: FillMode;
  request: FillRequest;
  result: FillResult;
  verify?: VerifyOutcome;
  offer?: OfferResult;
  superseded: boolean;
  /** fill.call events written for this trip (first call, then the send-back). */
  events: FillCallEvent[];
}

interface EndedGhost {
  s: VerifiedSuggestion;
  outcome: GhostOutcome;
  patterns?: string[];
}

const isAbort = (e: unknown) => !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";
const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Outcome the model can learn from: accepted/partial count as kept, the rest not. */
const HISTORY_KEEP = 12;

export class FillLoop {
  readonly stream: PlacementStream;
  readonly briefCache = new BriefCache();
  readonly patrol: Patrol;
  private readonly o: FillLoopOptions;
  private readonly cfg: () => GhostConfig;
  private readonly clock: () => number;
  private readonly timers: TimerApi;
  private readonly schedulers = new Map<Filler, FillScheduler>();
  private readonly tags = new Map<string, string[]>();
  private ended: EndedGhost[] = [];
  private ghost: GhostSink | null = null;
  private debounce: unknown = null;
  private ctrl: AbortController | null = null;
  private lastGuess: string | undefined;
  private patrolOn = false;
  private paused = false;
  private suspended = false;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];
  /** Counters for dev tools and tests. */
  readonly stats = { requests: 0, superseded: 0, verified: 0, offered: 0, shown: 0, patrolFixes: 0, errors: 0 };
  /** Last finished trip (dev tools). */
  last: FillOutcome | null = null;

  constructor(o: FillLoopOptions) {
    this.o = o;
    this.cfg = o.config ?? (() => liveConfig);
    this.clock = o.clock ?? defaultClock;
    this.timers = o.timers ?? defaultTimers;
    const model = o.model;

    // The stream subscribes first, so it holds a placement before the loop reacts to it.
    this.stream = new PlacementStream({ clock: this.clock });
    this.cleanups.push(this.stream.attach(model));
    this.cleanups.push(model.onPlacement((e) => this.onPlacement(e)));
    this.cleanups.push(
      model.subscribe((ch) => {
        if (ch.source === "load") {
          this.stream.reset();
          this.cancel();
          this.ended = [];
          this.tags.clear();
          this.lastGuess = undefined;
          this.briefCache.clear();
        }
      }),
    );

    const liveCfg = this.cfg;
    this.patrol = new Patrol({
      level: model,
      agent: o.agent,
      config: {
        get patrolIdleMs() {
          return liveCfg().patrolIdleMs;
        },
        get patrolCapMs() {
          return liveCfg().patrolCapMs;
        },
      },
      frontier: () => this.patrolFrontier(),
      log: (e) => this.o.log(e),
      onBlocked: (b) => {
        if (!this.halted && this.enabled) void this.run("patrol", b);
      },
      clock: this.clock,
      timers: this.timers,
    });
    this.syncPatrol();
  }

  // ------------------------------------------------------------ wiring

  /** Attach (or detach) the ghost session that shows verified suggestions. */
  setGhost(g: GhostSink | null): void {
    this.ghost = g;
    if (!g) this.cancel();
  }

  /** Listeners to pass to the ghost session (startGhost(api, { listeners })). */
  readonly managerListeners: ManagerListeners = {
    onShow: () => {
      this.stats.shown++;
    },
    onEnd: (s, outcome) => {
      this.ended.push({ s, outcome, patterns: this.tags.get(s.id) });
      if (this.ended.length > HISTORY_KEEP) {
        const gone = this.ended.shift();
        if (gone && !this.ended.some((e) => e.s.id === gone.s.id)) this.tags.delete(gone.s.id);
      }
    },
  };

  /** The active filler name ("none" = human-only). */
  get activeFiller(): ActiveFiller {
    return this.o.registry.activeName;
  }

  get enabled(): boolean {
    return !this.disposed && this.o.registry.active !== undefined;
  }

  /** Re-read config.filler / kinds and start or stop patrol accordingly. */
  refresh(): void {
    this.o.registry.useConfig(this.cfg());
    if (!this.enabled) this.cancel();
    this.syncPatrol();
  }

  /** Play mode: no fills and no patrol while the knight runs. */
  setPaused(on: boolean): void {
    this.paused = on;
    if (on) this.cancel();
    this.syncPatrol();
  }

  /**
   * Dev / e2e: keep the ghost UI but make no calls and run no patrol (the
   * ghost e2e check drives the layer with hand-made suggestions). Independent
   * of Play, which pauses and resumes on its own.
   */
  setSuspended(on: boolean): void {
    this.suspended = on;
    if (on) this.cancel();
    this.syncPatrol();
  }

  private get halted(): boolean {
    return this.paused || this.suspended;
  }

  /** Ctrl+Space with nothing held: ask now. */
  request(): Promise<FillOutcome | null> {
    this.clearDebounce();
    return this.run("requested");
  }

  /** Abort the fill / verification in flight and any pending speculative fill. */
  cancel(): void {
    this.clearDebounce();
    if (this.ctrl) {
      this.ctrl.abort();
      this.ctrl = null;
    }
    for (const s of this.schedulers.values()) s.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.patrol.stop();
    this.disposed = true;
    for (const c of this.cleanups.splice(0)) c();
  }

  /** Past ghosts for FillRequest.lastGhosts (oldest first, with validator pattern tags). */
  lastGhosts(n = this.cfg().historyCount): GhostHistoryItem[] {
    return this.ended.slice(-Math.max(0, n)).map(({ s, outcome, patterns }) => {
      const g: GhostHistoryItem = { kind: s.kind, label: s.label, outcome };
      if (patterns?.length) g.patterns = [...patterns];
      return g;
    });
  }

  /** Past ghosts for the validator's repeat check (oldest first). */
  recentGhosts(n = this.cfg().historyCount): RecentGhost[] {
    return this.ended.slice(-Math.max(0, n)).map(({ s, patterns }) => ({
      kind: s.kind,
      adds: s.adds,
      removes: s.removes,
      entities: s.entities,
      patterns,
    }));
  }

  /** Build the request the filler would get now (exported for tests and dev tools). */
  buildRequest(mode: FillMode, blocked?: PatrolBlocked): FillRequest {
    const model = this.o.model;
    const cfg = this.cfg();
    const lastGhosts = this.lastGhosts(cfg.historyCount);
    let brief: Brief | null = null;
    try {
      brief = this.briefCache.get({
        level: model.snapshot(),
        revision: model.revision,
        frontierX: this.stream.frontier(model)?.x,
        focusX: blocked?.blockedAt.x,
        lastGhosts,
        lastGuess: this.lastGuess,
        historyCount: cfg.historyCount,
      });
    } catch (e) {
      console.warn("brief failed; sending the placeholder brief", e);
    }
    const base = buildFillRequest(model, this.stream, {
      mode,
      brief: brief?.text,
      briefVersion: brief?.version,
      measure: measureRequestWindow,
      lastGhosts,
      blockedAt: blocked?.blockedAt,
      historyCount: cfg.historyCount,
      recentCount: cfg.recentCount,
      cols: cfg.windowCols,
      rows: cfg.windowRows,
    });
    return blocked ? patrolRequest(base, blocked) : base;
  }

  // ------------------------------------------------------------ internals

  private onPlacement(e: PlacementEvent): void {
    this.o.log({ ...e, type: e.tool === "erase" ? "erase" : "place" });
    if (!this.enabled || this.halted) return;
    // Speculative: every placement asks again (newest wins); a drag is coalesced.
    this.clearDebounce();
    const ms = Math.max(0, this.cfg().fillDebounceMs);
    this.debounce = this.timers.set(() => {
      this.debounce = null;
      void this.run("auto");
    }, ms);
  }

  private clearDebounce(): void {
    if (this.debounce !== null) this.timers.clear(this.debounce);
    this.debounce = null;
  }

  private syncPatrol(): void {
    const want =
      !this.disposed && !this.halted && this.o.patrol !== false && this.enabled && this.cfg().kinds.fix;
    if (want && !this.patrolOn) this.patrol.start();
    else if (!want && this.patrolOn) this.patrol.stop();
    this.patrolOn = want;
  }

  /**
   * Patrol goes from the start to the person's frontier: the stream's frontier,
   * else the rightmost column the person or Ghost authored. Never the template
   * goal platform: an untouched starter level is not "blocked".
   */
  private patrolFrontier(): number {
    const model = this.o.model;
    const f = this.stream.frontier(model);
    let x = f?.x ?? -1;
    if (x < 0) {
      for (let cx = model.w - 1; cx >= 0 && x < 0; cx--)
        for (let y = 0; y < model.h; y++)
          if (model.tileAt(cx, y) !== 0 && model.authorAt(cx, y) !== 0) {
            x = cx;
            break;
          }
    }
    return x < 0 ? model.start.x : x;
  }

  private schedulerFor(f: Filler): FillScheduler {
    let s = this.schedulers.get(f);
    if (!s) {
      s = new FillScheduler(f, { clock: this.clock });
      this.schedulers.set(f, s);
    }
    return s;
  }

  /** One trip: request → filler → verifier → manager. Never rejects. */
  private async run(mode: FillMode, blocked?: PatrolBlocked): Promise<FillOutcome | null> {
    const filler = this.o.registry.active;
    if (!filler || this.disposed || this.halted) return null;
    // Newest wins: a newer trip aborts this one's verification too.
    this.ctrl?.abort();
    for (const [f, s] of this.schedulers) if (f !== filler) s.cancel();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.stats.requests++;

    const requestedAt = this.clock();
    let request: FillRequest;
    let snap: ReturnType<LevelModel["snapshot"]>;
    try {
      request = this.buildRequest(mode, blocked);
      snap = this.o.model.snapshot();
    } catch (e) {
      this.stats.errors++;
      console.error("fill request could not be built", e);
      if (this.ctrl === ctrl) this.ctrl = null;
      return null;
    }

    const result = await this.schedulerFor(filler).schedule(request);
    const events: FillCallEvent[] = [];
    const finish = (o: Omit<FillOutcome, "events" | "mode" | "request" | "result">): FillOutcome => {
      if (this.ctrl === ctrl) this.ctrl = null;
      const out: FillOutcome = { mode, request, result, events, ...o };
      if (out.superseded) this.stats.superseded++;
      this.last = out;
      try {
        this.o.onOutcome?.(out);
      } catch {
        /* ignore */
      }
      return out;
    };
    const writeCall = (r: FillResult, req: FillRequest, extra: Partial<FillCallEvent> = {}) => {
      const ev = { ...fillCallEvent(r, req, this.clock()), ...extra } as FillCallEvent;
      for (const k of Object.keys(ev) as (keyof FillCallEvent)[]) if (ev[k] === undefined) delete ev[k];
      events.push(ev);
      this.o.log(ev);
    };

    if (result.superseded || ctrl.signal.aborted) {
      result.superseded = true;
      writeCall(result, request);
      return finish({ superseded: true });
    }
    const guess = result.suggestion?.levelGuess ?? result.answer?.levelGuess;
    if (guess) this.lastGuess = guess;

    if (!result.suggestion) {
      writeCall(result, request);
      this.report(mode, filler, result, undefined);
      // Patrol with no model answer still gets the local repair.
      if (!blocked) return finish({ superseded: false });
    }

    // Send-back calls go to the same filler; their results are logged as their own fill.call.
    const sendBacks: { r: FillResult; req: FillRequest }[] = [];
    const asFix = (s: Suggestion | null): Suggestion | null => (s && mode === "patrol" ? { ...s, kind: "fix" } : s);
    const sendBackFiller = {
      fill: async (req: FillRequest, signal?: AbortSignal): Promise<Suggestion | null> => {
        const r = await this.detailedFill(filler, req, signal);
        sendBacks.push({ r, req });
        if (signal?.aborted) {
          const e = new Error("superseded");
          e.name = "AbortError";
          throw e;
        }
        return asFix(r.suggestion);
      },
    };
    const deps: VerifyDeps = {
      agent: this.o.agent,
      config: this.cfg(),
      signal: ctrl.signal,
      validate: { lastGhosts: this.recentGhosts(), frontierX: this.stream.frontier(this.o.model)?.x },
    };

    let verify: VerifyOutcome;
    try {
      verify = blocked
        ? await verifyPatrolFix(snap, request, asFix(result.suggestion), sendBackFiller, blocked, deps)
        : await verifyWithSendBack(snap, request, result.suggestion, sendBackFiller, deps);
    } catch (e) {
      if (result.suggestion) writeCall({ ...result, superseded: isAbort(e) }, request, isAbort(e) ? {} : { error: errText(e) });
      for (const sb of sendBacks) writeCall({ ...sb.r, superseded: true }, sb.req, { sendBack: true });
      if (!isAbort(e)) {
        this.stats.errors++;
        console.error("verification failed", e);
      }
      return finish({ superseded: isAbort(e) });
    }

    const verdictOf = (attempt: number) => verify.verdicts.find((v) => v.attempt === attempt);
    const stageOf = (v: AttemptVerdict | undefined): Partial<FillCallEvent> =>
      v ? { verdictStage: v.ok ? ("ok" as const) : v.stage, ...(v.ok || !v.reason ? {} : { reason: v.reason }) } : {};
    if (result.suggestion) writeCall(result, request, { ...stageOf(verdictOf(1)), sendBack: verify.sendBack });
    sendBacks.forEach((sb, i) => writeCall(sb.r, sb.req, { ...stageOf(verdictOf(2 + i)), sendBack: true }));

    let offer: OfferResult | undefined;
    const v = verify.verified;
    if (v) {
      this.stats.verified++;
      if (v.mode === "patrol") this.stats.patrolFixes++;
      const final = verify.verdicts[verify.verdicts.length - 1] as AttemptVerdict & { tags?: string[] };
      if (final?.tags?.length) this.tags.set(v.id, [...final.tags]);
      if (this.ghost && !ctrl.signal.aborted) {
        offer = this.ghost.offer(v, { requestedAt });
        this.stats.offered++;
      }
    }
    if (result.suggestion || v) this.report(mode, filler, result, verify);
    return finish({ superseded: false, verify, offer });
  }

  /** fillDetailed when the filler has it, else an adapted FillResult. */
  private async detailedFill(f: Filler, req: FillRequest, signal?: AbortSignal): Promise<FillResult> {
    const d = f as Partial<DetailedFiller> & Filler;
    if (typeof d.fillDetailed === "function") return d.fillDetailed(req, signal);
    const t0 = this.clock();
    const r: FillResult = {
      suggestion: null,
      answer: null,
      requestHash: "",
      latencyMs: 0,
      samples: 1,
      confidenceSource: "stated",
      dropped: [],
      aborted: false,
      timedOut: false,
      superseded: false,
    };
    try {
      r.suggestion = await f.fill(req, signal);
    } catch (e) {
      if (isAbort(e) || signal?.aborted) r.aborted = true;
      r.error = isAbort(e) ? "aborted" : errText(e);
    }
    r.requestHash = r.suggestion?.requestHash || (await requestHash(req).catch(() => ""));
    r.latencyMs = this.clock() - t0;
    return r;
  }

  private report(mode: FillMode, filler: Filler, r: FillResult, verify: VerifyOutcome | undefined): void {
    if (!this.ghost?.reportFill) return;
    const s = verify?.verified ?? r.suggestion;
    const last = verify?.verdicts[verify.verdicts.length - 1];
    const info: DevFillInfo & { levelGuess?: string } = {
      t: this.clock(),
      filler: s?.filler ?? filler.name,
      mode,
      act: r.answer ? r.answer.act : r.suggestion ? true : r.error ? null : false,
      latencyMs: r.latencyMs,
    };
    if (s) {
      info.kind = s.kind;
      info.label = s.label;
      info.confidence = s.confidence;
      info.cells = s.adds.length + s.removes.length + s.entities.length;
    }
    if (last) {
      info.verdictStage = verify?.verified ? "ok" : (last.stage as VerdictStage);
      if (!last.ok && last.reason) info.reason = last.reason;
    }
    if (verify) info.attempts = verify.attempts + (verify.usedFallback ? 1 : 0);
    if (r.error) info.error = r.error;
    const guess = r.suggestion?.levelGuess ?? r.answer?.levelGuess;
    if (guess) info.levelGuess = guess;
    try {
      this.ghost.reportFill(info);
    } catch {
      /* dev overlay only */
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Fillers for a session
// ---------------------------------------------------------------------------

export interface RegistryOptions {
  sessionId: string;
  token: string | null;
  fetch?: typeof fetch;
}

/**
 * The fillers this session can use. LLM only with a token (the proxy refuses
 * calls without one); "algo" is a later work item (G-34) and is not registered,
 * so a token assigned "algo" runs as "none" for now.
 */
export function buildRegistry(cfg: GhostConfig, o: RegistryOptions): FillerRegistry {
  const reg = new FillerRegistry();
  reg.register(new StubFiller());
  if (o.token) reg.register(new LLMFiller({ sessionId: o.sessionId, token: o.token, fetch: o.fetch }));
  reg.useConfig(cfg);
  return reg;
}

// ---------------------------------------------------------------------------
// PewterApp: boot glue
// ---------------------------------------------------------------------------

export interface PewterAppOptions {
  model: LevelModel;
  /** location.search (default the page's). */
  search?: string;
  fetch?: typeof fetch;
  /** Agent (default a Web Worker AgentClient). */
  agent?: LoopAgent;
  /** Start the ghost on the editor (default ghost/session.ts startGhost, loaded lazily with Phaser). */
  startGhost?: (api: EditorApi, opts: GhostSessionOptions) => GhostSession;
  clock?: () => number;
  /** EventLog options (tests). */
  eventLog?: { autoStart?: boolean; fetch?: typeof fetch };
}

/**
 * Owns the session: config, research log, fillers, agent, the fill loop and
 * (once the editor is ready) the Phaser ghost session.
 */
export class PewterApp {
  readonly sessionLog = new SessionLog();
  readonly agent: LoopAgent;
  readonly registry = new FillerRegistry();
  readonly loop: FillLoop;
  readonly ready: Promise<SessionInfo>;
  eventLog: EventLog | null = null;
  session: SessionInfo | null = null;
  ghost: GhostSession | null = null;
  private readonly o: PewterAppOptions;
  private readonly clock: () => number;
  private readonly cleanups: (() => void)[] = [];

  constructor(o: PewterAppOptions) {
    this.o = o;
    this.clock = o.clock ?? defaultClock;
    const search = o.search ?? (typeof location !== "undefined" ? location.search : "");
    // Defaults ← URL now (the session may override later); the filler stays off until the session resolves.
    const url = urlOverrides(search);
    applyOverrides(resolveConfig(url, null));
    this.agent = o.agent ?? new AgentClient();
    this.loop = new FillLoop({
      model: o.model,
      agent: this.agent,
      registry: this.registry,
      log: this.sessionLog.log,
      clock: this.clock,
    });
    const params = new URLSearchParams(search);
    const token = params.get("token")?.trim() || readTokenFromUrl() || null;
    this.ready = this.init(url, token);
  }

  /** The editor's logger (pass to EditorScene / api.log). */
  get log(): (e: LogEvent) => void {
    return this.sessionLog.log;
  }

  private async init(url: Partial<GhostConfig>, token: string | null): Promise<SessionInfo> {
    const info = await fetchSession({
      proxyUrl: liveConfig.proxyUrl,
      token,
      fetch: this.o.fetch,
      timeoutMs: 4000,
      fallbackCondition: liveConfig.filler === "none" ? "none" : (liveConfig.filler as SessionInfo["condition"]),
    });
    if (token && !info.fromProxy) console.warn(`session: proxy unavailable (${info.error ?? "unknown"}); running locally`);
    const cfg = resolveConfig(url, info);
    applyOverrides(cfg);
    this.session = info;

    const reg = buildRegistry(cfg, { sessionId: info.sessionId, token: info.fromProxy ? info.token : null, fetch: this.o.fetch });
    for (const n of reg.names()) this.registry.register(reg.get(n)!);
    const active = this.registry.useConfig(liveConfig);
    if (active !== cfg.filler) console.info(`session: filler "${cfg.filler}" is not available here; running "${active}"`);

    this.eventLog = new EventLog({
      sessionId: info.sessionId,
      proxyUrl: info.fromProxy ? liveConfig.proxyUrl : null,
      token: info.fromProxy ? info.token : null,
      autoStart: this.o.eventLog?.autoStart,
      fetch: this.o.eventLog?.fetch ?? this.o.fetch,
    });
    setActiveLog(this.eventLog);
    this.sessionLog.open(this.eventLog, sessionEvent({ sessionId: info.sessionId, filler: active, t: this.clock() }, liveConfig));
    this.loop.refresh();
    return info;
  }

  /** Start the ghost on a ready editor. Returns the cleanup for registerGhostStarter. */
  attachEditor(api: EditorApi, start: (api: EditorApi, opts: GhostSessionOptions) => GhostSession): () => void {
    const ghost = start(api, {
      onRequest: () => void this.loop.request(),
      listeners: this.loop.managerListeners,
      enabled: () => this.loop.enabled,
    });
    this.ghost = ghost;
    this.loop.setGhost(ghost);
    const offs = [
      api.on("play:start", () => this.loop.setPaused(true)),
      api.on("play:end", () => this.loop.setPaused(false)),
    ];
    return () => {
      for (const off of offs) off();
      this.loop.setGhost(null);
      ghost.dispose();
      if (this.ghost === ghost) this.ghost = null;
    };
  }

  /** Send pending log events now (Save task). */
  flushLog(): Promise<boolean> {
    return this.eventLog ? this.eventLog.flush() : Promise.resolve(false);
  }

  /** Page is going away. */
  unload(): void {
    this.eventLog?.flushOnUnload();
  }

  dispose(): void {
    this.loop.dispose();
    for (const c of this.cleanups.splice(0)) c();
    (this.agent as Partial<{ dispose(): void }>).dispose?.();
    this.eventLog?.close();
    setActiveLog(null);
  }
}

export type { PatrolReport };
