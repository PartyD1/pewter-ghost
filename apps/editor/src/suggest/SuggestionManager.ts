/**
 * Suggestion manager (G-17, G-24 manager rules, per-person thresholds).
 *
 * Pure TypeScript, no Phaser: everything time-related comes from an injected
 * Clock (same time base as PlacementEvent.t), and every effect goes out through
 * listener callbacks. The ghost layer renders whatever `onShow` / `onPartial` /
 * `onEnd` say; the editor applies accepted tiles in `onAcceptApply`; the log
 * (G-18) maps `onShow` to `ghost.show` and `onEnd` to `ghost.end`.
 *
 * State machine
 *
 *   idle ──offer──▶ holding ──timer/pause/request──▶ showing ──Tab/Esc/draw/timeout──▶ cooling|idle
 *     ▲                │  (drawn on / superseded / locked)                                 │
 *     └────────────────┴───────────────────────────────── cool-downs lapse ◀──────────────┘
 *
 * One slot: the manager holds at most one VerifiedSuggestion, either held
 * (waiting for its moment) or showing. A newer suggestion replaces it: a held
 * one is dropped ("superseded"), a showing one ends with outcome "replaced".
 *
 * When a held suggestion shows (Timer, default ConfidenceTimer):
 *  - confidence >= showNowAbove (session-adapted) -> now ("now");
 *  - confidence >= showAtPauseAbove -> once idle >= pauseMs ("pause");
 *  - otherwise -> once idle >= longPauseMs ("longPause");
 *  - Ctrl+Space (`requestNow`) or mode "requested" -> immediately ("requested");
 *  - a Fix from whole-level patrol interrupts whatever is showing ("patrol");
 *  - a model-initiated Fix never shows mid-stroke: it waits for a pause.
 *
 * Rules enforced here (all numbers from config):
 *  - Reconciliation: a suggestion whose cells were drawn since its request is
 *    dropped ("stale"), at offer time and on every later placement.
 *  - Draw-to-dismiss: painting on a shown ghost cell with what the ghost
 *    proposes accepts that one cell (partial); painting something else on a
 *    ghost cell, or anywhere else (dismissOnDrawElsewhere), ends it
 *    "drawn-over". An end with some cells already accepted is reported as
 *    "partial" with the count.
 *  - Cool-down: after a dismissal (Esc or drawn-over), no ghost whose bounding
 *    box overlaps the dismissed one (grown by cooldownMarginTiles) for
 *    cooldownAfterDismissMs.
 *  - Dismiss streak: after maxDismissStreak dismissals in a row, automatic
 *    ghosts wait until asked (Ctrl+Space) or until a placement farther than
 *    newStructureTiles from every dismissed ghost starts a new structure.
 *    Patrol fixes are exempt (safety beats politeness).
 *  - Showing patrol fix: only another patrol fix or a requested suggestion may
 *    replace it; other offers are dropped ("blocked").
 *  - Fix: never one touching cells the person placed within fixGraceMs; one per
 *    problem (label + anchor cell) per fixPerProblemMs; a drawn-over fix mutes
 *    its problem until one of its cells changes by a later stroke.
 *  - config.kinds: disabled kinds are dropped.
 *  - A shown ghost with no response ends "timeout" after ghostTimeoutMs (0 = never).
 */
import {
  AUTHOR,
  type GhostOutcome,
  type PlacementEvent,
  type Point,
  type ShownBecause,
  type Suggestion,
  type VerifiedSuggestion,
} from "../contracts";
import { config as globalConfig, type GhostConfig } from "./config";
import { performanceClock, type Clock } from "./fakeClock";
import {
  boxesOverlap,
  cellKey,
  cellSignature,
  distanceToBox,
  ghostCellMap,
  ghostCells,
  problemKey,
  relatePlacement,
  suggestionBox,
  type Box,
  type GhostCell,
} from "./geometry";
import { SessionThresholds, type ThresholdChange } from "./thresholds";
import { ConfidenceTimer } from "./timers/ConfidenceTimer";
import type { Timer, TimerDecision } from "./timers/Timer";
import { isVerified } from "./verified";

