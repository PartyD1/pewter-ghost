/**
 * Verification scorer: the app's own pipeline (@app/verify) on one answer.
 *
 *  - validator stage and pattern tags (validateSuggestion)
 *  - first try: validator + rule check + playtest agent (verifyWithSendBack;
 *    patrol answers through verifyPatrolFix, with the local repair fallback
 *    switched OFF so the model is scored, not the proposer)
 *  - send-back: the failure reason goes back to the model once; whether the
 *    second answer passes
 */
import type { FillRequest, Filler, LevelSnapshot, Suggestion, VerdictStage } from "../../../apps/editor/src/contracts";
import { validateSuggestion, type ValidateContext } from "../../../apps/editor/src/verify/validate";
import type { AgentLike } from "../../../apps/editor/src/verify/playability";
import { verifyWithSendBack, type VerifyOutcome } from "../../../apps/editor/src/verify/pipeline";
import { verifyPatrolFix, type PatrolBlocked } from "../../../apps/editor/src/verify/patrol";

export interface VerifyScore {
  validatorStage: VerdictStage | "ok";
  validatorReason?: string;
  tags: string[];
  firstTryOk: boolean;
  firstStage: VerdictStage | "ok";
  firstReason?: string;
  agentTimedOut: boolean;
  sendBack: boolean;
  sendBackOk?: boolean;
  sendBackError?: string;
  outcome: VerifyOutcome;
}

export interface VerifyScoreOptions {
  agent: AgentLike;
  agentCapMs: number;
  /** Send-back gate in ms: Infinity = always, -1 = never. */
  sendBackIfUnderMs: number;
  /** Patrol cases: the blocking point (level coordinates). */
  blocked?: PatrolBlocked;
  /** Patrol cap for the fix check. */
  patrolCapMs?: number;
}

/** Validator context the app would use for this request. */
export function validateContextFor(req: Pick<FillRequest, "lastGhosts" | "origin" | "frontier">): ValidateContext {
  return {
    act: true,
    lastGhosts: req.lastGhosts,
    frontierX: req.origin.x + req.frontier.x,
  };
}

/** Patrol context for a request without a seed's blocked info (recordings). */
export function blockedFromRequest(req: FillRequest, level: LevelSnapshot): PatrolBlocked | undefined {
  if (req.mode !== "patrol" || !req.blockedAt) return undefined;
  const at = { x: req.blockedAt.x + req.origin.x, y: req.blockedAt.y + req.origin.y };
  return {
    blockedAt: at,
    reason: req.previousFailure?.reason ?? "the knight is stuck here",
    from: { ...level.start },
    goalX: Math.min(level.w - 1, req.origin.x + req.size.w - 1),
  };
}

export async function scoreVerification(
  level: LevelSnapshot,
  req: FillRequest,
  s: Suggestion,
  sendBackFiller: Pick<Filler, "fill">,
  o: VerifyScoreOptions,
): Promise<VerifyScore> {
  const vctx = validateContextFor(req);
  const v = validateSuggestion(level, s, vctx);
  const deps = {
    agent: o.agent,
    config: { agentCapMs: o.agentCapMs, sendBackIfUnderMs: o.sendBackIfUnderMs, patrolCapMs: o.patrolCapMs ?? 1000 },
    validate: vctx,
    fallback: () => null,
  };
  let sendBackError: string | undefined;
  const filler: Pick<Filler, "fill"> = {
    fill: async (r, signal) => {
      try {
        return await sendBackFiller.fill(r, signal);
      } catch (e) {
        sendBackError = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
  };
  const outcome =
    req.mode === "patrol" && o.blocked
      ? await verifyPatrolFix(level, req, s, filler, o.blocked, deps)
      : await verifyWithSendBack(level, req, s, filler, deps);
  const first = outcome.verdicts[0];
  const second = outcome.verdicts.find((x) => x.attempt === 2);
  return {
    validatorStage: v.ok ? "ok" : v.stage,
    validatorReason: v.ok ? undefined : v.reason,
    tags: [...(v.tags ?? [])],
    firstTryOk: !!first?.ok,
    firstStage: first ? (first.ok ? "ok" : first.stage) : "shape",
    firstReason: first && !first.ok ? first.reason : undefined,
    agentTimedOut: !!(first as { timedOut?: boolean } | undefined)?.timedOut,
    sendBack: outcome.sendBack,
    sendBackOk: outcome.sendBack ? !!second?.ok : undefined,
    sendBackError: sendBackError ?? outcome.error,
    outcome,
  };
}
