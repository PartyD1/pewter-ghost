/**
 * G-16 — verify with send-back. THE ONLY PLACE THAT PRODUCES A
 * VerifiedSuggestion (via suggest/verified.ts `asVerified`).
 *
 *   answer -> validate (shape, repeat, measure) -> playability (rules, agent)
 *     pass -> asVerified({ ...s, path, attempts })
 *     fail -> if the first answer arrived in < config.sendBackIfUnderMs:
 *               ask the filler once more with request.previousFailure =
 *               { reason, stage } and verify the new answer;
 *             else drop.
 *     still failing and a `fallback` is given (patrol fixes, G-23): verify
 *     the fallback's proposal the same way. The fallback runs after the LAST
 *     ALLOWED model attempt: after two failures when the send-back ran, and
 *     after one when the first answer was too slow for a send-back (asking the
 *     model again would only delay the Fix further). G-23's "fails twice"
 *     assumes the usual fast answer.
 *
 * Abort: when `deps.signal` aborts, the promise rejects with the AbortError
 * (from the agent or the filler); nothing is returned half-verified.
 */
import type { FillRequest, Filler, LevelSnapshot, Suggestion, Verdict, VerifiedSuggestion } from "../contracts";
import { config as liveConfig, type GhostConfig } from "../suggest/config";
import { asVerified } from "../suggest/verified";
import { mergeSuggestion, snapshotOf, suggestionCells, type LevelSource } from "./merge";
import { verifyPlayability, type AgentLike, type PlayabilityOptions } from "./playability";
import { validateSuggestion, type ValidateContext } from "./validate";

export interface VerifyDeps {
  agent: AgentLike;
  config?: Pick<GhostConfig, "agentCapMs" | "sendBackIfUnderMs">;
  /** Context for the validator (last ghosts, frontier, bands). */
  validate?: ValidateContext;
  playability?: Omit<PlayabilityOptions, "signal">;
  signal?: AbortSignal;
  /**
   * Local proposer tried when every model answer failed (G-23 patrol fixes:
   * "if the model's fix fails twice"). Its proposal is verified like any other.
   */
  fallback?: () => Suggestion | null | Promise<Suggestion | null>;
  /** Called after each verdict (for the logger / dashboard). */
  onVerdict?: (v: AttemptVerdict) => void;
  /**
   * Extra check run by verifyOnce after validate and playability pass, on the
   * level with the suggestion merged in. Return a failing Verdict (its reason
   * is sent back to the model) or null / an ok Verdict to accept. Patrol fixes
   * use it to require that the fix actually removes the block (G-23).
   */
  extraCheck?: (merged: LevelSnapshot, s: Suggestion, signal?: AbortSignal) => Verdict | null | Promise<Verdict | null>;
}

export interface AttemptVerdict extends Verdict {
  /** 1 = first answer, 2 = after send-back, 3 = fallback proposal. */
  attempt: number;
  suggestionId: string;
  source: "model" | "fallback";
}

export interface VerifyOutcome {
  verified: VerifiedSuggestion | null;
  verdicts: AttemptVerdict[];
  /** Model answers verified (1 or 2; the fallback is not a model attempt). */
  attempts: number;
  sendBack: boolean;
  usedFallback: boolean;
  /** Set when the send-back filler call failed (not aborted). */
  error?: string;
}

const isAbort = (e: unknown) => !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const r = signal.reason;
  if (r instanceof Error && r.name === "AbortError") throw r;
  const e = new Error("verification aborted");
  e.name = "AbortError";
  throw e;
}

/** Validate then play one suggestion. The validator's verdict is returned on its failure. */
export async function verifyOnce(
  level: LevelSource,
  s: Suggestion,
  deps: VerifyDeps,
): Promise<Verdict> {
  const cfg = deps.config ?? liveConfig;
  const v = validateSuggestion(level, s, deps.validate);
  if (!v.ok) return v;
  if (suggestionCells(s).length === 0) return { ok: false, stage: "shape", reason: "the answer changes nothing", ms: v.ms };
  const p = await verifyPlayability(level, s, deps.agent, cfg, { ...deps.playability, signal: deps.signal });
  // Keep the validator's pattern tags on the final verdict (lastGhosts.patterns, G-25).
  const tagged = <T extends Verdict>(x: T): T => (v.tags ? Object.assign(x, { tags: v.tags }) : x);
  if (!p.ok || !deps.extraCheck) return tagged({ ...p, ms: v.ms + p.ms });
  throwIfAborted(deps.signal);
  const x = await deps.extraCheck(mergeSuggestion(snapshotOf(level), s), s, deps.signal);
  if (x && !x.ok) return tagged({ ...x, ms: v.ms + p.ms + x.ms });
  return tagged({ ...p, ms: v.ms + p.ms + (x?.ms ?? 0) });
}

/**
 * Verify a model answer, with one send-back and an optional fallback.
 * `suggestion` may be null (the model declined); then only the fallback runs.
 */
export async function verifyWithSendBack(
  level: LevelSource,
  request: FillRequest,
  suggestion: Suggestion | null,
  filler: Pick<Filler, "fill">,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const cfg = deps.config ?? liveConfig;
  // One snapshot for every attempt: the answers are judged against the level
  // they were asked about (the manager reconciles later edits).
  const snap = snapshotOf(level);
  const verdicts: AttemptVerdict[] = [];
  const out: VerifyOutcome = { verified: null, verdicts, attempts: 0, sendBack: false, usedFallback: false };

  const run = async (s: Suggestion, attempt: number, source: "model" | "fallback") => {
    throwIfAborted(deps.signal);
    const v = await verifyOnce(snap, s, deps);
    const av: AttemptVerdict = { ...v, attempt, suggestionId: s.id, source };
    verdicts.push(av);
    deps.onVerdict?.(av);
    return v;
  };
  const accept = (s: Suggestion, v: Verdict, attempts: number) => {
    out.verified = asVerified({ ...s, path: v.path ?? [], attempts });
    return out;
  };

  let last: Verdict | null = null;
  if (suggestion) {
    out.attempts = 1;
    last = await run(suggestion, 1, "model");
    if (last.ok) return accept(suggestion, last, 1);

    if (suggestion.latencyMs < cfg.sendBackIfUnderMs) {
      out.sendBack = true;
      const retry: FillRequest = {
        ...request,
        previousFailure: { reason: last.reason ?? `failed at ${last.stage}`, stage: last.stage },
      };
      let second: Suggestion | null = null;
      try {
        throwIfAborted(deps.signal);
        second = await filler.fill(retry, deps.signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        out.error = e instanceof Error ? e.message : String(e);
      }
      if (second) {
        out.attempts = 2;
        last = await run(second, 2, "model");
        if (last.ok) return accept(second, last, 2);
      }
    }
  }

  if (deps.fallback) {
    throwIfAborted(deps.signal);
    const f = await deps.fallback();
    if (f) {
      out.usedFallback = true;
      const v = await run(f, 3, "fallback");
      if (v.ok) return accept(f, v, Math.max(1, out.attempts));
    }
  }
  return out;
}
