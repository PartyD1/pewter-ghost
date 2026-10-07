/**
 * Pewter Ghost — shared contracts.
 *
 * Every module builds against these shapes. Change them only with a note in
 * docs/decisions.md (see "Definition of Done" in the build plan).
 *
 * Changelog
 *  - v1 (week 1): initial shapes from the build plan §7.
 *
 * Coordinate convention everywhere: x grows right, y grows DOWN, both in tiles,
 * origin at the level's top-left. A level is LEVEL_W x LEVEL_H tiles of TILE_PX.
 */

export const LEVEL_W = 200;
export const LEVEL_H = 20;
export const TILE_PX = 16;

// ---------------------------------------------------------------------------
// Tiles and entities
// ---------------------------------------------------------------------------

/**
 * Solid/terrain tile ids. These keep the old Pewter tileset indices so saved
 * v1 levels map directly. 0 means empty. Collectables and enemies are NOT
 * tiles any more; they are entities.
 */
export const TILE = {
  EMPTY: 0,
  BLOCK: 1, // "Block 1"
  GRASS_HALF: 4, // "Grass-Half Block" (one-way / half height in old Pewter; solid here)
  DIRT: 5,
  GRASS: 6,
  QUESTION: 7,
} as const;
export type TileId = (typeof TILE)[keyof typeof TILE];

export const SOLID_TILES: ReadonlySet<number> = new Set([
  TILE.BLOCK,
  TILE.GRASS_HALF,
  TILE.DIRT,
  TILE.GRASS,
  TILE.QUESTION,
]);

/** Names used in model I/O and the ASCII window legend. */
export type TileName = "block" | "grass_half" | "dirt" | "grass" | "question";
export const TILE_BY_NAME: Record<TileName, TileId> = {
  block: TILE.BLOCK,
  grass_half: TILE.GRASS_HALF,
  dirt: TILE.DIRT,
  grass: TILE.GRASS,
  question: TILE.QUESTION,
};
export const NAME_BY_TILE: Record<number, TileName> = {
  [TILE.BLOCK]: "block",
  [TILE.GRASS_HALF]: "grass_half",
  [TILE.DIRT]: "dirt",
  [TILE.GRASS]: "grass",
  [TILE.QUESTION]: "question",
};

export type EntityKind =
  | "coin"
  | "fruit"
  | "slime"
  | "ultraslime"
  | "flag"
  | "sign";

export const COLLECTABLE_KINDS: ReadonlySet<EntityKind> = new Set(["coin", "fruit"]);
export const ENEMY_KINDS: ReadonlySet<EntityKind> = new Set(["slime", "ultraslime"]);

export interface Entity {
  id: string;
  kind: EntityKind;
  x: number;
  y: number;
  /** Enemies only: inclusive patrol range in tiles, computed from the floor. */
  patrol?: [number, number];
  /** Signs only. */
  text?: string;
}

export type Point = { x: number; y: number };

// ---------------------------------------------------------------------------
// Authorship
// ---------------------------------------------------------------------------

export const AUTHOR = { NONE: 0, PERSON: 1, GHOST: 2 } as const;
export type Author = (typeof AUTHOR)[keyof typeof AUTHOR];

// ---------------------------------------------------------------------------
// Level (serialisable snapshot; the live model is level/LevelModel.ts)
// ---------------------------------------------------------------------------

export interface LevelSnapshot {
  w: number;
  h: number;
  /** Row-major, length w*h, TileId per cell. */
  cells: number[];
  /** Row-major, length w*h, Author per cell. */
  authors: number[];
  /** cell index -> suggestion id that placed it (accepted ghost cells only). */
  provenance: Record<number, string>;
  entities: Entity[];
  /** Entity id -> author. */
  entityAuthors: Record<string, Author>;
  start: Point;
  goal?: Point;
}

export const cellIndex = (x: number, y: number, w = LEVEL_W) => y * w + x;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface PlacementEvent {
  /** ms since session start (performance.now() based). */
  t: number;
  x: number;
  y: number;
  /** TileId for terrain, or `entity:<kind>` for entities, or 0 for erase. */
  tile: number | `entity:${EntityKind}`;
  author: Author;
  stroke: string;
  tool: "paint" | "erase";
}

