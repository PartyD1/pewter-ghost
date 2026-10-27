/**
 * The Jev poller (G-36): every config.jevIntervalMs while editing, send a cheap
 * model the window around the person's work, their activity and the ghost
 * waiting to show, and ask "suggest now or wait?". JevTimer reads the latest
 * verdict; nothing here shows anything itself.
 *
 *  - One poll in flight at a time; a slow answer is cut at jevTimeoutMs.
 *  - No polls while halted (Play, no filler) or when the policy is not "jev",
 *    nor after jevIdleStopMs of idle with no ghost held or showing.
 *  - "suggest" with nothing held, showing or in flight asks the loop for a
 *    call (`nudge`), so a long pause still gets a ghost.
 *  - Every verdict (and every failed poll) is logged as a `timing` event.
 *
 * JevClient is the seam: ProxyJevClient asks a cheap model through the
 * proxy's /when; a real Jev service drops in behind the same interface.
 */
import type {
  FillRequest,
  JevRequest,
  JevVerdict,
  LogEvent,
  ProxyWhenBody,
  ProxyWhenResponse,
  VerifiedSuggestion,
} from "../../contracts";
import type { TimerApi } from "../../verify/patrol";
import type { GhostConfig } from "../config";
import type { TimedVerdict } from "../timers/JevTimer";
import type { ActivitySnapshot } from "./activity";
import { parseJevVerdict } from "./jevPrompt";

export interface JevAnswer {
  verdict: JevVerdict | null;
  latencyMs: number;
  error?: string;
}

export interface JevClient {
  when(req: JevRequest, signal: AbortSignal): Promise<JevAnswer>;
}

export interface JevPollerOptions {
  client: JevClient;
  config: () => GhostConfig;
  clock: () => number;
  timers: TimerApi;
  log: (e: LogEvent) => void;
  activity: (now: number) => ActivitySnapshot;
  /** The window the filler would see now (null when it cannot be built). */
  request: () => FillRequest | null;
  held: () => VerifiedSuggestion | null;
  showing: () => boolean;
  /** Editing with a filler, not in Play, and nothing in flight is required for nudge. */
  active: () => boolean;
  /** Ask the loop for a fill (only called when nothing is held or showing). */
  nudge: () => void;
}

const RECENT_FOR_JEV = 8;

export function jevRequestFrom(
  req: FillRequest,
  a: ActivitySnapshot,
  held: VerifiedSuggestion | null,
  showing: boolean,
): JevRequest {
  return {
    grid: req.grid,
    origin: req.origin,
    size: req.size,
    recent: req.recent.slice(-RECENT_FOR_JEV),
    activity: {
      idleMs: Math.round(a.idleMs),
      placements2s: a.placements2s,
      placements10s: a.placements10s,
      eraseShare: Math.round(a.eraseShare * 100) / 100,
      dismissRun: a.dismissRun,
      acceptRate5: Math.round(a.acceptRate5 * 100) / 100,
    },
    held: held
      ? {
          kind: held.kind,
          label: held.label,
          confidence: Number.isFinite(held.confidence) ? held.confidence : 0,
          cells: held.adds.length + held.removes.length + held.entities.length,
          anchor: { x: held.anchor.x - req.origin.x, y: held.anchor.y - req.origin.y },
        }
      : null,
    showing,
    lastGhosts: req.lastGhosts,
  };
}

export class JevPoller {
  private latest: TimedVerdict | null = null;
  private handle: unknown = null;
  private inFlight: AbortController | null = null;
  private running = false;
  /** Bumped by stop(), so an answer arriving after it is dropped. */
  private gen = 0;
  /** Polls sent / failed (dev tools, tests). */
  readonly stats = { polls: 0, errors: 0, suggest: 0, nudges: 0 };

  constructor(private readonly o: JevPollerOptions) {}

