/**
 * Player module (G-05): the Player Physics Fork's knight.
 *
 * This barrel re-exports the PURE modules only (no Phaser), so physsim, the
 * rule check and Web Workers can import it. The Phaser-facing controller is
 * imported directly by scenes:
 *
 *   import { PlayerController, configurePlayerSprite, WORLD_GRAVITY_Y } from "@app/player/playerController";
 *
 * Design-facing reach numbers should come from @jump-tables (precomputed
 * from this solver), not from calling the solver at runtime.
 */
export * from "./playerPhysics";
export * from "./jumpSolver";
export * from "./movementCapabilities";
export { LEGACY_KNIGHT } from "./legacyKnight";