/** Emitted by LevelModel after every command (do or undo). */
export interface LevelChange {
  cells: { x: number; y: number; tile: number; author: Author }[];
  entitiesAdded: Entity[];
  entitiesRemoved: string[];
  source: "person" | "ghost" | "undo" | "redo" | "load";
}

// ---------------------------------------------------------------------------
// The autofill call
// ---------------------------------------------------------------------------

export type SuggestionKind = "finish" | "extend" | "fix";
export type FillMode = "auto" | "requested" | "patrol";

export interface KnightLimits {
  /** Widest gap (empty tiles between surfaces) clearable from standing. */
  maxGapStand: number;
  /** Widest gap clearable with a full run-up. */
  maxGapRun: number;
  /** Highest rise (tiles) reachable from flat ground. */
  maxRise: number;
}

export interface MeasuredNumbers {
  density: number;
  /** Gap widths as fractions of maxGapRun, histogram of 5 bins [0..0.2..1.0+]. */
  gapHist: number[];
  verticality: number;
  /** Mean tiles between collectables along the route; 0 if none. */
  rewardSpacing: number;
  /** Enemies within 3 tiles of a landing / landings. */
  pressure: number;
  difficulty?: number;
  patterns?: string[];
}

export interface RecentPlacement {
  /** ms since previous placement. */
  dt: number;
  x: number;
  y: number;
  tile: string;
  tool: "paint" | "erase";
}

export interface GhostHistoryItem {
  kind: SuggestionKind;
  label: string;
  outcome: GhostOutcome;
  patterns?: string[];
}

export interface FillRequest {
  /** ASCII window with rulers and legend (see fill/window.ts). */
  grid: string;
  /** Window top-left in level coordinates. */
  origin: Point;
  /** Window size in tiles. */
  size: { w: number; h: number };
  recent: RecentPlacement[];
  frontier: { x: number; y: number; idleMs: number };
  knight: KnightLimits;
  measured: MeasuredNumbers;
  /** Design brief text (fill/brief.ts), versioned. */
  brief: string;
  briefVersion: string;
  lastGhosts: GhostHistoryItem[];
  mode: FillMode;
  /** Present on send-back after a failed verification. */
  previousFailure?: { reason: string; stage: VerdictStage };
  /** Present for patrol: where the agent got stuck, window-relative. */
  blockedAt?: Point;
  /** Short one-line summary of the level outside the window. */
  summary?: string;
}

/** What the model returns (window-relative coordinates, names not ids). */
export interface ModelAnswer {
  act: boolean;
  kind: SuggestionKind;
  adds: { x: number; y: number; tile: TileName }[];
  removes: { x: number; y: number }[];
  entities: { kind: EntityKind; x: number; y: number }[];
  confidence: number;
  label: string;
  /** The model's guess at what the level is trying to be, e.g. "parkour". */
  levelGuess?: string;
}

/** Suggestion in LEVEL coordinates, after parsing and conversion. */
export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  adds: { x: number; y: number; tile: TileId }[];
  removes: Point[];
  entities: { kind: EntityKind; x: number; y: number }[];
  confidence: number;
  label: string;
  levelGuess?: string;
  /** Anchor for camera/caption: first add, or the fix point. */
  anchor: Point;
  requestHash: string;
  filler: FillerName;
  latencyMs: number;
  mode: FillMode;
  /** Set by the verifier. */
  verified: boolean;
  path?: Point[];
  /** Number of model attempts (1, or 2 after a send-back). */
  attempts: number;
}

/** A suggestion that has passed validation and playability. The manager accepts only these. */
export type VerifiedSuggestion = Suggestion & { verified: true; __verified: true };

export type FillerName = "llm" | "algo" | "stub" | "jev";