export type ManagerState = "idle" | "holding" | "showing" | "cooling";

/** Why a suggestion was dropped without being shown (or kept off screen). */
export type DropReason =
  | "unverified"
  | "kind-disabled"
  | "stale"
  | "superseded"
  | "duplicate"
  | "blocked"
  | "cooldown"
  | "grace"
  | "rate-limited"
  | "muted"
  | "reset";

export interface AcceptInfo {
  /** Cells the person already painted by hand (partial accepts) — already in the level. */
  alreadyAccepted: GhostCell[];
  /** Cells the caller still has to apply. */
  remaining: GhostCell[];
}

export interface ManagerListeners {
  /** A ghost appears. Log as `ghost.show`. */
  onShow?(s: VerifiedSuggestion, shownBecause: ShownBecause, t: number): void;
  /**
   * A shown ghost is gone. Log as `ghost.end`. `acceptedCells` is set for
   * "accepted" (all cells) and "partial" (cells painted by hand).
   */
  onEnd?(
    s: VerifiedSuggestion,
    outcome: GhostOutcome,
    dwellMs: number,
    acceptedCells: number | undefined,
    t: number,
  ): void;
  /** Tab: the caller applies the suggestion to the LevelModel as one undoable command. Called before onEnd. */
  onAcceptApply?(s: VerifiedSuggestion, info: AcceptInfo): void;
  /** The person painted one ghost cell exactly as proposed. */
  onPartial?(s: VerifiedSuggestion, cell: GhostCell, acceptedCount: number, total: number): void;
  /** A suggestion was dropped without showing. */
  onDrop?(s: Suggestion, reason: DropReason, t: number): void;
  onStateChange?(state: ManagerState, prev: ManagerState): void;
  onThresholdChange?(change: ThresholdChange): void;
}

export interface ManagerOptions {
  clock?: Clock;
  /** Config object or getter; defaults to the global, live `config`. */
  config?: GhostConfig | (() => GhostConfig);
  timer?: Timer;
  /** Supply to share thresholds across managers; otherwise one is created. */
  thresholds?: SessionThresholds;
  listeners?: ManagerListeners;
}

export interface OfferOptions {
  /**
   * When the fill request for this suggestion was made (session ms). Cells
   * drawn after this make the suggestion stale. Default: now - s.latencyMs.
   */
  requestedAt?: number;
}

export type OfferResult =
  | { status: "shown"; because: ShownBecause }
  | { status: "held"; when: TimerDecision["when"] | "locked" }
  | { status: "dropped"; reason: DropReason };

export type RequestResult = "shown" | "already-showing" | "pending";

interface Slot {
  s: VerifiedSuggestion;
  cells: Map<string, GhostCell[]>;
  keys: Set<string>;
  box: Box;
  total: number;
  sig: string;
  requestedAt: number;
  offeredAt: number;
  requested: boolean;
  patrolFix: boolean;
  shownAt: number;
  because: ShownBecause | null;
  accepted: Map<string, GhostCell>;
}

interface Cooldown {
  box: Box;
  until: number;
}

interface Mute {
  keys: Set<string>;
  stroke: string;
}

const cellId = (c: GhostCell) => `${c.type}:${c.x},${c.y}`;

const DISMISSALS: ReadonlySet<GhostOutcome> = new Set<GhostOutcome>(["esc", "drawn-over"]);
const ACCEPTS: ReadonlySet<GhostOutcome> = new Set<GhostOutcome>(["accepted", "partial"]);

export class SuggestionManager {
  private readonly clock: Clock;
  private readonly cfgGetter: () => GhostConfig;
  private readonly timer: Timer;
  readonly thresholds: SessionThresholds;
  private readonly on: ManagerListeners;

