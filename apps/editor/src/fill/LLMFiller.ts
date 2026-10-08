/**
 * G-14 / G-25 / G-27 — the LLM filler: a thin client of the proxy's /fill.
 *
 *  - POST `${config.proxyUrl}/fill` with a ProxyFillBody and
 *    `Authorization: Bearer <session token>`. The key never touches the
 *    browser.
 *  - Honours the caller's AbortSignal and gives up after config.callTimeoutMs.
 *  - Converts the answer with fill/answer.ts (window -> level coordinates,
 *    unplaceable cells dropped).
 *  - Confidence source per config.confidenceSource (G-27):
 *      stated    the model's own number;
 *      logprob   exp(mean token log-probability) from the proxy response
 *                (falls back to stated when the upstream gave none);
 *      twoSample asks for samples = 2; confidence = shared cells / union of
 *                the two answers' cells (0 when only one acted).
 *  - G-25 behind a flag (`varietyTwoSample`): ask for two samples and, for an
 *    extend, keep the answer whose label is least like the recent ghosts.
 *  - Never throws: fill() resolves null on any failure, and fillDetailed()
 *    returns a FillResult carrying the error for the fill.call log event.
 *
 * FillScheduler runs speculative calls side by side: a new request does not
 * cancel the calls in flight (their answers are reconciled by the fill loop
 * when they arrive). Only when more than config.maxInFlight would be running
 * is the OLDEST aborted and marked superseded.
 */
import type {
  FillRequest,
  Filler,
  FillerName,
  LogEvent,
  ModelAnswer,
  ProxyFillBody,
  ProxyFillResponse,
  Suggestion,
  GhostHistoryItem,
} from "../contracts";
import { config as liveConfig, type GhostConfig } from "../suggest/config";
import { convertModelAnswer, type DroppedItem } from "./answer";
import { isAbortError } from "./Filler";
import { requestHash } from "./hash";
import { parseModelAnswer } from "./prompt";

export type ConfidenceSource = GhostConfig["confidenceSource"];

export type FillCallEvent = Extract<LogEvent, { type: "fill.call" }>;

/** Everything one call produced, for the manager and the fill.call log event. */
export interface FillResult {
  /** Level-coordinate suggestion (unverified), or null. */
  suggestion: Suggestion | null;
  /** The answer used (parsed again on the client), or null. */
  answer: ModelAnswer | null;
  /** Both parsed answers when two samples were asked for. */
  answers?: (ModelAnswer | null)[];
  requestHash: string;
  /** Client round trip, ms. */
  latencyMs: number;
  /** The proxy's own measurement of the upstream call. */
  serverLatencyMs?: number;
  model?: string;
  promptVersion?: string;
  samples: 1 | 2;
  /** Source actually used for `suggestion.confidence` (stated when a fallback happened). */
  confidenceSource: ConfidenceSource;
  /** True when the configured source was unavailable and stated was used instead. */
  confidenceFallback?: boolean;
  statedConfidence?: number;
  logprob?: number;
  /** twoSample agreement (shared cells / union). */
  agreement?: number;
  /** Cells fill/answer.ts dropped (outside window, duplicates, ...). */
  dropped: DroppedItem[];
  /** The caller's signal aborted (superseded or cancelled). */
  aborted: boolean;
  /** config.callTimeoutMs elapsed first. */
  timedOut: boolean;
  /**
   * The call was aborted (FillScheduler: too many in flight, or cancelled) or
   * its answer was dropped before showing (the fill loop's reconciliation).
   */
  superseded: boolean;
  /**
   * Why, when superseded: "aborted: over maxInFlight", "cancelled", or a
   * reconciliation reason ("stale: cells drawn", "stale: newer shown", ...).
   * Logged as fill.call `reason`.
   */
  supersededReason?: string;
  /** HTTP status when the proxy answered. */
  status?: number;
  /** Retry-After on 429, ms. */
  retryAfterMs?: number;
  /** What went wrong (never contains the token). */
  error?: string;
}

/** Fillers that can report a FillResult (LLMFiller; FillScheduler wraps the rest). */
export interface DetailedFiller extends Filler {
  fillDetailed(request: FillRequest, signal?: AbortSignal): Promise<FillResult>;
}

export interface LLMFillerOptions {
  /** Session id from GET /session (research/session.ts). */
  sessionId: string;
  /** Bearer token; omitted when the proxy is open. */
  token?: string;
  /** Live config by default (proxyUrl, callTimeoutMs, confidenceSource). */
  config?: Pick<GhostConfig, "proxyUrl" | "callTimeoutMs" | "confidenceSource">;
  /** Override config.proxyUrl. */
  proxyUrl?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  /** Sampling temperature to request (proxy default when omitted). */
  temperature?: number;
  /** G-25: two samples for every non-patrol request; keep the more novel extend. */
  varietyTwoSample?: boolean;
  /** Called with every FillResult (after fillDetailed resolves). */
  onResult?: (r: FillResult) => void;
}

