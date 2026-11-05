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
    // Feel retune: slower run, stronger gravity, weaker full jump than legacy
    // (JUMP_HEIGHT 4.6 for a 5-tile standing gap, not the old 6.3).
    expect(player.JUMP_VELOCITY_PX).toBeCloseTo(-525.36, 0);
    expect(Math.abs(player.JUMP_VELOCITY_PX)).toBeLessThan(Math.abs(LEGACY_KNIGHT.JUMP_VELOCITY));
    expect(player.GRAVITY_PX).toBeCloseTo(LEGACY_KNIGHT.GRAVITY * 1.25, 5);
    expect(player.PLAYER_BODY_PX).toEqual({
      width: LEGACY_KNIGHT.BODY.width,
      height: LEGACY_KNIGHT.BODY.height,
    });
  });
});
