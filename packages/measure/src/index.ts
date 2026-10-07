/**
 * @measure — one package that turns a grid into numbers, for the brief, the
 * validator bands, the status line and the offline suite (G-22, G-26, G-31).
 *
 * Pure functions, no Phaser: safe in the editor, Web Workers, the proxy and
 * Node tests. Definitions of every number are in measures.ts; the tunables in
 * constants.ts.
 */
export * from "./constants";
export {
  type GridLike,
  type EntityLike,
  type Rect,
  type ParsedAscii,
  type AsciiSnapshotOptions,
  isSolid,
  isStanding,
  tileAt,
  headroom,
  hasSolidBelow,
  fullRect,
  clipRect,
  inRect,
  chebyshev,
  contentBounds,
  parseAscii,
  snapshotFromAscii,
  renderAscii,
  cropGrid,
  ASCII_TILES,
  ASCII_ENTITIES,
  ASCII_LEGEND,
} from "./grid";
export {
  type Surface,
  type Transition,
  type TransitionKind,
  type SurfaceGraph,
  findSurfaces,
  buildSurfaceGraph,
} from "./surfaces";
export {
  type PatternHit,
  type CoinClasses,
  classifyCoins,
  detectPatterns,
  transitionSweep,
  tagsOf,
} from "./patterns";
export {
  type MeasureOptions,
  type WindowMeasures,
  type WindowAnalysis,
  analyzeWindow,
  measureWindow,
  measureWindowFull,
  measuresOf,
  toMeasuredNumbers,
  histogram,
  linearityOf,
} from "./measures";
export {
  type LevelMeasureOptions,
  type LevelMeasures,
  type ScreenMeasures,
  type ScreenSeries,
  measureLevel,
  measureGrid,
  recentScreens,
} from "./level";
export {
  type ExpressiveFeatures,
  type ExpressiveHistogram,
  FEATURE_KEYS,
  expressiveFeatures,
  expressiveHistogram,
  levelDistance,
  pairwiseDistances,
  meanPairwiseDistance,
} from "./expressive";
export {
  type Chunk,
  type SliceOptions,
  sliceLevel,
  restCuts,
  findRests,
  type RestRun,
  measuredDistance,
  nearestChunks,
  formatChunk,
} from "./slice";
