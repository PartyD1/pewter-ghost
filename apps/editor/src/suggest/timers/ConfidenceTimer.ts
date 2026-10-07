/**
 * The default timer: confidence sets the moment (plan §5, §12).
 *
 *   patrol fix                         -> now   (the level cannot be finished)
 *   model-initiated fix                -> pause if confidence >= showAtPauseAbove,
 *                                         else longPause (never mid-stroke)
 *   confidence >= showNowAbove         -> now
 *   confidence >= showAtPauseAbove     -> pause
 *   otherwise (or not a finite number) -> longPause
 *
 * Requests (Ctrl+Space, mode "requested") are handled by the manager, which
 * shows them regardless of the timer.
 */
import type { VerifiedSuggestion } from "../../contracts";
import type { Timer, TimerContext, TimerDecision } from "./Timer";

export class ConfidenceTimer implements Timer {
  readonly name = "confidence";

  decide(s: VerifiedSuggestion, ctx: TimerContext): TimerDecision {
    const c = Number.isFinite(s.confidence) ? s.confidence : -Infinity;
    if (s.kind === "fix" && s.mode === "patrol") return { when: "now", why: "patrol-fix" };
    if (s.kind === "fix") {
      return c >= ctx.showAtPauseAbove
        ? { when: "pause", why: "model-fix-waits-for-pause" }
        : { when: "longPause", why: "model-fix-low-confidence" };
    }
    if (c >= ctx.showNowAbove) return { when: "now", why: "confidence>=showNow" };
    if (c >= ctx.showAtPauseAbove) return { when: "pause", why: "confidence>=showAtPause" };
    return { when: "longPause", why: "low-confidence" };
  }
}
