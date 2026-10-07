/**
 * Arc tracer tests, including a replay of EVERY exported arc through
 * Phaser's real tile separation (the same harness idea as
 * apps/editor/src/player/jumpSolverEngine.test.ts): the knight must land on
 * the target and touch every coin the table puts on its arc (G-26: "every
 * arc coin reachable").
 */
import { describe, expect, it } from "vitest";
import SeparateTile from "phaser/src/physics/arcade/tilemap/SeparateTile.js";
import { maxGapAtRate } from "../../../apps/editor/src/player/jumpSolver";
import {
  createMovementState,
  GRAVITY_PX,
  PLAYER_BODY_PX,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  TILE,
} from "../../../apps/editor/src/player/playerPhysics";
import {
  ARC_RENDER_DT,
  arcInputGrid,
  arcJumpFrame,
  landingsFor,
  seatsOnEdgeTile,
  traceArcs,
  traceFlight,
  type ArcInput,
} from "./arcs";
import { arcCoins, arcFor, TABLES } from "./index";

describe("traceFlight", () => {
  it("is deterministic", () => {
    const input: ArcInput = {
      runwayTiles: 3,
      jumpOffsetFrames: 0,
      airHoldFrames: null,
    };
    expect(traceFlight(input, 4)).toEqual(traceFlight(input, 4));
  });

  it("rejects a press after coyote time and a hop back onto the ledge", () => {
    expect(
      traceFlight(
        { runwayTiles: 2, jumpOffsetFrames: 30, airHoldFrames: null },
        4,
      ),
    ).toBeNull();
    // Jump from a standstill far from the edge with no air input: lands back on the ledge.
    expect(
      traceFlight(
        { runwayTiles: 7, jumpOffsetFrames: -40, airHoldFrames: 0 },
        4,
      ),
    ).toBeNull();
  });

  it("full-hold jumps never beat the solver's 60 Hz maximum", () => {
    for (const runwayTiles of [0, 2, 7]) {
      for (const dy of [-4, 0, 5]) {
        const bound = maxGapAtRate({ runwayTiles, deltaYTiles: -dy }, 1 / 60);
        for (let off = -3; off <= 4; off++) {
          const fl = traceFlight(
            { runwayTiles, jumpOffsetFrames: off, airHoldFrames: null },
            8,
          );
          if (!fl) continue;
          for (const g of landingsFor(fl, dy, 30).keys()) {
            expect(
              g,
              `runway ${runwayTiles} dy ${dy} off ${off}`,
            ).toBeLessThanOrEqual(bound + 1e-9);
          }
        }
      }
    }
  });

  it("releasing right shortens the jump", () => {
    const hold = traceFlight(
      { runwayTiles: 2, jumpOffsetFrames: 0, airHoldFrames: null },
      2,
    )!;
    const hop = traceFlight(
      { runwayTiles: 2, jumpOffsetFrames: 0, airHoldFrames: 0 },
      2,
    )!;
    const far = (f: typeof hold) => Math.max(...landingsFor(f, 0, 30).keys());
    expect(far(hop)).toBeLessThan(far(hold));
  });
});

