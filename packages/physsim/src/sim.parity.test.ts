/**
 * Parity: the agent's Arcade port vs Phaser 3.90's own code.
 *
 * The audit validated physsim against the running game in a browser
 * (validate_engine.cjs, 6e-14 px). This test keeps that guarantee in CI
 * without a browser: it replays inputs through a harness built from Phaser's
 * real modules — World.computeVelocity, GetTilesWithin with the layer's
 * collision filter, CalculateFacesWithin, TileIntersectsBody and
 * SeparateTile — driving a stand-in Body that keeps Body.update's cached
 * deltas. Every frame must match the agent's `frame()` exactly.
 */
import { describe, expect, it } from "vitest";
import World from "phaser/src/physics/arcade/World.js";
import SeparateTile from "phaser/src/physics/arcade/tilemap/SeparateTile.js";
import TileIntersectsBody from "phaser/src/physics/arcade/tilemap/TileIntersectsBody.js";
import GetTilesWithin from "phaser/src/tilemaps/components/GetTilesWithin.js";
import CalculateFacesWithin from "phaser/src/tilemaps/components/CalculateFacesWithin.js";
import {
  createMovementState,
  GRAVITY_PX,
  MAX_RUN_SPEED_PX,
  stepMovement,
  TERMINAL_VELOCITY_PX,
} from "@app/player/playerPhysics";
import { FIXTURES, gapLevel, tunnelLevel } from "./fixtures";
import { gridFromRows, type SolidGrid } from "./grid";
import { BH, BW, DT, replay, search, T, TILE_BIAS, type Input } from "./sim";

/** The bits of Phaser.Math.Vector2 that computeVelocity calls. */
class Vec {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  set(x: number, y: number) {
    this.x = x;
    this.y = y;
    return this;
  }
  length() {
    return Math.hypot(this.x, this.y);
  }
}

/** Stand-in for Phaser.Physics.Arcade.Body with the fields the chain reads. */
class EngineBody {
  position = { x: 0, y: 0 };
  prev = { x: 0, y: 0 };
  width = BW;
  height = BH;
  velocity = new Vec();
  acceleration = { x: 0, y: 0 };
  drag = { x: 0, y: 0 };
  maxVelocity = { x: MAX_RUN_SPEED_PX, y: TERMINAL_VELOCITY_PX };
  gravity = { x: 0, y: 0 };
  bounce = { x: 0, y: 0 };
  allowGravity = true;
  allowDrag = true;
  useDamping = false;
  maxSpeed = -1;
  speed = 0;
  blocked = { none: true, up: false, down: false, left: false, right: false };
  checkCollision = { none: false, up: true, down: true, left: true, right: true };
  customSeparateX = false;
  customSeparateY = false;
  overlapX = 0;
  overlapY = 0;
  _dx = 0;
  _dy = 0;
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
    return this._dx;
  }
  deltaY() {
    return this._dy;
  }
  deltaAbsX() {
    return Math.abs(this._dx);
  }
  deltaAbsY() {
    return Math.abs(this._dy);
  }
  updateCenter() {}
}

interface EngineTile {
  x: number;
  y: number;
  index: number;
  collides: boolean;
  faceTop: boolean;
  faceBottom: boolean;
  faceLeft: boolean;
  faceRight: boolean;
  collideUp: boolean;
  collideDown: boolean;
  collideLeft: boolean;
  collideRight: boolean;
  readonly hasInterestingFace: boolean;
  resetFaces(): void;
}

function engineLayer(grid: SolidGrid) {
  const data: EngineTile[][] = [];
  for (let y = 0; y < grid.h; y++) {
    const row: EngineTile[] = [];
    for (let x = 0; x < grid.w; x++) {
      const solid = !!grid.solid[y * grid.w + x];
      row.push({
        x,
        y,
        index: solid ? 5 : -1,
        collides: solid,
        faceTop: false,
        faceBottom: false,
        faceLeft: false,
        faceRight: false,
        collideUp: solid,
        collideDown: solid,
        collideLeft: solid,
        collideRight: solid,
        get hasInterestingFace() {
          return this.faceTop || this.faceBottom || this.faceLeft || this.faceRight;
        },
        resetFaces() {
          this.faceTop = this.faceBottom = this.faceLeft = this.faceRight = false;
        },
      });
    }
    data.push(row);
  }
  const layer = { width: grid.w, height: grid.h, data };
  CalculateFacesWithin(0, 0, grid.w, grid.h, layer);
  return layer;
}

const FILTER = { isNotEmpty: true, isColliding: true, hasInterestingFace: true };
const WORLD = { gravity: { x: 0, y: GRAVITY_PX } };