  private held: Slot | null = null;
  private showing: Slot | null = null;
  private stateValue: ManagerState = "idle";

  private lastActivity: number;
  private cellChanges = new Map<string, { t: number; stroke: string }>();
  private cooldowns: Cooldown[] = [];
  private dismissStreak = 0;
  private dismissedBoxes: Box[] = [];
  private fixShownAt = new Map<string, number>();
  private mutes = new Map<string, Mute>();
  private pendingRequestUntil: number | null = null;

  constructor(opts: ManagerOptions = {}) {
    this.clock = opts.clock ?? performanceClock;
    const c = opts.config;
    this.cfgGetter = typeof c === "function" ? c : c ? () => c : () => globalConfig;
    this.timer = opts.timer ?? new ConfidenceTimer();
    this.on = opts.listeners ?? {};
    this.thresholds =
      opts.thresholds ??
      new SessionThresholds(this.cfgGetter, (ch) => this.on.onThresholdChange?.(ch));
    this.lastActivity = this.clock.now();
  }

  // ------------------------------------------------------------------ getters

  get state(): ManagerState {
    return this.stateValue;
  }
  /** The suggestion on screen, if any. */
  get shown(): VerifiedSuggestion | null {
    return this.showing?.s ?? null;
  }
  get shownBecause(): ShownBecause | null {
    return this.showing?.because ?? null;
  }
  /** The suggestion waiting for its moment, if any. */
  get waiting(): VerifiedSuggestion | null {
    return this.held?.s ?? null;
  }
  /** Ghost cells of the shown suggestion not yet painted by hand. */
  get remainingCells(): GhostCell[] {
    const sl = this.showing;
    if (!sl) return [];
    return ghostCells(sl.s).filter((c) => !sl.accepted.has(cellId(c)));
  }
  get streak(): number {
    return this.dismissStreak;
  }
  /** True while the dismiss streak holds automatic ghosts back. */
  get locked(): boolean {
    const max = this.cfg().maxDismissStreak;
    return max > 0 && this.dismissStreak >= max;
  }
  get showNowAbove(): number {
    return this.thresholds.showNowAbove;
  }
  get requestPending(): boolean {
    return this.pendingRequestUntil !== null && this.clock.now() <= this.pendingRequestUntil;
  }
  isMuted(s: Pick<Suggestion, "label" | "anchor">): boolean {
    return this.mutes.has(problemKey(s));
  }
  /** True when a ghost overlapping `s` would be held back by an active cool-down. */
  inCooldown(s: Suggestion, now = this.clock.now()): boolean {
    const box = suggestionBox(s);
    const margin = this.cfg().cooldownMarginTiles;
    return this.cooldowns.some((c) => c.until > now && boxesOverlap(c.box, box, margin));
  }

  // ------------------------------------------------------------------- inputs

