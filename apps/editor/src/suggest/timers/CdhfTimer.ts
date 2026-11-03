/**
 * CDHF stage 2 (Mozannar et al. 2023, "When to Show a Suggestion?"): show a
 * verified ghost only when the predicted acceptance P(accept | context, ghost)
 * reaches config.cdhfShowAbove (t2); otherwise keep it hidden.
 *
 * The paper makes the decision once, when the suggestion arrives. Here the
 * manager asks on every tick, and the context moves (idle time grows, the
 * drag ends), so a ghost hidden mid-stroke can show at the pause where it
 * becomes likely to be kept. That turns "whether" into "when". Hidden means
 * "request": Ctrl+Space still shows it. Patrol fixes show now (safety).
 *
 * Stage 1 (skip the model call when context alone says reject) lives in
 * timing/policy.ts, where calls start.
 */
import type { VerifiedSuggestion } from "../../contracts";
import type { ActivitySnapshot } from "../timing/activity";
import { fullFeatures } from "../timing/features";
import { predict, type CdhfWeights } from "../timing/model";
import type { Timer, TimerContext, TimerDecision } from "./Timer";

export class CdhfTimer implements Timer {
  readonly name = "cdhf";

  constructor(
    private readonly activity: (now: number) => ActivitySnapshot,
    private readonly weights: () => CdhfWeights,
  ) {}

  /** P(accept | context now, s). */
  probability(s: VerifiedSuggestion, now: number): number {
    return predict(this.weights().full, fullFeatures(s, this.activity(now)));
  }

  decide(s: VerifiedSuggestion, ctx: TimerContext): TimerDecision {
    if (s.kind === "fix" && s.mode === "patrol") return { when: "now", why: "patrol-fix" };
    return this.probability(s, ctx.now) >= ctx.config.cdhfShowAbove
      ? { when: "now", why: "cdhf>=show" }
      : { when: "request", why: "cdhf<show" };
  }
}
