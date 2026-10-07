/**
 * PlayerController wiring: reads keys, feeds stepMovement, writes the body,
 * fires hooks. Phaser itself is mocked (the controller only uses its types);
 * the physics math is covered by playerPhysics.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("phaser", () => ({ default: {} }));

import {
  configurePlayerSprite,
  PlayerController,
  WORLD_GRAVITY_Y,
} from "./playerController";
import {
  GRAVITY_PX,
  JUMP_VELOCITY_PX,
  MAX_RUN_SPEED_PX,
  MAX_STEP_DT,
  GROUND_ACCEL_PX,
  TERMINAL_VELOCITY_PX,
} from "./playerPhysics";

type Key = { isDown: boolean };

function makeRig() {
  const keys = {
    left: { isDown: false } as Key,
    right: { isDown: false } as Key,
    up: { isDown: false } as Key,
    down: { isDown: false } as Key,
    W: { isDown: false } as Key,
    A: { isDown: false } as Key,
    S: { isDown: false } as Key,
    D: { isDown: false } as Key,
  };
  const scene = {
    input: {
      keyboard: {
        createCursorKeys: () => ({
          left: keys.left,
          right: keys.right,
          up: keys.up,
          down: keys.down,
        }),
        addKeys: () => ({ W: keys.W, A: keys.A, S: keys.S, D: keys.D }),
      },
    },
  };
  const calls: string[] = [];
  const player = {
    body: { velocity: { x: 0, y: 0 }, blocked: { down: true } },
    flipX: false,
    isFalling: undefined as boolean | undefined,
    setVelocity(x: number, y: number) {
      this.body.velocity.x = x;
      this.body.velocity.y = y;
      return this;
    },
    setFlipX(v: boolean) {
      this.flipX = v;
      return this;
    },
    setScale(s: number) {
      calls.push(`scale:${s}`);
      return this;
    },
    setSize(w: number, h: number) {
      calls.push(`size:${w}x${h}`);
      return this;
    },
    setOffset(x: number, y: number) {
      calls.push(`offset:${x},${y}`);
      return this;
    },
    setCollideWorldBounds(v: boolean) {
      calls.push(`bounds:${v}`);
      return this;
    },
    setDrag(x: number, y: number) {
      calls.push(`drag:${x},${y}`);
      return this;
    },
    setMaxVelocity(x: number, y: number) {
      calls.push(`max:${x},${y}`);
      return this;
    },
  };
  const hooks = { onJump: vi.fn(), onWalk: vi.fn(), onStopWalking: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrl = new PlayerController(scene as any, player as any, hooks);
  return { keys, player, hooks, ctrl, calls };
}

describe("configurePlayerSprite", () => {
  it("applies the shared 10x14 body, scale 1 and engine caps", () => {
    const { player, calls } = makeRig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configurePlayerSprite(player as any);
    expect(calls).toEqual([
      "scale:1",
      "size:10x14",
      "offset:3,1",
      "bounds:false",
      "drag:0,0",
      `max:${MAX_RUN_SPEED_PX},${TERMINAL_VELOCITY_PX}`,
    ]);
    expect(WORLD_GRAVITY_Y).toBe(GRAVITY_PX);
  });
});

describe("PlayerController.update", () => {
  it("accelerates right with D or the right arrow and faces the way it moves", () => {
    const { keys, player, ctrl, hooks } = makeRig();
    keys.D.isDown = true;
    ctrl.update(1000 / 60);
    expect(player.body.velocity.x).toBeCloseTo(GROUND_ACCEL_PX / 60, 6);
    expect(player.flipX).toBe(false);
    expect(hooks.onWalk).toHaveBeenCalledTimes(1);
    keys.D.isDown = false;
    keys.left.isDown = true;
    ctrl.update(1000 / 60);
    expect(player.flipX).toBe(true);
  });

  it("left wins when both directions are held", () => {
    const { keys, player, ctrl } = makeRig();
    keys.A.isDown = true;
    keys.right.isDown = true;
    ctrl.update(1000 / 60);
    expect(player.body.velocity.x).toBeLessThan(0);
  });

  it("jumps once per press on the ground and fires onJump", () => {
    const { keys, player, ctrl, hooks } = makeRig();
    keys.W.isDown = true;
    ctrl.update(1000 / 60);
    expect(player.body.velocity.y).toBe(JUMP_VELOCITY_PX);
    expect(hooks.onJump).toHaveBeenCalledTimes(1);
    expect(player.isFalling).toBe(false);
    // Holding the key on the ground again does not re-trigger.
    player.body.velocity.y = 0;
    ctrl.update(1000 / 60);
    expect(hooks.onJump).toHaveBeenCalledTimes(1);
  });

  it("buffers a press made just before landing", () => {
    const { keys, player, ctrl, hooks } = makeRig();
    player.body.blocked.down = false;
    player.body.velocity.y = 200;
    // Burn coyote time first.
    for (let i = 0; i < 10; i++) ctrl.update(1000 / 60);
    keys.up.isDown = true;
    ctrl.update(1000 / 60); // pressed in the air: buffered
    expect(hooks.onJump).not.toHaveBeenCalled();
    expect(player.isFalling).toBe(true);
    player.body.blocked.down = true;
    ctrl.update(1000 / 60); // lands within the buffer window
    expect(hooks.onJump).toHaveBeenCalledTimes(1);
    expect(player.body.velocity.y).toBe(JUMP_VELOCITY_PX);
  });

  it("clamps long frames to MAX_STEP_DT", () => {
    const { keys, player, ctrl } = makeRig();
    keys.D.isDown = true;
    ctrl.update(1000); // a 1 s hitch
    expect(player.body.velocity.x).toBeCloseTo(
      GROUND_ACCEL_PX * MAX_STEP_DT,
      6,
    );
  });

  it("reset zeroes velocity and clears timers and latches", () => {
    const { keys, player, ctrl, hooks } = makeRig();
    keys.W.isDown = true;
    ctrl.update(1000 / 60);
    ctrl.reset();
    expect(player.body.velocity).toEqual({ x: 0, y: 0 });
    // Still holding W after reset counts as a fresh press.
    ctrl.update(1000 / 60);
    expect(hooks.onJump).toHaveBeenCalledTimes(2);
  });
});