  /**
   * Offer a verified suggestion. Only `VerifiedSuggestion` type-checks; the
   * brand is also checked at runtime.
   */
  offer(s: VerifiedSuggestion, opts: OfferOptions = {}): OfferResult {
    const now = this.clock.now();
    const cfg = this.cfg();
    if (!isVerified(s)) return this.dropNew(s, "unverified", now);
    if (!cfg.kinds[s.kind]) return this.dropNew(s, "kind-disabled", now);

    const slot = this.makeSlot(s, now, opts);

    // Reconciliation: anything drawn on its cells since the request?
    for (const k of slot.keys) {
      const ch = this.cellChanges.get(k);
      if (ch && ch.t > slot.requestedAt) return this.dropNew(s, "stale", now);
    }

    if (this.showing && this.showing.sig === slot.sig) return this.dropNew(s, "duplicate", now);

    if (this.showing?.patrolFix && !slot.patrolFix && !slot.requested) {
      return this.dropNew(s, "blocked", now);
    }

    if (s.kind === "fix") {
      for (const k of slot.keys) {
        const ch = this.cellChanges.get(k);
        if (ch && now - ch.t < cfg.fixGraceMs) return this.dropNew(s, "grace", now);
      }
      if (!slot.requested) {
        const pk = problemKey(s);
        if (this.mutes.has(pk)) return this.dropNew(s, "muted", now);
        const last = this.fixShownAt.get(pk);
        if (last !== undefined && now - last < cfg.fixPerProblemMs) {
          return this.dropNew(s, "rate-limited", now);
        }
      }
    }

    if (!slot.requested) {
      this.expireCooldowns(now);
      if (this.inCooldown(s, now)) return this.dropNew(s, "cooldown", now);
    }

    // One slot: the newer suggestion replaces whatever is there.
    if (this.held) this.dropHeld("superseded", now);
    if (this.showing) this.endShowing("replaced", now);
    this.held = slot;

    this.evaluate(now);
    if (this.showing === slot) return { status: "shown", because: slot.because! };
    if (this.held === slot) {
      return { status: "held", when: this.lockedFor(slot) ? "locked" : this.decide(slot, now).when };
    }
    // Not reachable in practice (evaluate only shows or keeps the held slot).
    return { status: "dropped", reason: "superseded" };
  }

  /**
   * A placement by the person (paint or erase). Placements by the ghost
   * (author GHOST) are ignored: accepted tiles come back through the level
   * model and must not count as drawing.
   */
  onPlacement(ev: PlacementEvent): void {
    if (ev.author !== AUTHOR.PERSON) return;
    const now = this.clock.now();
    const key = cellKey(ev.x, ev.y);
    this.lastActivity = Math.max(this.lastActivity, ev.t);

    // New structure? Checked before this placement can dismiss anything, so
    // the dismissal it causes does not count against itself.
    if (this.locked && this.dismissedBoxes.length > 0) {
      const far = this.cfg().newStructureTiles;
      if (this.dismissedBoxes.every((b) => distanceToBox(ev, b) > far)) {
        this.dismissStreak = 0;
        this.dismissedBoxes = [];
        // Anything held predates the new structure.
        if (this.held && !this.held.requested && !this.held.patrolFix) {
          this.dropHeld("superseded", now);
        }
      }
    }

    this.unmuteFor(key, ev.stroke);
    this.cellChanges.set(key, { t: ev.t, stroke: ev.stroke });

    const sl = this.showing;
    if (sl) {
      const { relation, cell } = relatePlacement(sl.cells, ev);
      if (relation === "match" && cell) {
        const id = cellId(cell);
        if (!sl.accepted.has(id)) {
          sl.accepted.set(id, cell);
          this.on.onPartial?.(sl.s, cell, sl.accepted.size, sl.total);
          if (sl.accepted.size >= sl.total) this.endShowing("partial", now);
        }
      } else if (relation === "conflict") {
        this.endShowing("drawn-over", now, ev.stroke);
      } else if (this.cfg().dismissOnDrawElsewhere) {
        this.endShowing("drawn-over", now, ev.stroke);
      }
    }

    if (this.held && this.held.keys.has(key)) this.dropHeld("stale", now);

    this.evaluate(now);
  }

  /**
   * Cells changed by something other than a placement (undo, redo, load).
   * Counts as activity, reconciles held/showing suggestions (a shown ghost
   * whose cells changed ends "drawn-over") and unmutes problems.
   */
  onCellsChanged(cells: Point[], t = this.clock.now(), stroke = `change@${t}`): void {
    const now = this.clock.now();
    this.lastActivity = Math.max(this.lastActivity, t);
    let hitShowing = false;
    let hitHeld = false;
    for (const p of cells) {
      const key = cellKey(p.x, p.y);
      this.unmuteFor(key, stroke);
      this.cellChanges.set(key, { t, stroke });
      if (this.showing?.keys.has(key)) hitShowing = true;
      if (this.held?.keys.has(key)) hitHeld = true;
    }
    if (hitShowing) this.endShowing("drawn-over", now, stroke);
    if (hitHeld) this.dropHeld("stale", now);
    this.evaluate(now);
  }

