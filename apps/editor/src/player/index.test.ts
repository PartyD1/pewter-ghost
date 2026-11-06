import { describe, expect, it } from "vitest";
import * as player from "./index";

describe("player barrel", () => {
  it("exposes the pure physics, solver and capabilities without Phaser", () => {
    expect(typeof player.stepMovement).toBe("function");
    expect(typeof player.solveJump).toBe("function");
    expect(typeof player.movementFacts).toBe("function");
    expect(player.TILE).toBe(16);
    expect("PlayerController" in player).toBe(false);
  });

  it("pins the knight's feel constants", () => {
    // Slower run, stronger gravity, weaker full jump than the original Pewter
    // knight (JUMP_HEIGHT 4.6 for a 5-tile standing gap).
    expect(player.MAX_RUN_SPEED_PX).toBeLessThan(400);
    expect(player.JUMP_VELOCITY_PX).toBeCloseTo(-525.36, 0);
    expect(player.GRAVITY_PX).toBeCloseTo(1500 * 1.25, 5);
    expect(player.PLAYER_BODY_PX).toEqual({ width: 10, height: 14 });
  });
});
