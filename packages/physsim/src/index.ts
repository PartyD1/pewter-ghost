/**
 * @physsim — the physics-exact playtest agent and the rule check (G-07, G-16).
 *
 *   import { search, checkRules, AgentClient, gridFromCells } from "@physsim";
 *
 * - sim.ts: Phaser Arcade tile collision + the knight's stepMovement, and an
 *   A* search for inputs from a standing cell to a goal (cell, rect, predicate).
 * - rules.ts: jump-table reachability over standing cells (fast pre-filter).
 * - protocol.ts / worker.ts / client.ts: the Web Worker and its promise client.
 * - fixtures.ts: the audit's validation levels, for other modules' tests.
 */
export * from "./grid";
export {
  AgentSearch,
  asLevel,
  bodyCell,
  BH,
  BW,
  cloneBody,
  DEFAULT_PASSES,
  DT,
  frame,
  Level,
  replay,
  replayPath,
  search,
  spawnBody,
  T,
  THOROUGH_PASSES,
  TILE_BIAS,
  type Body,
  type Input,
  type SearchOptions,
  type SearchPass,
  type SearchResult,
} from "./sim";
export {
  checkRules,
  reachability,
  reachable,
  unreachableSurfaces,
  type ArcCheck,
  type MoveKind,
  type RuleMove,
  type RuleOptions,
  type RuleReach,
  type RuleVerdict,
} from "./rules";
export {
  AgentJob,
  AgentRunner,
  DEFAULT_CAP_MS,
  runRequest,
  validateRequest,
  type AgentCancel,
  type AgentFailure,
  type AgentMessage,
  type AgentReply,
  type AgentRequest,
  type AgentRequestType,
  type AgentResponse,
  type AgentResult,
  type AgentRuleOptions,
  type AgentRulesSummary,
} from "./protocol";
export {
  AgentClient,
  createAgentWorker,
  type AgentCallOptions,
  type AgentClientOptions,
  type AgentQuery,
  type WorkerLike,
} from "./client";
export {
  FIXTURES,
  flatLevel,
  gapLevel,
  staircaseLevel,
  tunnelLevel,
  wallLevel,
  type Fixture,
} from "./fixtures";
export { attachAgentWorker, type WorkerScopeLike } from "./worker";