const defaultClock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// Confidence helpers
// ---------------------------------------------------------------------------

/** The set of cells an answer touches: adds with tile, removes, entities with kind. */
export function answerCells(a: ModelAnswer | null | undefined): Set<string> {
  const s = new Set<string>();
  if (!a || !a.act) return s;
  for (const c of a.adds) s.add(`a:${c.x},${c.y}:${c.tile}`);
  for (const c of a.removes) s.add(`r:${c.x},${c.y}`);
  for (const e of a.entities) s.add(`e:${e.x},${e.y}:${e.kind}`);
  return s;
}

/**
 * Two-sample agreement: |shared cells| / |union| (same cell, same tile or
 * kind). 0 when either answer is missing or declined, or both are empty.
 */
export function sampleAgreement(a: ModelAnswer | null | undefined, b: ModelAnswer | null | undefined): number {
  const A = answerCells(a);
  const B = answerCells(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const k of A) if (B.has(k)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Mean token log-probability -> per-token probability in [0, 1] (geometric mean). */
export function logprobConfidence(logprob: number): number {
  if (!Number.isFinite(logprob)) return 0;
  return Math.max(0, Math.min(1, Math.exp(Math.min(0, logprob))));
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

function labelSimilarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * G-25 two-sample pick: among acting extend answers, the one whose label is
 * least like the labels of the recent ghosts (ties keep the first). Returns
 * the index into `answers`; 0 when there is nothing to choose.
 */
export function pickForVariety(answers: readonly (ModelAnswer | null)[], history: readonly GhostHistoryItem[]): number {
  const labels = history.map((g) => g.label);
  let best = 0;
  let bestScore = Infinity;
  answers.forEach((a, i) => {
    if (!a || !a.act || a.kind !== "extend") return;
    const score = labels.length ? Math.max(...labels.map((l) => labelSimilarity(a.label, l))) : 0;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return answers[best]?.act ? best : 0;
}

// ---------------------------------------------------------------------------
// LLMFiller
// ---------------------------------------------------------------------------

const TIMEOUT = "fill-timeout";

export class LLMFiller implements DetailedFiller {
  readonly name: FillerName = "llm";
  private readonly opts: LLMFillerOptions;
  private readonly clock: () => number;
  /** The most recent result (dev overlay). */
  lastResult: FillResult | undefined;

  constructor(opts: LLMFillerOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? defaultClock;
  }

  private get cfg() {
    return this.opts.config ?? liveConfig;
  }

  /** Base URL of the proxy without a trailing slash. */
  get proxyUrl(): string {
    return (this.opts.proxyUrl ?? this.cfg.proxyUrl).replace(/\/+$/, "");
  }

  async fill(request: FillRequest, signal?: AbortSignal): Promise<Suggestion | null> {
    return (await this.fillDetailed(request, signal)).suggestion;
  }

  async fillDetailed(request: FillRequest, signal?: AbortSignal): Promise<FillResult> {
    const t0 = this.clock();
    const source = this.cfg.confidenceSource;
    const twoSamples = source === "twoSample" || (!!this.opts.varietyTwoSample && request.mode !== "patrol");
    const samples: 1 | 2 = twoSamples ? 2 : 1;
    const result: FillResult = {
      suggestion: null,
      answer: null,
      requestHash: "",
      latencyMs: 0,
      samples,
      confidenceSource: source,
      dropped: [],
      aborted: false,
      timedOut: false,
      superseded: false,
    };
    const hashP = requestHash(request).catch(() => "");
    const finish = async () => {
      result.latencyMs = Math.max(0, Math.round(this.clock() - t0));
      if (!result.requestHash) result.requestHash = await hashP;
      this.lastResult = result;
      try {
        this.opts.onResult?.(result);
      } catch {
        /* a listener must not break the filler */
      }
      return result;
    };

    if (signal?.aborted) {
      result.aborted = true;
      result.error = "aborted";
      return finish();
    }

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = Math.max(1, this.cfg.callTimeoutMs);
    const timer = setTimeout(() => ctrl.abort(TIMEOUT), timeoutMs);
    const stopped = () => {
      if (signal?.aborted) {
        result.aborted = true;
        result.error = "aborted";
        return true;
      }
      if (ctrl.signal.aborted) {
        result.timedOut = true;
        result.error = `timeout after ${timeoutMs} ms`;
        return true;
      }
      return false;
    };

    try {
      const body: ProxyFillBody = { sessionId: this.opts.sessionId, request };
      if (samples === 2) body.samples = 2;
      if (this.opts.temperature !== undefined) body.temperature = this.opts.temperature;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
      const fetchImpl = this.opts.fetch ?? globalThis.fetch.bind(globalThis);

      let res: Response;
      try {
        res = await fetchImpl(`${this.proxyUrl}/fill`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (!stopped()) result.error = `network: ${errText(e)}`;
        return await finish();
      }
      result.status = res.status;
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        if (!stopped()) result.error = `http ${res.status}: body is not JSON`;
        return await finish();
      }
      if (stopped()) return await finish();
      const resp = (json && typeof json === "object" ? json : {}) as Partial<ProxyFillResponse> & { error?: unknown };
      if (!res.ok) {
        const msg = typeof resp.error === "string" ? resp.error : res.statusText;
        result.error = `http ${res.status}${msg ? `: ${msg}` : ""}`;
        const ra = Number(res.headers?.get?.("Retry-After"));
        if (res.status === 429 && Number.isFinite(ra) && ra >= 0) result.retryAfterMs = ra * 1000;
        return await finish();
      }

      if (typeof resp.requestHash === "string") result.requestHash = resp.requestHash;
      if (typeof resp.latencyMs === "number") result.serverLatencyMs = resp.latencyMs;
      if (typeof resp.model === "string") result.model = resp.model;
      if (typeof resp.promptVersion === "string") result.promptVersion = resp.promptVersion;
      if (typeof resp.logprob === "number" && Number.isFinite(resp.logprob)) result.logprob = resp.logprob;
      if (typeof resp.error === "string" && resp.error) result.error = resp.error;

      // Re-validate on the client: the proxy is trusted, but cheap checks are cheap.
      const first = resp.answer == null ? null : parseModelAnswer(resp.answer);
      if (resp.answer != null && first === null) result.error ??= "answer failed client validation";
      let answers: (ModelAnswer | null)[] | undefined;
      if (Array.isArray(resp.answers)) answers = resp.answers.map((a) => (a == null ? null : parseModelAnswer(a)));
      if (samples === 2) result.answers = answers ?? [first];

      let chosen = first;
      if (this.opts.varietyTwoSample && answers && answers.length === 2) {
        chosen = answers[pickForVariety(answers, request.lastGhosts)] ?? first;
      }
      result.answer = chosen;
      if (!chosen) return await finish();
      result.statedConfidence = chosen.confidence;

      // Confidence by source.
      let confidence = chosen.confidence;
      if (source === "logprob") {
        if (result.logprob !== undefined) confidence = logprobConfidence(result.logprob);
        else {
          result.confidenceSource = "stated";
          result.confidenceFallback = true;
        }
      } else if (source === "twoSample") {
        if (answers && answers.length === 2) {
          result.agreement = sampleAgreement(answers[0], answers[1]);
          confidence = result.agreement;
        } else {
          result.confidenceSource = "stated";
          result.confidenceFallback = true;
        }
      }

      if (!result.requestHash) result.requestHash = await hashP;
      const conv = convertModelAnswer({ ...chosen, confidence }, request, {
        filler: this.name,
        requestHash: result.requestHash,
        latencyMs: Math.max(0, Math.round(this.clock() - t0)),
      });
      result.dropped = conv.dropped;
      if (stopped()) return await finish();
      result.suggestion = conv.suggestion;
      return await finish();
    } catch (e) {
      // Defensive: nothing above should throw, but the filler must never reject.
      if (!stopped()) result.error = `internal: ${errText(e)}`;
      result.suggestion = null;
      return await finish();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function errText(e: unknown): string {
  if (isAbortError(e)) return "aborted";
  const s = e instanceof Error ? e.message : String(e);
  return s.slice(0, 200);
}

// ---------------------------------------------------------------------------
// fill.call log event
// ---------------------------------------------------------------------------

/** The fill.call event for a result (the verifier adds verdictStage / reason / sendBack later). */
export function fillCallEvent(r: FillResult, request: Pick<FillRequest, "mode">, t: number): FillCallEvent {
  const e: FillCallEvent = {
    type: "fill.call",
    t,
    requestHash: r.requestHash,
    mode: request.mode,
    superseded: r.superseded,
    latencyMs: r.latencyMs,
    act: r.answer ? r.answer.act : null,
  };
  if (r.answer?.act) e.kind = r.answer.kind;
  if (r.suggestion) {
    e.confidence = r.suggestion.confidence;
    e.tiles = r.suggestion.adds.length + r.suggestion.removes.length + r.suggestion.entities.length;
  } else if (r.answer?.act) {
    e.confidence = r.answer.confidence;
  }
  const err = r.superseded ? "superseded" : r.error;
  if (err) e.error = err;
  if (r.superseded && r.supersededReason) e.reason = r.supersededReason;
  return e;
}

// ---------------------------------------------------------------------------
// FillScheduler: speculative calls side by side, at most maxInFlight
// ---------------------------------------------------------------------------

/** supersededReason of a call aborted because a newer one would exceed maxInFlight. */
export const OVER_MAX_IN_FLIGHT = "aborted: over maxInFlight";
/** supersededReason of a call aborted by FillScheduler.cancel() (Play, load, filler switch). */
export const CANCELLED = "cancelled";

export interface FillSchedulerOptions {
  /** Every settled call (superseded ones included), for logging. */
  onResult?: (r: FillResult, request: FillRequest) => void;
  clock?: () => number;
  /** Calls allowed in flight at once (default: live config.maxInFlight, read at every schedule). */
  maxInFlight?: number | (() => number);
}

export interface FillSchedulerStats {
  scheduled: number;
  /** Calls aborted (over maxInFlight, or cancelled). */
  superseded: number;
  completed: number;
  timedOut: number;
  errors: number;
  /** Completed calls that produced a suggestion. */
  suggestions: number;
  /** Most calls in flight at once so far. */
  maxConcurrent: number;
}

interface InFlight {
  ctrl: AbortController;
  superseded: boolean;
  reason?: string;
}

/**
 * Wraps a filler for speculative calls. schedule(request) starts a call and
 * resolves with its result; calls already in flight keep running, so an
 * older request's answer can still arrive (the caller reconciles it with the
 * level). When a new call would make more than `maxInFlight` run at once,
 * the OLDEST is aborted: its result has superseded = true, supersededReason
 * OVER_MAX_IN_FLIGHT and no suggestion (even if the filler ignored the
 * signal). Never rejects.
 */
export class FillScheduler {
  /** Calls in flight, oldest first. */
  private readonly running: InFlight[] = [];
  private readonly filler: Filler;
  private readonly opts: FillSchedulerOptions;
  private readonly clock: () => number;
  readonly stats: FillSchedulerStats = {
    scheduled: 0,
    superseded: 0,
    completed: 0,
    timedOut: 0,
    errors: 0,
    suggestions: 0,
    maxConcurrent: 0,
  };

  constructor(filler: Filler, opts: FillSchedulerOptions = {}) {
    this.filler = filler;
    this.opts = opts;
    this.clock = opts.clock ?? defaultClock;
  }

  get inFlight(): boolean {
    return this.running.length > 0;
  }

  /** Number of calls in flight now. */
  get inFlightCount(): number {
    return this.running.length;
  }

  private get limit(): number {
    const m = this.opts.maxInFlight;
    const n = typeof m === "function" ? m() : m ?? liveConfig.maxInFlight;
    return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  }

  async schedule(request: FillRequest): Promise<FillResult> {
    const entry: InFlight = { ctrl: new AbortController(), superseded: false };
    this.running.push(entry);
    const limit = this.limit;
    while (this.running.length > limit) this.abort(this.running[0], OVER_MAX_IN_FLIGHT);
    this.stats.scheduled++;
    this.stats.maxConcurrent = Math.max(this.stats.maxConcurrent, this.running.length);
    const r = await this.run(request, entry.ctrl.signal);
    const i = this.running.indexOf(entry);
    if (i >= 0) this.running.splice(i, 1);
    if (entry.superseded) {
      r.superseded = true;
      r.supersededReason = entry.reason;
      r.suggestion = null;
      this.stats.superseded++;
    } else {
      this.stats.completed++;
      if (r.timedOut) this.stats.timedOut++;
      else if (r.error) this.stats.errors++;
      if (r.suggestion) this.stats.suggestions++;
    }
    try {
      this.opts.onResult?.(r, request);
    } catch {
      /* ignore listener errors */
    }
    return r;
  }

  /** Abort every call in flight (counted as superseded, reason CANCELLED). */
  cancel(): void {
    for (const e of [...this.running]) this.abort(e, CANCELLED);
  }

  private abort(e: InFlight, reason: string): void {
    const i = this.running.indexOf(e);
    if (i >= 0) this.running.splice(i, 1);
    e.superseded = true;
    e.reason = reason;
    e.ctrl.abort("superseded");
  }

  private async run(request: FillRequest, signal: AbortSignal): Promise<FillResult> {
    const f = this.filler as Partial<DetailedFiller> & Filler;
    if (typeof f.fillDetailed === "function") return f.fillDetailed(request, signal);
    // Plain filler (stub, algo): adapt.
    const t0 = this.clock();
    const base: FillResult = {
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
      base.suggestion = await f.fill(request, signal);
      if (base.suggestion) base.requestHash = base.suggestion.requestHash;
    } catch (e) {
      if (isAbortError(e) || signal.aborted) {
        base.aborted = true;
        base.error = "aborted";
      } else base.error = errText(e);
    }
    if (!base.requestHash) base.requestHash = await requestHash(request).catch(() => "");
    base.latencyMs = Math.max(0, Math.round(this.clock() - t0));
    return base;
  }
}
