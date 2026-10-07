/**
 * The OLD Pewter editor's playtest knight, kept for reference only (G-05
 * risk: "tuning differences from the study's knight; keep old constants").
 *
 * Copied from the old src/phaser/editorScene.ts play-mode update loop. That
 * knight integrated per FRAME with a hard-coded 1/60, so on a 144 Hz screen
 * it accelerated 2.4x faster; it had no coyote time and no jump buffer.
 * Nothing in Pewter Ghost runs on these numbers: the knight is
 * playerPhysics.ts / playerController.ts, and every reach number comes from
 * packages/jump-tables. They exist so the study's levels can be compared
 * (e.g. the old run speed was 400 px/s = 25 tiles/s, the new one 16 tiles/s,
 * so old maximum-width gaps are often impossible now).
 */
export const LEGACY_KNIGHT = {
  /** px/s */
  PLAYER_SPEED: 400,
  /** Blend factor per second towards target speed (applied as accel/1000 per 1/60 frame). */
  ACCELERATION: 1500,
  /** px/s lost per second with no input, on the ground. */
  FRICTION: 1200,
  /** Air acceleration multiplier. */
  AIR_CONTROL: 0.8,
  /** Air friction = FRICTION * this. */
  AIR_FRICTION_FACTOR: 0.3,
  /** px/s, applied once on jump. */
  JUMP_VELOCITY: -550,
  /** Releasing jump while rising faster than this (px/s) cuts the jump. */
  JUMP_CUT_MIN_SPEED: 50,
  JUMP_CUT_MULTIPLIER: 0.4,
  /** px/s^2 */
  GRAVITY: 1500,
  /** Body size in px (same hitbox the fork kept). */
  BODY: { width: 10, height: 14, offsetX: 3, offsetY: 1 },
} as const;