  /** Drive pauses, long pauses, timeouts and cool-down expiry. Call every frame or on a timer. */
  tick(now?: number): void {
    this.evaluate(now ?? this.clock.now());
  }

  /** Tab. Returns true when a ghost was accepted. */
  accept(): boolean {
    const sl = this.showing;
    if (!sl) return false;
    const all = ghostCells(sl.s);
    const alreadyAccepted = all.filter((c) => sl.accepted.has(cellId(c)));
    const remaining = all.filter((c) => !sl.accepted.has(cellId(c)));
    this.on.onAcceptApply?.(sl.s, { alreadyAccepted, remaining });
    const now = this.clock.now();
    this.endShowing("accepted", now);
    this.evaluate(now);
    return true;
  }

  /** Esc. Returns true when a shown ghost was dismissed. Also cancels a pending request. */
  dismiss(): boolean {
    this.pendingRequestUntil = null;
    if (!this.showing) return false;
    const now = this.clock.now();
    this.endShowing("esc", now);
    this.evaluate(now);
    return true;
  }

  /**
   * Ctrl+Space. Shows the held suggestion now, or marks a request pending so
   * the next suggestion within requestWindowMs shows immediately. The caller
   * should also fire a fill with mode "requested".
   */
  requestNow(): RequestResult {
    const now = this.clock.now();
    if (this.showing) return "already-showing";
    if (this.held) {
      this.held.requested = true;
      this.evaluate(now);
      return "shown";
    }
    this.pendingRequestUntil = now + this.cfg().requestWindowMs;
    this.updateState();
    return "pending";
  }

  /** Alias of requestNow (Ctrl+Space handler name used in the plan). */
  onRequest(): RequestResult {
    return this.requestNow();
  }

  /**
   * Clear everything (new level, end of session). A shown ghost ends with
   * outcome "pending". Per-session thresholds are kept unless asked.
   */
  reset(opts: { thresholds?: boolean } = {}): void {
    const now = this.clock.now();
    if (this.showing) this.endShowing("pending", now);
    if (this.held) this.dropHeld("reset", now);
    this.cellChanges.clear();
    this.cooldowns = [];
    this.dismissStreak = 0;
    this.dismissedBoxes = [];
    this.fixShownAt.clear();
    this.mutes.clear();
    this.pendingRequestUntil = null;
    this.lastActivity = now;
    if (opts.thresholds) this.thresholds.reset();
    this.updateState();
  }

  // ---------------------------------------------------------------- internals

  private cfg(): GhostConfig {
    return this.cfgGetter();
  }

  private makeSlot(s: VerifiedSuggestion, now: number, opts: OfferOptions): Slot {
    const cells = ghostCellMap(s);
    const latency = Number.isFinite(s.latencyMs) && s.latencyMs > 0 ? s.latencyMs : 0;
    const requestPending = this.pendingRequestUntil !== null && now <= this.pendingRequestUntil;
    return {
      s,
      cells,
      keys: new Set(cells.keys()),
      box: suggestionBox(s),
      total: ghostCells(s).length,
      sig: cellSignature(s),
      requestedAt: opts.requestedAt ?? now - latency,
      offeredAt: now,
      requested: s.mode === "requested" || requestPending,
      patrolFix: s.kind === "fix" && s.mode === "patrol",
      shownAt: 0,
      because: null,
      accepted: new Map(),
    };
  }

  private decide(slot: Slot, now: number): TimerDecision {
    const cfg = this.cfg();
    return this.timer.decide(slot.s, {
      showNowAbove: this.thresholds.showNowAbove,
      showAtPauseAbove: cfg.showAtPauseAbove,
      config: cfg,
      now,
      idleMs: now - this.lastActivity,
    });
  }

