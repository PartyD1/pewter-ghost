/**
 * Placeholder for a Jev-driven timer (plan: "LLM first; algorithm and Jev much
 * later"). Jev is a very late comparison condition; this class exists only so
 * the Timer seam is proven and a real implementation can drop in without
 * touching the manager. Using it before it is configured is a programming
 * error, so it throws.
 */
import type { VerifiedSuggestion } from "../../contracts";
import type { Timer, TimerContext, TimerDecision } from "./Timer";

export class JevTimerNotConfiguredError extends Error {
  constructor() {
    super("JevTimer not configured");
    this.name = "JevTimerNotConfiguredError";
  }
}

export class JevTimer implements Timer {
  readonly name = "jev";

  decide(_s: VerifiedSuggestion, _ctx: TimerContext): TimerDecision {
    throw new JevTimerNotConfiguredError();
  }
}
