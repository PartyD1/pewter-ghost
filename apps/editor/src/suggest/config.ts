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
  /** Give up on a model call after this many ms. */
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
   * into one request (a brush drag emits one placement per cell). The newest
   * request always wins; this only avoids a call per cell.
   */
  fillDebounceMs: number;
}

export const DEFAULT_CONFIG: GhostConfig = {
  showNowAbove: 0.75,
  showAtPauseAbove: 0.4,
  pauseMs: 800,
  longPauseMs: 2500,
  callTimeoutMs: 900,
  agentCapMs: 300,
  patrolCapMs: 1000,
  patrolIdleMs: 3000,
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
