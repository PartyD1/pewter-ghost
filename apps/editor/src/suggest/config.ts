/**
 * Every tunable number lives here (build plan §12). Code reads `config`;
 * a study build or a launcher token may override fields via `applyOverrides`.
 */
export interface GhostConfig {
  /** Confidence at or above which a verified ghost shows immediately. */
  showNowAbove: number;
  /** Confidence at or above which a ghost shows at the next pause. */
  showAtPauseAbove: number;
  /** Idle ms that counts as a pause. */
  pauseMs: number;
  /** Idle ms after which low-confidence ghosts may show. */
  longPauseMs: number;
  /**
   * Give up on a model call after this many ms. The plan's target is 900 ms,
   * but live gemini-3.7-flash answers (thinking off) take 2.0 s p50, 2.9 s
   * p90, 3.6 s p98 and up to 11.4 s (eval/runs/baseline.json, 52 calls), and a
   * live staircase call took 5.2 s. 900 drops every answer and 3500 dropped
   * the slow-but-right ones. 6000 keeps every measured answer except the 11 s
   * outlier. Freshness is no longer the timeout's job: reconciliation drops
   * an answer that no longer fits (cells drawn, newer shown, older than
   * maxAnswerAgeMs). Keep it below maxAnswerAgeMs, so an answer that beats the
   * timeout is still young enough to show. Lower it once a faster model
   * passes the offline suite (G-28).
   */
  callTimeoutMs: number;
  /** Playtest agent time cap per suggestion. */
  agentCapMs: number;
  /** Agent time cap for whole-level patrol. */
  patrolCapMs: number;
  /** Idle ms before whole-level patrol runs. */
  patrolIdleMs: number;
  /** A failed answer gets one send-back only if it arrived faster than this. */
  sendBackIfUnderMs: number;
  /** Silence on the same structure after a dismissal. */
  cooldownAfterDismissMs: number;
  /** After this many dismissals in a row, wait until asked or a new structure. */
  maxDismissStreak: number;
  /** Never fix cells the person placed within this many ms. */
  fixGraceMs: number;
  /** One fix per problem per this many ms. */
  fixPerProblemMs: number;
  /** ASCII window size sent to the model. */
  windowCols: number;
  windowRows: number;
  /** Number of recent placements in the request. */
  recentCount: number;
  /** Number of past ghosts in the request. */
  historyCount: number;
  /** Model id used by the proxy (informational on the client). */
  model: string;
  /** Which filler is active. "none" = human-only editing. */
  filler: "llm" | "algo" | "stub" | "none";
  /** Suggestion kinds enabled. */
  kinds: { finish: boolean; extend: boolean; fix: boolean };
  /** Confidence source (G-27). */
  confidenceSource: "stated" | "logprob" | "twoSample";
  /** Proxy base URL. */
  proxyUrl: string;

  // --- Suggestion manager (G-17 / G-24 / per-person thresholds) -------------
  /** Tiles around a dismissed ghost's bounding box that still count as "the same structure". */
  cooldownMarginTiles: number;
  /** While the dismiss streak is maxed, a placement farther than this (tiles) from every dismissed ghost starts a new structure. */
  newStructureTiles: number;
  /** A shown ghost with no response ends with outcome "timeout" after this many ms (0 = never). */
  ghostTimeoutMs: number;
  /** After Ctrl+Space with nothing held, a suggestion arriving within this many ms shows as "requested". */
  requestWindowMs: number;
  /** Painting outside a shown ghost dismisses it ("keep drawing and it goes away"). */
  dismissOnDrawElsewhere: boolean;
  /** Per-session adaptation of showNowAbove (suggest/thresholds.ts). */
  adaptThresholds: boolean;
  /** How much one adaptation moves showNowAbove. */
  adaptStep: number;
  /** Lower bound for adapted showNowAbove. */
  adaptMin: number;
  /** Upper bound for adapted showNowAbove. */
  adaptMax: number;
  /** Outcomes of one type in a row that trigger an adaptation step. */
  adaptRun: number;

  // --- Fill loop (session.ts) ------------------------------------------------
  /**
   * Speculative fills: placements arriving within this many ms are coalesced
   * into one request (a brush drag emits one placement per cell). This only
   * avoids a call per cell; it does not cancel calls already in flight.
   */
  fillDebounceMs: number;
  /**
   * Call on the FIRST placement after a quiet spell instead of waiting out
   * fillDebounceMs. Only later placements inside the window (a drag) are
   * coalesced into one trailing call. Saves the debounce wait on every new
   * stroke; costs one extra call per drag.
   */
  fillLeadingEdge: boolean;
  /**
   * Speculative calls allowed in flight at once per filler. A new placement
   * starts a new call and leaves the older ones running (their answers are
   * reconciled when they arrive). Only when a new call would exceed this is
   * the OLDEST call aborted (fill.call superseded, error "superseded").
   */
  maxInFlight: number;
  /**
   * An answer whose request was built more than this many ms ago is dropped
   * as "stale: too old" (checked when it arrives and again before it is offered).
   */
  maxAnswerAgeMs: number;
  /**
   * Idle ms after the person's last placement before one "tidy" call looks
   * over what they drew for something to move, remove or repair (0 = off).
   * Auto calls see the window ahead of the cursor and nearly always continue
   * the stroke; tidy is the call that can only answer with a fix.
   */
  tidyIdleMs: number;
  /** Window of the tidy call, centred on the recent placements. */
  tidyCols: number;
  tidyRows: number;
}

export const DEFAULT_CONFIG: GhostConfig = {
  showNowAbove: 0.6,
  showAtPauseAbove: 0,
  pauseMs: 500,
  longPauseMs: 2500,
  callTimeoutMs: 6000,
  agentCapMs: 300,
  patrolCapMs: 1000,
  patrolIdleMs: 2000,
  sendBackIfUnderMs: 500,
  cooldownAfterDismissMs: 4000,
  maxDismissStreak: 3,
  fixGraceMs: 3000,
  fixPerProblemMs: 60000,
  windowCols: 24,
  windowRows: 12,
  recentCount: 12,
  historyCount: 5,
  model: "gemini-3.7-flash",
  filler: "llm",
  kinds: { finish: true, extend: true, fix: true },
  confidenceSource: "stated",
  proxyUrl: "http://localhost:8787",
  cooldownMarginTiles: 1,
  newStructureTiles: 6,
  ghostTimeoutMs: 30000,
  requestWindowMs: 3000,
  dismissOnDrawElsewhere: true,
  adaptThresholds: true,
  adaptStep: 0.05,
  adaptMin: 0.5,
  adaptMax: 0.95,
  adaptRun: 2,
  fillDebounceMs: 40,
  fillLeadingEdge: true,
  maxInFlight: 6,
  maxAnswerAgeMs: 8000,
  tidyIdleMs: 1200,
  tidyCols: 32,
  tidyRows: 14,
};

export const config: GhostConfig = structuredClone(DEFAULT_CONFIG);

export function applyOverrides(over: Partial<GhostConfig>): GhostConfig {
  Object.assign(config, over);
  return config;
}

export function resetConfig(): GhostConfig {
  Object.assign(config, structuredClone(DEFAULT_CONFIG));
  return config;
}

/**
 * Fixed confidence bands for reports and calibration (low / medium / high).
 * They are an analysis scale, kept apart from the live timing thresholds so
 * tuning when ghosts appear does not move the bins results are compared in.
 */
export const CONFIDENCE_BANDS = { showAtPauseAbove: 0.4, showNowAbove: 0.75 } as const;
