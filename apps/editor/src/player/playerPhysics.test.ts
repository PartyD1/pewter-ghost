import { describe, expect, it } from "vitest";
import {
  createMovementState,
  GRAVITY_PX,
  JUMP_VELOCITY_PX,
  MAX_RUN_SPEED_PX,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  TILE,
} from "./playerPhysics";

/**
 * Frame-by-frame simulator mirroring how Phaser Arcade integrates around
 * stepMovement(): controller runs first, then the world applies gravity
 * (semi-implicit Euler), moves the body, and resolves floor collision.
 * Floor is at y = 0; up is negative y (Phaser convention).
 */
class Sim {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  onGround = true;
  floor = true;
  minY = 0;
  jumps = 0;
  frame = 0;
  private state = createMovementState();
  private prevJump = false;
  private dt: number;

  constructor(dt: number) {
    this.dt = dt;
  }

  step(move: -1 | 0 | 1, jump: boolean) {
    const jumpJustPressed = jump && !this.prevJump;
    this.prevJump = jump;

    const r = stepMovement(
      this.state,
      { moveInput: move, jumpHeld: jump, jumpJustPressed },
      this.vx,
      this.vy,
      this.onGround,
      this.dt,
    );
    this.vx = r.velocityX;
    this.vy = r.velocityY;
    if (r.jumped) this.jumps++;

    // World step (Arcade equivalent)
    this.vy = Math.min(this.vy + GRAVITY_PX * this.dt, TERMINAL_VELOCITY_PX);
    this.x += this.vx * this.dt;
    this.y += this.vy * this.dt;
    if (this.floor && this.y >= 0 && this.vy > 0) {
      this.y = 0;
      this.vy = 0;
      this.onGround = true;
    } else {
      this.onGround = this.floor && this.y === 0 && this.vy === 0;
    }
    this.minY = Math.min(this.minY, this.y);
    this.frame++;
  }

  get apexTiles() {
    return -this.minY / TILE;
  }
  get xTiles() {
    return this.x / TILE;
  }
}

const FPS_60 = 1 / 60;
const FPS_30 = 1 / 30;
const FPS_144 = 1 / 144;
const ALL_RATES = [FPS_30, FPS_60, FPS_144];

/** Jump on frame 0 with `holdFrames` of jump held, run until landing. */
function jumpAndLand(dt: number, holdFrames: number, move: -1 | 0 | 1 = 0) {
  const sim = new Sim(dt);
  sim.step(move, true); // jump fires here
  expect(sim.jumps).toBe(1);
  let frames = 1;
  while (!sim.onGround && frames < 1000) {
    sim.step(move, frames < holdFrames);
    frames++;
  }
  expect(sim.onGround).toBe(true);
  return sim;
}

// Feel retune (2026-10-08): the old defaults with Gravity 125%, Run speed 85%
// and Jump power 90% baked in (see PLAYER_PHYSICS). Old values: -550 px/s
// impulse, 256 px/s top speed, 1500 px/s² gravity.
describe("retuned constants", () => {
  it("jump impulse matches √(2·g·h) for JUMP_HEIGHT 4.6", () => {
    expect(JUMP_VELOCITY_PX).toBeCloseTo(-525.36, 0);
  });

  it("top speed derives to 217.6 px/s (13.6 tiles/s, 85% of the old 16)", () => {
    expect(MAX_RUN_SPEED_PX).toBeCloseTo(217.6, 5);
  });

  it("gravity is 125% of the old 1500 px/s²", () => {
    expect(GRAVITY_PX).toBeCloseTo(1875, 5);
  });
});