describe("traceArcs", () => {
  it("only returns requested gaps and picks the cheapest natural input", () => {
    const arcs = traceArcs([0], () => 3, 7);
    expect(arcs.map((a) => a.gap)).toEqual([1, 2, 3]);
    for (const a of arcs) {
      expect(a.dy).toBe(0);
      expect(a.coins).toHaveLength(a.gap);
      expect(a.overshootPx).toBeGreaterThan(0);
    }
  });

  it("matches the checked-in table for the same request", () => {
    const fresh = traceArcs(
      [0, -2],
      (dy) => (dy === 0 ? 5 : 4),
      TABLES.runways[TABLES.runways.length - 1],
    );
    for (const a of fresh) {
      const e = arcFor(a.gap, a.dy)!;
      expect(e.cells).toEqual(a.cells.flat());
      expect(e.coins).toEqual(a.coins.flat());
      expect(e.input).toEqual(a.input);
    }
  });

  it("input grid covers standing jumps and coyote frames", () => {
    const grid = arcInputGrid(7);
    expect(
      grid.some((i) => i.runwayTiles === 0 && i.jumpOffsetFrames === -16),
    ).toBe(true);
    expect(grid.some((i) => i.jumpOffsetFrames === 4)).toBe(true);
    expect(
      grid.some((i) => i.runwayTiles === 7 && i.airHoldFrames === null),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine replay
// ---------------------------------------------------------------------------

const TILE_BIAS = 16;
const BODY_W = PLAYER_BODY_PX.width;
const BODY_H = PLAYER_BODY_PX.height;

/** Minimal Arcade Body stand-in exposing every field SeparateTile touches. */
class FakeBody {
  position: { x: number; y: number };
  prev: { x: number; y: number };
  width = BODY_W;
  height = BODY_H;
  velocity = { x: 0, y: 0 };
  bounce = { x: 0, y: 0 };
  blocked = { none: true, up: false, down: false, left: false, right: false };
  checkCollision = {
    none: false,
    up: true,
    down: true,
    left: true,
    right: true,
  };
  customSeparateX = false;
  customSeparateY = false;
  overlapX = 0;
  overlapY = 0;
  constructor(x: number, y: number) {
    this.position = { x, y };
    this.prev = { x, y };
  }
  get x() {
    return this.position.x;
  }
  get y() {
    return this.position.y;
  }
  get right() {
    return this.position.x + this.width;
  }
  get bottom() {
    return this.position.y + this.height;
  }
  deltaX() {
    return this.position.x - this.prev.x;
  }
  deltaY() {
    return this.position.y - this.prev.y;
  }
  deltaAbsX() {
    return Math.abs(this.deltaX());
  }
  deltaAbsY() {
    return Math.abs(this.deltaY());
  }
  updateCenter() {}
}

interface FakeTile {
  col: number;
  row: number;
  faceLeft: boolean;
  faceRight: boolean;
  faceTop: boolean;
  faceBottom: boolean;
  collideLeft: boolean;
  collideRight: boolean;
  collideUp: boolean;
  collideDown: boolean;
}

/** Takeoff ledge (right face x = 0, top y = 0) and target (left face x = gap*16, top dy*16). */
function buildWorld(runwayTiles: number, gap: number, dy: number): FakeTile[] {
  const solid = new Set<string>();
  const DEPTH = 3;
  for (let c = -(Math.ceil(runwayTiles) + 3); c <= -1; c++) {
    for (let r = 0; r < DEPTH; r++) solid.add(`${c},${r}`);
  }
  for (let c = gap; c <= gap + 6; c++) {
    for (let r = dy; r < dy + DEPTH; r++) solid.add(`${c},${r}`);
  }
  const tiles: FakeTile[] = [];
  for (const key of solid) {
    const [c, r] = key.split(",").map(Number);
    tiles.push({
      col: c,
      row: r,
      faceLeft: !solid.has(`${c - 1},${r}`),
      faceRight: !solid.has(`${c + 1},${r}`),
      faceTop: !solid.has(`${c},${r - 1}`),
      faceBottom: !solid.has(`${c},${r + 1}`),
      collideLeft: true,
      collideRight: true,
      collideUp: true,
      collideDown: true,
    });
  }
  return tiles;
}

interface Replay {
  landedOnTarget: boolean;
  /** Body box per physics step from the start of the run, px, solver frame. */
  boxes: { left: number; top: number }[];
}

function replay(input: ArcInput, gap: number, dy: number): Replay {
  const tiles = buildWorld(input.runwayTiles, gap, dy);
  const body = new FakeBody(-(input.runwayTiles * TILE + BODY_W), -BODY_H);
  const state = createMovementState();
  const jumpFrame = arcJumpFrame(input);
  const targetTop = dy * TILE;
  const targetLeft = gap * TILE;
  const PHYSICS_DT = 1 / 60;
  let acc = 0;
  let prevJump = false;
  let onGround = true;
  let jumpedAt = -1;
  const boxes: Replay["boxes"] = [];

  for (let f = 0; f < 600; f++) {
    const held = f >= jumpFrame;
    const jjp = held && !prevJump;
    prevJump = held;
    const moveInput: 0 | 1 =
      jumpedAt >= 0 &&
      input.airHoldFrames !== null &&
      f - jumpedAt > input.airHoldFrames
        ? 0
        : 1;
    const r = stepMovement(
      state,
      { moveInput, jumpHeld: held, jumpJustPressed: jjp },
      body.velocity.x,
      body.velocity.y,
      onGround,
      ARC_RENDER_DT,
    );
    if (r.jumped) jumpedAt = f;
    body.velocity.x = r.velocityX;
    body.velocity.y = r.velocityY;

    acc += ARC_RENDER_DT;
    while (acc >= PHYSICS_DT - 1e-9) {
      acc -= PHYSICS_DT;
      body.velocity.y = Math.min(
        body.velocity.y + GRAVITY_PX * PHYSICS_DT,
        TERMINAL_VELOCITY_PX,
      );
      body.prev = { x: body.position.x, y: body.position.y };
      body.position.x += body.velocity.x * PHYSICS_DT;
      body.position.y += body.velocity.y * PHYSICS_DT;
      body.blocked = {
        none: true,
        up: false,
        down: false,
        left: false,
        right: false,
      };
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const rect = {
          left: t.col * TILE,
          top: t.row * TILE,
          right: (t.col + 1) * TILE,
          bottom: (t.row + 1) * TILE,
        };
        const hit = !(
          body.right <= rect.left ||
          body.bottom <= rect.top ||
          body.position.x >= rect.right ||
          body.position.y >= rect.bottom
        );
        if (hit) SeparateTile(i, body, t, rect, null, TILE_BIAS, true);
      }
      onGround = body.blocked.down;
      // Every position counts for coins: a coyote jump collects the first
      // column's coin while running off the edge.
      boxes.push({ left: body.position.x, top: body.position.y });
      if (jumpedAt >= 0 && onGround) {
        return {
          landedOnTarget:
            body.bottom <= targetTop + 0.5 && body.right > targetLeft,
          boxes,
        };
      }
      if (body.position.y > (Math.max(dy, 0) + 10) * TILE)
        return { landedOnTarget: false, boxes };
    }
  }
  return { landedOnTarget: false, boxes };
}

/** Does the body box ever overlap the central 8x8 px of a cell (coin hitbox)? */
function touchesCoin(boxes: Replay["boxes"], cx: number, cy: number): boolean {
  // Offsets -> px: cell (x, y) spans [(x-1)*16, x*16) x [(y-1)*16, y*16).
  const l = (cx - 1) * TILE + 4;
  const t = (cy - 1) * TILE + 4;
  return boxes.some(
    (b) =>
      b.left < l + 8 &&
      b.left + BODY_W > l &&
      b.top < t + 8 &&
      b.top + BODY_H > t,
  );
}

describe("seatsOnEdgeTile vs Phaser's SeparateTile", () => {
  it("agrees on a dense grid of corner arrivals", () => {
    const G = 3;
    const dy = 2;
    const tiles = buildWorld(0, G, dy).filter((t) => t.col >= G); // target platform only
    const mismatches: string[] = [];
    for (const vx of [0, 40, 256]) {
      for (let a = 0.25; a < 30; a += 0.5) {
        for (let sink = 0.25; sink <= 17; sink += 0.5) {
          const vy = 600;
          const body = new FakeBody(
            G * TILE + a - BODY_W,
            dy * TILE + sink - BODY_H,
          );
          body.velocity = { x: vx, y: vy };
          body.prev = {
            x: body.position.x - vx / 60,
            y: body.position.y - vy / 60,
          };
          for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            const rect = {
              left: t.col * TILE,
              top: t.row * TILE,
              right: (t.col + 1) * TILE,
              bottom: (t.row + 1) * TILE,
            };
            const hit = !(
              body.right <= rect.left ||
              body.bottom <= rect.top ||
              body.position.x >= rect.right ||
              body.position.y >= rect.bottom
            );
            if (hit) SeparateTile(i, body, t, rect, null, TILE_BIAS, true);
          }
          const engine = body.blocked.down;
          if (engine !== seatsOnEdgeTile(a, sink, vx))
            mismatches.push(`vx ${vx} a ${a} sink ${sink}: engine ${engine}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("differs from the solver's shorter rule only for deep, slow arrivals", () => {
    // sink <= a seats in the solver; Phaser shoves when the body is mostly
    // inside the edge column and has sunk further than it is from the far side.
    expect(seatsOnEdgeTile(2, 1, 256)).toBe(true);
    expect(seatsOnEdgeTile(1, 2, 256)).toBe(false);
    expect(seatsOnEdgeTile(14.76, 11.83, 40)).toBe(false); // solver rule says true
    expect(seatsOnEdgeTile(14.76, 11.83, 0)).toBe(true);
  });
});

describe("every exported arc in Phaser's real tile separation", () => {
  it("lands on the target and collects every coin on its arc", () => {
    const failures: string[] = [];
    for (const e of TABLES.arcs.entries) {
      const r = replay(e.input, e.gap, e.dy);
      if (!r.landedOnTarget) {
        failures.push(`gap ${e.gap} dy ${e.dy}: did not land`);
        continue;
      }
      for (const c of arcCoins(e.gap, e.dy)) {
        if (!touchesCoin(r.boxes, c.x, c.y))
          failures.push(`gap ${e.gap} dy ${e.dy}: missed coin (${c.x},${c.y})`);
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