  /** Is this held slot kept back by the dismiss streak? */
  private lockedFor(slot: Slot): boolean {
    return this.locked && !slot.requested && !slot.patrolFix;
  }

  private evaluate(now: number): void {
    const cfg = this.cfg();
    this.expireCooldowns(now);
    if (this.pendingRequestUntil !== null && now > this.pendingRequestUntil) {
      this.pendingRequestUntil = null;
    }

    if (this.showing && cfg.ghostTimeoutMs > 0 && now - this.showing.shownAt >= cfg.ghostTimeoutMs) {
      this.endShowing("timeout", now);
    }

    const h = this.held;
    if (h && !this.showing) {
      if (h.requested) this.show(h, "requested", now);
      else if (h.patrolFix) this.show(h, "patrol", now);
      else if (!this.lockedFor(h)) {
        const d = this.decide(h, now);
        const idle = now - this.lastActivity;
        if (d.when === "now") this.show(h, "now", now);
        else if (d.when === "pause" && idle >= cfg.pauseMs) this.show(h, "pause", now);
        else if (d.when === "longPause" && idle >= cfg.longPauseMs) this.show(h, "longPause", now);
      }
    }
    this.updateState(now);
  }

  private show(slot: Slot, because: ShownBecause, now: number): void {
    if (this.held === slot) this.held = null;
    slot.shownAt = now;
    slot.because = because;
    this.showing = slot;
    if (slot.requested) this.pendingRequestUntil = null;
    if (slot.s.kind === "fix") this.fixShownAt.set(problemKey(slot.s), now);
    this.on.onShow?.(slot.s, because, now);
  }

  private endShowing(outcome: GhostOutcome, now: number, stroke?: string): void {
    const sl = this.showing;
    if (!sl) return;
    this.showing = null;
    const acceptedCount = sl.accepted.size;
    let final: GhostOutcome = outcome;
    if (outcome !== "accepted" && acceptedCount > 0) final = "partial";
    const acceptedCells =
      final === "accepted" ? sl.total : final === "partial" ? acceptedCount : undefined;
    const dwell = Math.max(0, now - sl.shownAt);
    this.on.onEnd?.(sl.s, final, dwell, acceptedCells, now);

    this.thresholds.record(final);

    if (DISMISSALS.has(final)) {
      this.dismissStreak++;
      this.dismissedBoxes.push(sl.box);
      this.cooldowns.push({ box: sl.box, until: now + this.cfg().cooldownAfterDismissMs });
      if (final === "drawn-over" && sl.s.kind === "fix") {
        this.mutes.set(problemKey(sl.s), {
          keys: new Set(sl.keys),
          stroke: stroke ?? `end@${now}`,
        });
      }
    } else if (ACCEPTS.has(final)) {
      this.dismissStreak = 0;
      this.dismissedBoxes = [];
    }
  }

  private dropHeld(reason: DropReason, now: number): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    this.on.onDrop?.(h.s, reason, now);
  }

  private dropNew(s: Suggestion, reason: DropReason, now: number): OfferResult {
    this.on.onDrop?.(s, reason, now);
    this.updateState();
    return { status: "dropped", reason };
  }

  private unmuteFor(key: string, stroke: string): void {
    if (this.mutes.size === 0) return;
    for (const [pk, m] of this.mutes) {
      if (m.keys.has(key) && m.stroke !== stroke) this.mutes.delete(pk);
    }
  }

  private expireCooldowns(now: number): void {
    if (this.cooldowns.length) this.cooldowns = this.cooldowns.filter((c) => c.until > now);
  }

  private updateState(now = this.clock.now()): void {
    let next: ManagerState;
    if (this.showing) next = "showing";
    else if (this.held) next = "holding";
    else if (this.locked || this.cooldowns.some((c) => c.until > now)) next = "cooling";
    else next = "idle";
    if (next !== this.stateValue) {
      const prev = this.stateValue;
      this.stateValue = next;
      this.on.onStateChange?.(next, prev);
    }
  }
}
