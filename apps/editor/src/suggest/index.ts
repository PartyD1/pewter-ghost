export { SuggestionManager } from "./SuggestionManager";
export type {
  AcceptInfo,
  DropReason,
  ManagerListeners,
  ManagerOptions,
  ManagerState,
  OfferOptions,
  OfferResult,
  RequestResult,
} from "./SuggestionManager";
export { SessionThresholds } from "./thresholds";
export type { ThresholdChange, ThresholdChangeReason } from "./thresholds";
export { ConfidenceTimer, JevTimer, JevTimerNotConfiguredError } from "./timers";
export type { Timer, TimerContext, TimerDecision, ShowWhen } from "./timers";
export { FakeClock, performanceClock } from "./fakeClock";
export type { Clock } from "./fakeClock";
export { asVerified, isVerified } from "./verified";
export {
  boxesOverlap,
  cellKey,
  cellSignature,
  distanceToBox,
  ghostCellMap,
  ghostCells,
  problemKey,
  relatePlacement,
  suggestionBox,
  touchedKeys,
} from "./geometry";
export type { Box, GhostCell, PlacementRelation } from "./geometry";
export { config, DEFAULT_CONFIG, applyOverrides, resetConfig } from "./config";
export type { GhostConfig } from "./config";
