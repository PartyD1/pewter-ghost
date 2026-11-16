/**
 * @chunks — the algorithm filler's toolkit (G-34).
 *
 *   import { generateValidChunk, profileFromMeasured, detectFinish } from "@chunks";
 *
 * - rng.ts: CPython-exact random.Random (seeded parity with the prototype).
 * - generator.ts: port of audit chunkgen.py (seeded, profile-parameterised).
 * - caps.ts: jump caps from @jump-tables (default) or the audit's caps.json.
 * - validate.ts: rule-checked generation (@physsim checkRules).
 * - profile.ts: style profile from measured numbers.
 * - detect.ts: local Finish detectors (repeats and open structures).
 * - compose.ts: the section composer the filler's Extend uses (wider piece
 *   grammar, pacing, echo of the person's shapes).
 */
export { PyRandom } from "./rng";
export { AUDIT_CAPS, capsFor, fullRunway, ladderGap, type Caps, type CapsTier, type LadderRung } from "./caps";
export {
  chunkMetrics,
  chunkRows,
  chunkTags,
  generateChunk,
  inside,
  isSolidAt,
  PIECE_KINDS,
  profileFor,
  THEMES,
  type ChunkMetrics,
  type Difficulty,
  type GeneratedChunk,
  type GenerateOptions,
  type Piece,
  type PieceKind,
  type StyleProfile,
  type Theme,
} from "./generator";
export {
  checkChunk,
  chunkGrid,
  chunkStart,
  generateValidChunk,
  retrySeed,
  type ValidChunk,
  type ValidChunkOptions,
} from "./validate";
export { profileFromMeasured, typicalGap, widestGapRatio, type ProfileOptions } from "./profile";
export {
  DEFAULT_TERRAIN,
  detectFinish,
  type DetectGrid,
  type DetectOptions,
  type DetectPlacement,
  type FinishPattern,
  type FinishProposal,
} from "./detect";
export { detectAnomalies, type AnomalyProposal, type AnomalyOptions } from "./anomaly";
export {
  BUILD_UP_KINDS,
  CALM_KINDS,
  CELL,
  COMPOSE_KINDS,
  HARD,
  INTENSITY,
  composeChunk,
  composedKinds,
  composedRows,
  composedTags,
  neutralStyle,
  type ComposeKind,
  type ComposeOptions,
  type ComposeStyle,
  type ComposedChunk,
  type ComposedPiece,
  type Motif,
} from "./compose";
export { mineMotifs, type MinedMotifs, type MotifGrid, type MotifOptions } from "./motifs";
export {
  levelGuessFor,
  mainTheme,
  styleFor,
  THEME_NAMES,
  LEVEL_THEMES,
  themesFromText,
  type StyleInputs,
  type LevelTheme,
  type ThemeHits,
  type ThemeName,
} from "./theme";