  /** The latest verdict (JevTimer checks its age). */
  get verdict(): TimedVerdict | null {
    return this.latest;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.gen++;
    if (this.handle !== null) this.o.timers.clear(this.handle);
    this.handle = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  /** Forget the verdict (new level, Play). */
  clear(): void {
    this.latest = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.handle = this.o.timers.set(() => {
      this.handle = null;
      void this.poll().finally(() => this.schedule());
    }, Math.max(250, this.o.config().jevIntervalMs));
  }

  /** One poll now (the interval calls this; tests call it directly). */
  async poll(): Promise<void> {
    const cfg = this.o.config();
    if (this.inFlight || cfg.timing !== "jev" || !this.o.active()) return;
    const t0 = this.o.clock();
    const a = this.o.activity(t0);
    const held = this.o.held();
    const showing = this.o.showing();
    if (!held && !showing && a.idleMs > cfg.jevIdleStopMs) return;
    let fill: FillRequest | null;
    try {
      fill = this.o.request();
    } catch {
      fill = null;
    }
    if (!fill) return;

    const gen = this.gen;
    const ctrl = new AbortController();
    this.inFlight = ctrl;
    const timeout = this.o.timers.set(() => ctrl.abort(), Math.max(1, cfg.jevTimeoutMs));
    this.stats.polls++;
    let ans: JevAnswer;
    try {
      ans = await this.o.client.when(jevRequestFrom(fill, a, held, showing), ctrl.signal);
    } catch (e) {
      ans = { verdict: null, latencyMs: this.o.clock() - t0, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.o.timers.clear(timeout);
      if (this.inFlight === ctrl) this.inFlight = null;
    }
    if (ctrl.signal.aborted && !ans.error) ans = { ...ans, verdict: null, error: `timeout after ${cfg.jevTimeoutMs} ms` };
    // stop() while the poll was out: its answer is not wanted.
    if (gen !== this.gen) return;
    const latencyMs = Math.max(0, Math.round(this.o.clock() - t0));
    const v = ans.verdict;
    if (!v) {
      this.stats.errors++;
      this.o.log({ type: "timing", t: this.o.clock(), policy: "jev", stage: "jev", decision: "error", latencyMs, why: ans.error ?? "no verdict" });
      return;
    }
    this.latest = { ...v, at: t0 };
    if (v.suggest) this.stats.suggest++;
    const ev: Extract<LogEvent, { type: "timing" }> = {
      type: "timing",
      t: this.o.clock(),
      policy: "jev",
      stage: "jev",
      decision: v.suggest ? "suggest" : "wait",
      p: v.p,
      latencyMs,
      why: v.why,
    };
    if (held) ev.suggestionId = held.id;
    this.o.log(ev);
    if (v.suggest && !this.o.held() && !this.o.showing() && this.o.active()) {
      this.stats.nudges++;
      this.o.nudge();
    }
  }
}

export interface ProxyJevClientOptions {
  sessionId: string;
  token: string;
  proxyUrl: () => string;
  fetch?: typeof fetch;
}

/** The Jev as a cheap model behind the proxy's POST /when. Never rejects. */
export class ProxyJevClient implements JevClient {
  constructor(private readonly o: ProxyJevClientOptions) {}

  async when(request: JevRequest, signal: AbortSignal): Promise<JevAnswer> {
    const t0 = Date.now();
    const body: ProxyWhenBody = { sessionId: this.o.sessionId, request };
    const fetchImpl = this.o.fetch ?? globalThis.fetch.bind(globalThis);
    try {
      const res = await fetchImpl(`${this.o.proxyUrl().replace(/\/+$/, "")}/when`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.o.token}` },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json().catch(() => ({}))) as Partial<ProxyWhenResponse> & { error?: unknown };
      const latencyMs = Date.now() - t0;
      if (!res.ok) return { verdict: null, latencyMs, error: `http ${res.status}${typeof json.error === "string" ? `: ${json.error}` : ""}` };
      const verdict = json.verdict == null ? null : parseJevVerdict(json.verdict);
      const out: JevAnswer = { verdict, latencyMs };
      if (typeof json.error === "string" && json.error) out.error = json.error;
      else if (!verdict) out.error = "no verdict";
      return out;
    } catch (e) {
      return { verdict: null, latencyMs: Date.now() - t0, error: signal.aborted ? "aborted" : `network: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
