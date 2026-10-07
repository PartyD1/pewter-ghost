/**
 * A Timer decides WHEN a verified suggestion may appear. It does not decide
 * whether it exists (verification did that) nor enforce cool-downs (the
 * manager does that). Implementations must be pure and cheap: the manager
 * calls `decide` on every evaluation (offer, placement, tick).
 */
import type { VerifiedSuggestion } from "../../contracts";
import type { GhostConfig } from "../config";

/**
 *  - "now": show immediately, even mid-stroke;
 *  - "pause": show once the person has been idle for `pauseMs`;
 *  - "longPause": show once idle for `longPauseMs`;
 *  - "request": show only when asked (Ctrl+Space).
 */
export type ShowWhen = "now" | "pause" | "longPause" | "request";

export interface TimerContext {
  /** Session-adapted show-now threshold (suggest/thresholds.ts). */
  showNowAbove: number;
  showAtPauseAbove: number;
  config: Readonly<GhostConfig>;
  /** Current time (ms, session base). */
  now: number;
  /** ms since the person's last placement. */
  idleMs: number;
}

export interface TimerDecision {
  when: ShowWhen;
  /** Short machine-readable reason, for the log and tests. */
  why: string;
}

export interface Timer {
  readonly name: string;
  decide(s: VerifiedSuggestion, ctx: TimerContext): TimerDecision;
}