describe("jump height", () => {
  it("full-hold apex is ~4.2 tiles at 60fps (JUMP_HEIGHT 4.6; Euler integration lands a little lower)", () => {
    const sim = jumpAndLand(FPS_60, 10_000);
    expect(sim.apexTiles).toBeGreaterThan(4.0);
    expect(sim.apexTiles).toBeLessThan(4.5);
  });

  it("full-hold apex is consistent across frame rates", () => {
    const apexes = ALL_RATES.map((dt) => jumpAndLand(dt, 10_000).apexTiles);
    for (const apex of apexes) {
      expect(apex).toBeGreaterThan(3.8);
      expect(apex).toBeLessThan(4.6);
    }
    const spread =
      (Math.max(...apexes) - Math.min(...apexes)) / Math.max(...apexes);
    // 10.1% after the retune (stronger gravity makes the Euler error a little
    // larger; it was under 10% before). Worth revisiting if jump height
    // should be exactly frame-rate independent.
    expect(spread).toBeLessThan(0.12);
  });

  it("tap jump is ~1 tile (retuned)", () => {
    const sim = jumpAndLand(FPS_60, 1);
    expect(sim.apexTiles).toBeGreaterThan(0.8);
    expect(sim.apexTiles).toBeLessThan(1.3);
  });

  it("mid release (5 frames) is ~2.3 tiles (retuned)", () => {
    const sim = jumpAndLand(FPS_60, 5);
    expect(sim.apexTiles).toBeGreaterThan(2.0);
    expect(sim.apexTiles).toBeLessThan(2.8);
  });

  it("jump-cut applies only once", () => {
    const sim = new Sim(FPS_60);
    sim.step(0, true);
    sim.step(0, true);
    sim.step(0, false); // release → cut this frame
    const cutVy = sim.vy;
    sim.step(0, false); // must NOT cut again: only gravity applies
    expect(sim.vy).toBeCloseTo(cutVy + GRAVITY_PX * FPS_60, 5);
  });
});

describe("horizontal movement", () => {
  it("needs a real runway: top speed takes ~0.8s / ~5.4 tiles, at all frame rates", () => {
    for (const dt of ALL_RATES) {
      const sim = new Sim(dt);
      let t = 0;
      while (sim.vx < MAX_RUN_SPEED_PX && t < 2) {
        sim.step(1, false);
        t += dt;
      }
      expect(sim.vx).toBe(MAX_RUN_SPEED_PX);
      expect(t).toBeGreaterThan(0.7); // not instant — run-up must matter
      expect(t).toBeLessThanOrEqual(0.9);
      expect(sim.xTiles).toBeGreaterThan(5.0);
      expect(sim.xTiles).toBeLessThan(6.6); // 30fps float edge adds one frame
    }
  });

  it("stops from top speed in ~1.3 tiles on the ground", () => {
    const sim = new Sim(FPS_60);
    sim.vx = MAX_RUN_SPEED_PX;
    while (sim.vx > 0) sim.step(0, false);
    expect(sim.xTiles).toBeGreaterThan(1.1);
    expect(sim.xTiles).toBeLessThan(1.7);
  });

  it("stopping distance is consistent across frame rates", () => {
    const distances = ALL_RATES.map((dt) => {
      const sim = new Sim(dt);
      sim.vx = MAX_RUN_SPEED_PX;
      while (sim.vx > 0) sim.step(0, false);
      return sim.xTiles;
    });
    // Absolute bound: at short distances (~1.7 tiles) Euler discretization
    // makes relative spread misleading.
    const spread = Math.max(...distances) - Math.min(...distances);
    expect(spread).toBeLessThan(0.25);
  });
});

