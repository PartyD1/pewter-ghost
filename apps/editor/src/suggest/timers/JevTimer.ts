/**
 * Jev-driven timer (G-36): a cheap model, polled every few seconds by
 * timing/jev.ts with the window and the person's activity, says "suggest" or
 * "wait". A held ghost shows while the latest verdict is "suggest" and younger
 * than config.jevMaxAgeMs; otherwise it waits ("request": Ctrl+Space still
 * shows it). Patrol fixes show now (safety).
 *
 * Without a verdict source the timer is not configured, which is a
 * programming error, so it throws.
 */
import type { JevVerdict, VerifiedSuggestion } from "../../contracts";
import type { Timer, TimerContext, TimerDecision } from "./Timer";

export class JevTimerNotConfiguredError extends Error {
  constructor() {
    super("JevTimer not configured");
    this.name = "JevTimerNotConfiguredError";
  }
}

/** A verdict and when its poll was sent (session ms). */
export type TimedVerdict = JevVerdict & { at: number };

export class JevTimer implements Timer {
  readonly name = "jev";

  constructor(private readonly verdict?: () => TimedVerdict | null) {}

  decide(s: VerifiedSuggestion, ctx: TimerContext): TimerDecision {
    if (!this.verdict) throw new JevTimerNotConfiguredError();
    if (s.kind === "fix" && s.mode === "patrol") return { when: "now", why: "patrol-fix" };
    const v = this.verdict();
    if (!v || ctx.now - v.at > ctx.config.jevMaxAgeMs) return { when: "request", why: "jev-no-verdict" };
    return v.suggest ? { when: "now", why: "jev-suggest" } : { when: "request", why: "jev-wait" };
  }
}