export interface Filler {
  readonly name: FillerName;
  /**
   * Return a suggestion (level coordinates, unverified) or null for "nothing
   * worth suggesting". Must honour the abort signal.
   */
  fill(request: FillRequest, signal?: AbortSignal): Promise<Suggestion | null>;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerdictStage = "shape" | "measure" | "repeat" | "rules" | "agent";

export interface Verdict {
  ok: boolean;
  stage: VerdictStage;
  /** Written for the model to read on send-back. */
  reason?: string;
  path?: Point[];
  ms: number;
}

// ---------------------------------------------------------------------------
// Ghost lifecycle
// ---------------------------------------------------------------------------

export type ShownBecause = "now" | "pause" | "longPause" | "requested" | "patrol";

export type GhostOutcome =
  | "accepted"
  | "partial"
  | "esc"
  | "drawn-over"
  | "replaced"
  | "timeout"
  | "pending";

// ---------------------------------------------------------------------------
// Log events (research/log.ts)
// ---------------------------------------------------------------------------

export type LogEvent =
  | {
      type: "session";
      t: number;
      sessionId: string;
      commit: string;
      promptVersion: string;
      briefVersion: string;
      model: string;
      filler: FillerName | "none";
      config: Record<string, unknown>;
    }
  | ({ type: "place" | "erase" } & PlacementEvent)
  | {
      type: "fill.call";
      t: number;
      requestHash: string;
      mode: FillMode;
      superseded: boolean;
      latencyMs: number;
      act: boolean | null;
      kind?: SuggestionKind;
      confidence?: number;
      tiles?: number;
      verdictStage?: VerdictStage | "ok";
      reason?: string;
      sendBack?: boolean;
      error?: string;
    }
  | {
      type: "ghost.show";
      t: number;
      suggestionId: string;
      kind: SuggestionKind;
      confidence: number;
      shownBecause: ShownBecause;
      cells: number;
      label: string;
    }
  | {
      type: "ghost.end";
      t: number;
      suggestionId: string;
      outcome: GhostOutcome;
      dwellMs: number;
      acceptedCells?: number;
    }
  | { type: "patrol"; t: number; beatable: boolean; blockedAt?: Point; ms: number }
  | { type: "play.start"; t: number }
  | { type: "play.end"; t: number; reachedGoal: boolean; deaths: number }
  | { type: "undo" | "redo"; t: number; what: "own" | "ghost" | "mixed" }
  | { type: "save"; t: number; snapshotId: string };

// ---------------------------------------------------------------------------
// Prompt rendering (owned by fill/prompt.ts; used by the proxy and eval)
// ---------------------------------------------------------------------------

/**
 * `apps/editor/src/fill/prompt.ts` must export:
 *   PROMPT_VERSION: string
 *   renderFillPrompt(req: FillRequest): RenderedPrompt
 *   parseModelAnswer(raw: unknown): ModelAnswer | null   // strict validation, null on garbage
 */
export interface RenderedPrompt {
  system: string;
  user: string;
  /** JSON schema for the model's structured output (Gemini responseSchema subset). */
  responseSchema: Record<string, unknown>;
  promptVersion: string;
}

// ---------------------------------------------------------------------------
// Proxy HTTP API (proxy/src)
// ---------------------------------------------------------------------------

/** POST /fill  (Authorization: Bearer <session token>) */
export interface ProxyFillBody {
  sessionId: string;
  request: FillRequest;
  /** 2 = two samples for twoSample confidence or variety. Default 1. */
  samples?: 1 | 2;
  temperature?: number;
}

export interface ProxyFillResponse {
  /** First (or only) parsed answer; null when the model declined or output was unusable. */
  answer: ModelAnswer | null;
  /** All parsed answers when samples = 2. */
  answers?: (ModelAnswer | null)[];
  /** Mean token log-probability of the answer when the upstream exposes it. */
  logprob?: number;
  latencyMs: number;
  model: string;
  promptVersion: string;
  requestHash: string;
  error?: string;
}

/** POST /log */
export interface ProxyLogBody {
  sessionId: string;
  events: LogEvent[];
}

/** GET /session?token=...  -> per-token condition and config overrides */
export interface ProxySessionResponse {
  sessionId: string;
  condition: "llm" | "algo" | "none" | "stub";
  overrides: Record<string, unknown>;
}

/** One line of proxy/.data/recordings/<sessionId>.jsonl — what the offline suite replays. */
export interface Recording {
  t: string; // ISO time
  sessionId: string;
  requestHash: string;
  request: FillRequest;
  answer: ModelAnswer | null;
  answers?: (ModelAnswer | null)[];
  logprob?: number;
  latencyMs: number;
  model: string;
  promptVersion: string;
  error?: string;
  /** Sampling temperature sent upstream (added by proxy, G-09). */
  temperature?: number;
  /** Sample count requested (added by proxy, G-09). */
  samples?: 1 | 2;
  /** Raw model text per sample, kept only when a sample failed to parse (added by proxy, G-09). */
  raw?: (string | null)[];
}