/** Replay inputs through Phaser's own physics code. Same row format as sim.replay. */
function engineReplay(grid: SolidGrid, start: { x: number; y: number }, inputs: readonly Input[]): number[][] {
  const layer = engineLayer(grid);
  const body = new EngineBody();
  body.position = { x: start.x * T + (T - BW) / 2, y: (start.y + 1) * T - BH };
  let down = !!grid.solid[(start.y + 1) * grid.w + start.x];
  const ms = createMovementState();
  let prevJump = false;
  const out: number[][] = [];
  for (const inp of inputs) {
    // PlayerController.update
    const jjp = inp.jump && !prevJump;
    prevJump = inp.jump;
    const r = stepMovement(ms, { moveInput: inp.move, jumpHeld: inp.jump, jumpJustPressed: jjp }, body.velocity.x, body.velocity.y, down, DT);
    body.velocity.x = r.velocityX;
    body.velocity.y = r.velocityY;
    // World.step -> Body.preUpdate (resetFlags) -> Body.update
    body.blocked = { none: true, up: false, down: false, left: false, right: false };
    body.prev = { x: body.position.x, y: body.position.y };
    World.prototype.computeVelocity.call(WORLD, body, DT);
    body.position.x += body.velocity.x * DT;
    body.position.y += body.velocity.y * DT;
    body._dx = body.position.x - body.prev.x;
    body._dy = body.position.y - body.prev.y;
    // Collider -> collideSpriteVsTilemapLayer (orthogonal world->tile at scale 1)
    const wx = body.x - T;
    const wy = body.y - T;
    const xs = Math.floor(wx / T);
    const ys = Math.floor(wy / T);
    const xe = Math.ceil((wx + body.width + T) / T);
    const ye = Math.ceil((wy + body.height + T) / T);
    const tiles = GetTilesWithin<EngineTile>(xs, ys, xe - xs, ye - ys, FILTER, layer);
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const rect = { left: t.x * T, top: t.y * T, right: t.x * T + T, bottom: t.y * T + T };
      if (TileIntersectsBody(rect, body)) SeparateTile(i, body, t, rect, null, TILE_BIAS, true);
    }
    down = body.blocked.down;
    out.push([body.position.x, body.position.y, body.velocity.x, body.velocity.y, down ? 1 : 0]);
  }
  return out;
}

function maxDiff(a: number[][], b: number[][]): { d: number; frame: number } {
  let d = 0;
  let frame = -1;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < 5; j++) {
      // -0 vs 0 after a bounce-0 separation is the same velocity.
      const e = Math.abs(a[i][j] - b[i][j]);
      if (e > d) {
        d = e;
        frame = i;
      }
    }
  }
  return { d, frame };
}

/** Deterministic pseudo-random inputs that bang into walls and ceilings. */
function randomInputs(seed: number, n: number): Input[] {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const out: Input[] = [];
  let move: -1 | 0 | 1 = 1;
  let jump = false;
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.08) move = rnd() < 0.6 ? 1 : rnd() < 0.5 ? 0 : -1;
    if (rnd() < 0.1) jump = !jump;
    out.push({ move, jump });
  }
  return out;
}

const PLAYGROUND = gridFromRows([
  "..............................",
  "..............................",
  "..........####........#.......",
  "......................#.......",
  "...##.................#...###.",
  "..........#####.......#.......",
  "#.....................#.......",
  "#..............##.............",
  "#####...####...##...#####..###",
  "#####...####...##...#####..###",
  "#####...####...##...#####..###",
  "#####...####...##...#####..###",
]);

describe("agent physics == Phaser 3.90 Arcade", () => {
  it("matches on every beatable fixture's found route, frame by frame", () => {
    for (const f of FIXTURES.filter((x) => x.beatable)) {
      const res = search(f.grid, f.from, f.to, { capMs: 5000 });
      expect(res.found, f.name).toBe(true);
      const sim = replay(f.grid, f.from, res.inputs!);
      const eng = engineReplay(f.grid, f.from, res.inputs!);
      const { d, frame } = maxDiff(sim, eng);
      expect(d, `${f.name}: first divergence near frame ${frame}`).toBeLessThan(1e-9);
      // And the engine also ends standing in the goal column.
      const last = eng[eng.length - 1];
      expect(last[4], f.name).toBe(1);
    }
  });

  it("matches on random input streams through walls, ceilings, ledges and pits", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const inputs = randomInputs(seed, 600);
      for (const start of [{ x: 1, y: 7 }, { x: 13, y: 7 }]) {
        const sim = replay(PLAYGROUND, start, inputs);
        const eng = engineReplay(PLAYGROUND, start, inputs);
        const { d, frame } = maxDiff(sim, eng);
        expect(d, `seed ${seed} start ${start.x}: divergence at frame ${frame}`).toBeLessThan(1e-9);
      }
    }
  });

  it("matches under a low tunnel, where the head bonks every jump", () => {
    const grid = tunnelLevel(3, 2);
    for (let seed = 100; seed < 110; seed++) {
      const inputs = randomInputs(seed, 400);
      const { d } = maxDiff(replay(grid, { x: 0, y: 7 }, inputs), engineReplay(grid, { x: 0, y: 7 }, inputs));
      expect(d).toBeLessThan(1e-9);
    }
  });

  it("the widest gap found by the agent lands in the engine too", () => {
    const grid = gapLevel(7, 12);
    const res = search(grid, { x: 0, y: 7 }, { x0: grid.w - 1 }, { capMs: 5000 });
    expect(res.found).toBe(true);
    const eng = engineReplay(grid, { x: 0, y: 7 }, res.inputs!);
    const last = eng[eng.length - 1];
    expect(last[4]).toBe(1);
    expect(Math.floor((last[0] + BW / 2) / T)).toBe(grid.w - 1);
  });
});
