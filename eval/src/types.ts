/**
 * Shared types of the offline suite (G-20 and friends).
 *
 * An EvalCase is one FillRequest the suite replays. It comes either from the
 * proxy's recordings (proxy/.data/recordings/*.jsonl, contract `Recording`)
 * or from eval/data/*.jsonl (the seed set, written by fixtures/makeSeed.ts).
 * Seed cases also carry the full level and the placement stream state, so the
 * request can be rebuilt with another window size (G-28) and verified against
 * the real level; recordings carry only the window, so the suite rebuilds a
 * level from the window text (cases.ts levelFromRequest).
 */
import type {
  FillRequest,
  GhostOutcome,
  ModelAnswer,
  PlacementEvent,
  Point,
  SuggestionKind,
  VerdictStage,
} from "../../apps/editor/src/contracts";
import type { SaveFileV2 } from "../../apps/editor/src/level/save";

/** The answer the model gave when the request was recorded. */
export interface RecordedAnswer {
  answer: ModelAnswer | null;
  answers?: (ModelAnswer | null)[];
  logprob?: number;
  latencyMs: number;
  model: string;
  promptVersion: string;
  error?: string;
  temperature?: number;
  samples?: 1 | 2;
  raw?: (string | null)[];
}

/** Placement-stream state at request time (enough to rebuild the request). */
export interface StreamState {
  /** Events the stream held (oldest first), level coordinates. */
  placements: PlacementEvent[];
  /** Session clock reading when the request was built. */
  now: number;
  /** recentCount the stream was built with. */
  recentCount: number;
}

/** Patrol context of a seed case (verify/patrol PatrolBlocked, level coordinates). */
export interface BlockedInfo {
  blockedAt: Point;
  reason: string;
  from: Point;
  goalX: number;
}

/** What a good answer looks like for a seed case (scored as "expectation met"). */
export interface CaseExpectation {
  /** The model should act (true) or decline (false). Undefined = either. */
  act?: boolean;
  /** Acceptable kinds when acting. */
  kinds?: SuggestionKind[];
  /** Why (shown in reports). */
  note?: string;
}

export interface EvalCase {
  /** Stable id: seed name, or `<sessionId>#<index>` for recordings. */
  id: string;
  source: "seed" | "recording";
  /** Session the case belongs to (variety is scored per session). */
  sessionId: string;
  /** Position within the session (0-based, time order). */
  seq: number;
  /** ISO time of the recording (recordings only). */
  t?: string;
  /** Fixture family (seed only), e.g. "staircase". */
  family?: string;
  /** Free tags for slicing reports. */
  tags?: string[];
  request: FillRequest;
  /** requestHash of `request` (sha256 of canonical JSON). */
  requestHash: string;
  /** Full level at request time (save-file v2 layout, compact). Seed cases only. */
  level?: SaveFileV2;
  stream?: StreamState;
  /** The model's last level-type guess fed to the brief (seed only). */
  lastGuess?: string;
  blocked?: BlockedInfo;
  recorded?: RecordedAnswer;
  expect?: CaseExpectation;
  /** Outcome from the logs when joined (dashboard, calibration, export). */
  outcome?: GhostOutcome;
}

/** Confidence source (G-27). */
export type ConfidenceSource = "stated" | "logprob" | "twoSample";

/** One configuration of the suite. */
export interface RunConfig {
  /** Short name used in reports and the cache key. */
  name: string;
  /**
   * Model id for the live runner, or "recorded" to score the answers stored
   * with each case (no API call).
   */
  model: string;
  /** Window size; undefined = as recorded. */
  window?: { cols: number; rows: number };
  /** Include the one-line summary of the level outside the window (default: as recorded). */
  summary?: boolean;
  /** Add reference examples (G-31) to the brief when rebuilding (default false). */
  examples?: boolean;
  /** Render the user message compactly (fill/prompt renderUserMessage { compact }). */
  compactUser?: boolean;
  /** Replace the system prompt (A/B a prompt draft). */
  systemOverride?: { text: string; version: string };
  confidenceSource: ConfidenceSource;
  /** 1 or 2 samples per call; twoSample forces 2. */
  samples: 1 | 2;
  temperature: number;
  /** Gemini thinkingBudget (0 = off; null = model default). */
  thinkingBudget: number | null;
  /** Send-back on a failed first answer: "always" (score the second try), "budget" (only if faster than sendBackIfUnderMs, as the app does) or "never". */
  sendBack: "always" | "budget" | "never";
  /** Agent cap per verification, ms. */
  agentCapMs: number;
  /** Client call budget, ms (answers slower than this count as dropped). */
  callTimeoutMs: number;
}

/** What one model call produced (live, cached or recorded). */
export interface CallResult {
  /** Raw text per sample (null when a sample failed). */
  texts: (string | null)[];
  /** Parsed answers, already decoded from JSON objects (recorded answers) when no text exists. */
  parsed?: (ModelAnswer | null)[];
  logprob?: number;
  latencyMs: number;
  model: string;
  promptVersion: string;
  error?: string;
  /** Served from the eval cache. */
  cached?: boolean;
  usage?: { promptTokens?: number; outputTokens?: number };
}

/** Per-case scores. */
export interface CaseResult {
  id: string;
  sessionId: string;
  seq: number;
  family?: string;
  mode: FillRequest["mode"];
  requestHash: string;
  /** Case skipped (e.g. cannot rebuild for the window size). */
  skipped?: string;
  /** Call failed. */
  error?: string;
  latencyMs: number;
  cached?: boolean;
  promptTokens?: number;
  outputTokens?: number;
  /** Every sample parsed against the schema. */
  schemaOk: boolean;
  schemaError?: string;
  act: boolean | null;
  kind?: SuggestionKind;
  label?: string;
  levelGuess?: string;
  /** Items in the answer (adds + removes + entities). */
  cells: number;
  /** Items the converter dropped (outside window, duplicates, ...). */
  dropped: number;
  coord?: import("./score/coords").CoordScore;
  /** Validator stage on the first answer ("ok" when passed). */
  validatorStage?: VerdictStage | "ok";
  /** First answer passed validator + rules + agent. */
  firstTryOk?: boolean;
  firstStage?: VerdictStage | "ok";
  firstReason?: string;
  agentTimedOut?: boolean;
  sendBack?: boolean;
  sendBackOk?: boolean;
  /** Pattern tags of the first answer (@measure via the validator). */
  tags?: string[];
  confidence?: { stated?: number; logprob?: number; twoSample?: number; used?: number };
  expectMet?: boolean;
  /** The first answer (for export and the dashboard). */
  answer?: ModelAnswer | null;
  /** lastGhosts of the request (for the variety history check). */
  history?: import("../../apps/editor/src/contracts").GhostHistoryItem[];
}

export interface RunResult {
  config: RunConfig;
  promptVersion: string;
  startedAt: string;
  finishedAt: string;
  cases: CaseResult[];
  summary: import("./report").Summary;
}
