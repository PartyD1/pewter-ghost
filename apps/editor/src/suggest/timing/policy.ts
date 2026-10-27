/**
 * The timing condition of a session (config.timing), behind the manager's one
 * Timer seam, so the same filler and verifier run under all three:
 *
 *   llm   ConfidenceTimer: the filler decides (act, and its confidence sets
 *         the moment). The baseline; the behaviour before timing policies.
 *   cdhf  Conditional suggestion display from human feedback (Mozannar et al.
 *         2023). Stage 1 `gate`: skip an auto/tidy model call when
 *         P(accept | context) < cdhfGateBelow and its entropy < cdhfGateEntropy.
 *         Stage 2 CdhfTimer: show once P(accept | context, ghost) >= cdhfShowAbove.
 *   jev   JevPoller asks a cheap model every jevIntervalMs; JevTimer shows a
 *         held ghost while the latest fresh verdict is "suggest".
 *
 * Under every policy each shown ghost is logged as a `timing` event with its
 * feature vector and the CDHF prediction, so sessions run as "llm" are
 * training data for the predictor and the policies can be compared offline
 * (eval `timing`). Requests (Ctrl+Space) and patrol fixes bypass all three.
 */
import type { FillMode, LogEvent, PlacementEvent, TimingPolicyName, VerifiedSuggestion } from "../../contracts";
import type { TimerApi } from "../../verify/patrol";
import type { GhostConfig } from "../config";
import type { ManagerListeners } from "../SuggestionManager";
import { CdhfTimer } from "../timers/CdhfTimer";
import { ConfidenceTimer } from "../timers/ConfidenceTimer";
import { JevTimer } from "../timers/JevTimer";
import type { Timer, TimerContext, TimerDecision } from "../timers/Timer";
import { ActivityTracker } from "./activity";
import { contextFeatures, fullFeatures, roundFeatures } from "./features";
import { JevPoller, type JevClient, type JevPollerOptions } from "./jev";
import { entropyBits, isCdhfWeights, predict, PRIOR_WEIGHTS, type CdhfWeights } from "./model";

export const TIMING_POLICIES: readonly TimingPolicyName[] = ["llm", "cdhf", "jev"];
export const isTimingPolicy = (v: unknown): v is TimingPolicyName =>
  typeof v === "string" && (TIMING_POLICIES as readonly string[]).includes(v);

/** Modes the CDHF gate may skip. Requests and patrol always call. */
const GATED: ReadonlySet<FillMode> = new Set(["auto", "tidy"]);

export interface TimingPolicyOptions {
  config: () => GhostConfig;
  clock: () => number;
  log: (e: LogEvent) => void;
  timers?: TimerApi;
}

/** What the Jev poller needs from the running editor (PewterApp.attachEditor). */
export type JevHooks = Pick<JevPollerOptions, "request" | "held" | "showing" | "active" | "nudge">;

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export class TimingPolicy implements Timer {
  readonly activity: ActivityTracker;
  private readonly confidence = new ConfidenceTimer();
  readonly cdhf: CdhfTimer;
  private readonly jevTimer: JevTimer;
  private poller: JevPoller | null = null;
  private client: JevClient | null = null;
  private hooks: JevHooks | null = null;
  /** Calls the CDHF gate skipped (dev tools, tests). */
  readonly stats = { gated: 0 };

  constructor(private readonly o: TimingPolicyOptions) {
    this.activity = new ActivityTracker(o.clock);
    this.cdhf = new CdhfTimer((now) => this.activity.snapshot(now), () => this.weights());
    this.jevTimer = new JevTimer(() => this.poller?.verdict ?? null);
  }

  /** The configured policy ("llm" for anything unknown). */
  get policy(): TimingPolicyName {
    const p = this.o.config().timing;
    return isTimingPolicy(p) ? p : "llm";
  }

  get name(): string {
    return `timing:${this.policy}`;
  }

  /** The Jev poller, once a client and the editor are attached. */
  get jev(): JevPoller | null {
    return this.poller;
  }

  weights(): CdhfWeights {
    const w = this.o.config().cdhfWeights;
    return isCdhfWeights(w) ? w : PRIOR_WEIGHTS;
  }

  decide(s: VerifiedSuggestion, ctx: TimerContext): TimerDecision {
    switch (this.policy) {
      case "cdhf":
        return this.cdhf.decide(s, ctx);
      case "jev":
        return this.jevTimer.decide(s, ctx);
      default:
        return this.confidence.decide(s, ctx);
    }
  }

  /**
   * CDHF stage 1: may the loop call the filler for this mode now? Always true
   * outside "cdhf" and for requests and patrol. A skip is logged.
   */
  gate(mode: FillMode): boolean {
    if (this.policy !== "cdhf" || !GATED.has(mode)) return true;
    const cfg = this.o.config();
    const now = this.o.clock();
    const f = contextFeatures(this.activity.snapshot(now), mode);
    const p = predict(this.weights().context, f);
    const h = entropyBits(p);
    if (!(p < cfg.cdhfGateBelow && h < cfg.cdhfGateEntropy)) return true;
    this.stats.gated++;
    this.o.log({
      type: "timing",
      t: now,
      policy: "cdhf",
      stage: "gate",
      decision: "skip",
      p: round3(p),
      entropy: round3(h),
      mode,
      features: roundFeatures(f),
    });
    return false;
  }

  /** Feed every placement (the tracker keeps the person's). */
  placement(ev: PlacementEvent): void {
    this.activity.placement(ev);
  }

  /** New level. */
  reset(): void {
    this.activity.reset();
    this.poller?.clear();
  }

  /** Pass to the ghost session with the loop's own listeners. */
  readonly listeners: ManagerListeners = {
    onShow: (s, because, t) => {
      const f = fullFeatures(s, this.activity.snapshot(t));
      this.o.log({
        type: "timing",
        t,
        policy: this.policy,
        stage: "show",
        decision: "show",
        p: round3(predict(this.weights().full, f)),
        suggestionId: s.id,
        mode: s.mode,
        features: roundFeatures(f),
        why: because,
      });
      this.activity.ghostShown();
    },
    onEnd: (_s, outcome, _dwell, _accepted, t) => this.activity.ghostEnded(outcome, t),
  };

  /** The Jev behind the poller (null = none; a "jev" session then holds ghosts until asked). */
  setJevClient(client: JevClient | null): void {
    this.client = client;
    this.syncJev();
  }

  /** Start the Jev poller against a running editor. Returns the detach. */
  attach(hooks: JevHooks): () => void {
    this.hooks = hooks;
    this.syncJev();
    return () => {
      if (this.hooks === hooks) this.hooks = null;
      this.syncJev();
    };
  }

  dispose(): void {
    this.hooks = null;
    this.client = null;
    this.syncJev();
  }

  private syncJev(): void {
    this.poller?.stop();
    this.poller = null;
    if (!this.client || !this.hooks) return;
    this.poller = new JevPoller({
      ...this.hooks,
      client: this.client,
      config: this.o.config,
      clock: this.o.clock,
      timers: this.o.timers ?? defaultTimers,
      log: this.o.log,
      activity: (now) => this.activity.snapshot(now),
    });
    this.poller.start();
  }
}
