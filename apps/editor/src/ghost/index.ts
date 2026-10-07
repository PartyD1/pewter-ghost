/**
 * Ghost module public API (G-11, G-19, G-24 rendering, Extend scroll).
 *
 *   import { registerGhostStarter } from "@app/editor/api";
 *   import { startGhost } from "@app/ghost";
 *   registerGhostStarter((api) => { const g = startGhost(api, { onRequest }); return () => g.dispose(); });
 *
 * or simply `import "@app/ghost/boot"` for the default wiring.
 */
export { GhostSession, startGhost, PLAY_ROUTE_MS } from "./session";
export type { GhostSessionOptions, GhostTestHandle, GhostCurrent } from "./session";
export { GhostLayer } from "./GhostLayer";
export type { GhostLayerState, LayerEnd } from "./GhostLayer";
export { PathOverlay, routePointPx } from "./path";
export { RouteStore, simplifyRoute } from "./routes";
export type { StoredRoute } from "./routes";
export { GhostHistory } from "./history";
export { DevOverlay, devEnabled, devLines } from "./devOverlay";
export type { DevFillInfo, DevState } from "./devOverlay";
export { bindGhostInput, changedCells } from "./input";
export { ghostKeyAction, ROUTE_KEY } from "./keys";
export type { GhostKeyAction, GhostKeyContext } from "./keys";
export { GHOST_STYLE, planGhost, outlineEdges, dashSegments, fadeProgress } from "./plan";
export type { GhostPlan, Edge } from "./plan";
export { leadingBox, edgeArrow, boxInside, boxVisible } from "./extend";
export type { EdgeArrow, ViewRect } from "./extend";
export { canvasCaption, sanitizeGuess, shortLabel, stripText, TEACHING_GHOSTS } from "./caption";
export type { StripView, StripText } from "./caption";