describe("jump gap range (~2.3 tiles standing → ~7 tiles full speed)", () => {
  it("standing jump covers ~2.3 tiles at 60fps", () => {
    const sim = jumpAndLand(FPS_60, 10_000, 1);
    expect(sim.xTiles).toBeGreaterThan(2.0);
    expect(sim.xTiles).toBeLessThan(2.7);
  });

  it("full-speed jump covers ~7 tiles at 60fps", () => {
    const sim = new Sim(FPS_60);
    sim.vx = MAX_RUN_SPEED_PX;
    sim.step(1, true); // jump at top speed
    expect(sim.jumps).toBe(1);
    let frames = 1;
    while (!sim.onGround && frames < 1000) {
      sim.step(1, true);
      frames++;
    }
    expect(sim.xTiles).toBeGreaterThan(6.5);
    expect(sim.xTiles).toBeLessThan(7.6);
  });

  it("gap range stays within ~3:1 so the AI can reason about crossability (was ~2:1 before the feel retune)", () => {
    const standing = jumpAndLand(FPS_60, 10_000, 1).xTiles;
    const full = new Sim(FPS_60);
    full.vx = MAX_RUN_SPEED_PX;
    full.step(1, true);
    let frames = 1;
    while (!full.onGround && frames < 1000) {
      full.step(1, true);
      frames++;
    }
    expect(full.xTiles / standing).toBeLessThan(3.4);
  });

  it("standing jump is consistent across frame rates", () => {
    const gaps = ALL_RATES.map((dt) => jumpAndLand(dt, 10_000, 1).xTiles);
    const spread = (Math.max(...gaps) - Math.min(...gaps)) / Math.max(...gaps);
    expect(spread).toBeLessThan(0.1);
  });
});

// The MOVEMENT_CAPABILITIES cross-check that used to live here has moved to
// ./movementCapabilities.test.ts. It validated the old closed-form
// ladder against a sim that jumps exactly at the ledge -- which is the very
// model that under-reported the real maximum, since it cannot express the
// coyote-time jump the true maximum depends on. The ladder is now solver-
// derived and validated against Phaser's own collision code instead.

describe("coyote time", () => {
  function runOffLedge(fallFrames: number) {
    const sim = new Sim(FPS_60);
    for (let i = 0; i < 5; i++) sim.step(1, false); // run on ground
    sim.floor = false; // ledge ends
    sim.onGround = false;
    for (let i = 0; i < fallFrames; i++) sim.step(1, false);
    sim.step(1, true); // press jump
    return sim;
  }

  it("jump still fires ~50ms after leaving the ledge", () => {
    expect(runOffLedge(3).jumps).toBe(1);
  });

  it("jump does NOT fire ~83ms after leaving the ledge", () => {
    expect(runOffLedge(5).jumps).toBe(0);
  });

  it("cannot double-jump from one grace window", () => {
    const sim = jumpAndLand(FPS_60, 2);
    // Mid-air press during the same jump must not fire again
    const jumpsAfterLanding = sim.jumps;
    expect(jumpsAfterLanding).toBe(1);
    const sim2 = new Sim(FPS_60);
    sim2.step(0, true);
    sim2.step(0, false);
    sim2.step(0, true); // re-press while rising
    sim2.step(0, true);
    expect(sim2.jumps).toBe(1);
  });
});

describe("jump buffering", () => {
  /** Drop from 100px up; optionally press jump `pressFramesBeforeLand` early. */
  function drop(pressFramesBeforeLand: number | null) {
    // First find the landing frame without pressing.
    const probe = new Sim(FPS_60);
    probe.floor = true;
    probe.y = -100;
    probe.onGround = false;
    let landFrame = 0;
    while (!probe.onGround && landFrame < 1000) {
      probe.step(0, false);
      landFrame++;
    }
    // Re-run with a buffered press.
    const sim = new Sim(FPS_60);
    sim.y = -100;
    sim.onGround = false;
    for (let f = 0; f < landFrame + 5; f++) {
      const press =
        pressFramesBeforeLand !== null &&
        f >= landFrame - pressFramesBeforeLand;
      sim.step(0, press);
    }
    return sim;
  }

  it("press ~83ms before landing fires the jump on landing", () => {
    expect(drop(5).jumps).toBe(1);
  });

  it("press ~150ms before landing is NOT buffered", () => {
    expect(drop(9).jumps).toBe(0);
  });

  it("no press, no jump", () => {
    expect(drop(null).jumps).toBe(0);
  });
});
