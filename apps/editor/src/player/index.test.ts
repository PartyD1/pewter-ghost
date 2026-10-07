import { describe, expect, it } from "vitest";
import * as player from "./index";
import { LEGACY_KNIGHT } from "./legacyKnight";

describe("player barrel", () => {
  it("exposes the pure physics, solver and capabilities without Phaser", () => {
    expect(typeof player.stepMovement).toBe("function");
    expect(typeof player.solveJump).toBe("function");
    expect(typeof player.movementFacts).toBe("function");
    expect(player.TILE).toBe(16);
    expect("PlayerController" in player).toBe(false);
  });

  it("keeps the legacy knight for comparison, and the new knight is slower", () => {
    expect(LEGACY_KNIGHT.PLAYER_SPEED).toBe(400);
    expect(player.MAX_RUN_SPEED_PX).toBeLessThan(LEGACY_KNIGHT.PLAYER_SPEED);
    // Same jump impulse and gravity: the fork derives -550 px/s from 6.3 tiles.
    expect(player.JUMP_VELOCITY_PX).toBeCloseTo(LEGACY_KNIGHT.JUMP_VELOCITY, 0);
    expect(player.GRAVITY_PX).toBe(LEGACY_KNIGHT.GRAVITY);
    expect(player.PLAYER_BODY_PX).toEqual({
      width: LEGACY_KNIGHT.BODY.width,
      height: LEGACY_KNIGHT.BODY.height,
    });
  });
});
