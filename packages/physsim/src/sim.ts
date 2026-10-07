/**
 * Physics-exact playtest agent (G-07), ported from the audit prototype
 * audit-prototypes/playtest-agent/physsim.ts.
 *
 * - Player movement: the knight's own pure `stepMovement` (@app/player/playerPhysics).
 * - Body integration + tile collision: a line-by-line re-implementation of
 *   Phaser 3.90 Arcade (Body.update / World.computeVelocity /
 *   collideSpriteVsTilemapLayer / SeparateTile / TileCheckX|Y), fixed 1/60
 *   step, TILE_BIAS 16, tile faces computed like CalculateFacesWithin. The
 *   audit matched trajectories in the real game to 6e-14 px; sim.test.ts
 *   re-checks the separation against Phaser's own SeparateTile.
 * - Search: weighted A* over macro-actions (move -1/0/1 x jump held or not)
 *   applied for K frames, deduplicated on a quantised state. A found path is
 *   a frame-by-frame input list that replays in the real game.
 *
 * Additions over the prototype: arbitrary goal (cell, rectangle or
 * predicate), a column window (`xRange`) that prunes everything outside it
 * so a suggestion can be verified in a few ms, a wall-clock cap, a node cap,
 * a resumable stepper (so an in-process caller can yield), struct-of-arrays
 * node storage, the tile path, and the furthest point reached on failure.
 *
 * Pure TypeScript, no Phaser import: safe in Web Workers and Node tests.
 */
import {
  createMovementState,
  GRAVITY_PX,
  MAX_RUN_SPEED_PX,
  PLAYER_BODY_PX,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  type PlayerMovementState,
} from "@app/player/playerPhysics";
import type { Point } from "../../../apps/editor/src/contracts";
import {
  goalColumns,
  goalPredicate,
  type GoalSpec,
  type SolidGrid,
  type XRange,
} from "./grid";

/** World pixels per tile. */
export const T = 16;
/** Arcade's fixed step (World defaults: fps 60, fixedStep true). */
export const DT = 1 / 60;
/** Phaser's World.TILE_BIAS default. */
export const TILE_BIAS = 16;
/** Body size in px (configurePlayerSprite). */
export const BW = PLAYER_BODY_PX.width; // 10
export const BH = PLAYER_BODY_PX.height; // 14
/** Body offset inside its cell when spawned (sprite origin 0.5, offset 3,1). */
export const SPAWN_OFFSET_X = (T - BW) / 2; // 3

/** Face bits per solid tile: 1 top, 2 bottom, 4 left, 8 right. */
export const FACE_TOP = 1;
export const FACE_BOTTOM = 2;
export const FACE_LEFT = 4;
export const FACE_RIGHT = 8;

/** Solid cells and their exposed collision faces, precomputed once per grid. */
export class Level {
  readonly W: number;
  readonly H: number;
  /** 1 = solid, row-major. */
  readonly s: Uint8Array;
  /** Exposed faces of each solid tile (FACE_* bits), row-major. */
  readonly face: Uint8Array;

  constructor(grid: SolidGrid) {
    this.W = grid.w;
    this.H = grid.h;
    const n = this.W * this.H;
    this.s = new Uint8Array(n);
    this.face = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.s[i] = grid.solid[i] ? 1 : 0;
    for (let y = 0; y < this.H; y++)
      for (let x = 0; x < this.W; x++) {
        if (!this.solid(x, y)) continue;
        // CalculateFacesWithin: a face is "interesting" where the neighbour
        // is not colliding (cells outside the layer count as empty).
        let f = 0;
        if (!this.solid(x, y - 1)) f |= FACE_TOP;
        if (!this.solid(x, y + 1)) f |= FACE_BOTTOM;
        if (!this.solid(x - 1, y)) f |= FACE_LEFT;
        if (!this.solid(x + 1, y)) f |= FACE_RIGHT;
        this.face[y * this.W + x] = f;
      }
  }

  solid(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.W && y < this.H && this.s[y * this.W + x] === 1;
  }

  standable(x: number, y: number): boolean {
    return x >= 0 && x < this.W && y >= 0 && y + 1 < this.H && !this.solid(x, y) && this.solid(x, y + 1);
  }
}

/** Accept either a prepared Level or a raw grid. */
export function asLevel(level: Level | SolidGrid): Level {
  return level instanceof Level ? level : new Level(level);
}

/** The Arcade body plus the controller's persistent state. */
export interface Body {
  /** Body top-left, px. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** body.blocked.* after the last step. */
  down: boolean;
  up: boolean;
  left: boolean;
  right: boolean;
  /** position - prev, px, of the last step. */
  dx: number;
  dy: number;
  ms: PlayerMovementState;
  prevJump: boolean;
}

export interface Input {
  move: -1 | 0 | 1;
  jump: boolean;
}

// ---------------------------------------------------------------------------
// Phaser Arcade tile collision, line by line
// ---------------------------------------------------------------------------

/** TileCheckX + ProcessTileSeparationX (bounce 0, all collide flags on). */
function tileCheckX(b: Body, faceL: boolean, faceR: boolean, l: number, r: number): number {
  let ox = 0;
  if (b.dx < 0) {
    if (faceR && b.x < r) {
      ox = b.x - r;
      if (ox < -TILE_BIAS) ox = 0;
    }
  } else if (b.dx > 0) {
    if (faceL && b.x + BW > l) {
      ox = b.x + BW - l;
      if (ox > TILE_BIAS) ox = 0;
    }
  }
  if (ox !== 0) {
    if (ox < 0) b.left = true;
    else b.right = true;
    b.x -= ox;
    b.vx = 0;
  }
  return ox;
}

/** TileCheckY + ProcessTileSeparationY (bounce 0, all collide flags on). */
function tileCheckY(b: Body, faceT: boolean, faceB: boolean, t: number, bot: number): number {
  let oy = 0;
  if (b.dy < 0) {
    if (faceB && b.y < bot) {
      oy = b.y - bot;
      if (oy < -TILE_BIAS) oy = 0;
    }
  } else if (b.dy > 0) {
    if (faceT && b.y + BH > t) {
      oy = b.y + BH - t;
      if (oy > TILE_BIAS) oy = 0;
    }
  }
  if (oy !== 0) {
    if (oy < 0) b.up = true;
    else b.down = true;
    b.y -= oy;
    b.vy = 0;
  }
  return oy;
}

/** TileIntersectsBody. */
function intersects(b: Body, l: number, t: number, r: number, bot: number): boolean {
  return !(b.x + BW <= l || b.y + BH <= t || b.x >= r || b.y >= bot);
}

/** SeparateTile (isLayer = true). */
function separateTile(b: Body, f: number, l: number, t: number, r: number, bot: number): void {
  const faceT = (f & FACE_TOP) !== 0;
  const faceB = (f & FACE_BOTTOM) !== 0;
  const faceL = (f & FACE_LEFT) !== 0;
  const faceR = (f & FACE_RIGHT) !== 0;
  const fh = faceL || faceR;
  const fv = faceT || faceB;
  if (!fh && !fv) return;
  let minX = 0;
  let minY = 1;
  const adx = Math.abs(b.dx);
  const ady = Math.abs(b.dy);
  if (adx > ady) minX = -1;
  else if (adx < ady) minY = -1;
  if (b.dx !== 0 && b.dy !== 0 && fh && fv) {
    minX = Math.min(Math.abs(b.x - r), Math.abs(b.x + BW - l));
    minY = Math.min(Math.abs(b.y - bot), Math.abs(b.y + BH - t));
  }
  if (minX < minY) {
    if (fh) {
      const ox = tileCheckX(b, faceL, faceR, l, r);
      if (ox !== 0 && !intersects(b, l, t, r, bot)) return;
    }
    if (fv) tileCheckY(b, faceT, faceB, t, bot);
  } else {
    if (fv) {
      const oy = tileCheckY(b, faceT, faceB, t, bot);
      if (oy !== 0 && !intersects(b, l, t, r, bot)) return;
    }
    if (fh) tileCheckX(b, faceL, faceR, l, r);
  }
}

/**
 * collideSpriteVsTilemapLayer: tiles within the body grown by one tile up and
 * left (GetTilesWithinWorldXY, row-major), filtered to colliding tiles with
 * an interesting face, each separated in turn.
 */
function collide(L: Level, b: Body): void {
  let xs = Math.floor((b.x - T) / T);
  let ys = Math.floor((b.y - T) / T);
  const xe = Math.ceil((b.x + BW) / T);
  const ye = Math.ceil((b.y + BH) / T);
  let w = xe - xs;
  let h = ye - ys;
  if (xs < 0) {
    w += xs;
    xs = 0;
  }
  if (ys < 0) {
    h += ys;
    ys = 0;
  }
  if (xs + w > L.W) w = Math.max(L.W - xs, 0);
  if (ys + h > L.H) h = Math.max(L.H - ys, 0);
  const W = L.W;
  for (let ty = ys; ty < ys + h; ty++)
    for (let tx = xs; tx < xs + w; tx++) {
      const i = ty * W + tx;
      const f = L.face[i];
      if (!L.s[i] || !f) continue;
      const l = tx * T;
      const t = ty * T;
      if (!intersects(b, l, t, l + T, t + T)) continue;
      separateTile(b, f, l, t, l + T, t + T);
    }
}

/**
 * One rendered frame at 60 fps: the controller (stepMovement) then one
 * Arcade step (reset flags, integrate with gravity and maxVelocity clamp,
 * collide with the tile layer).
 */
export function frame(L: Level, b: Body, move: -1 | 0 | 1, jumpHeld: boolean): void {
  const jumpJustPressed = jumpHeld && !b.prevJump;
  b.prevJump = jumpHeld;
  const r = stepMovement(b.ms, { moveInput: move, jumpHeld, jumpJustPressed }, b.vx, b.vy, b.down, DT);
  b.vx = r.velocityX;
  b.vy = r.velocityY;
  b.down = b.up = b.left = b.right = false;
  const px = b.x;
  const py = b.y;
  let vx = b.vx;
  let vy = b.vy + GRAVITY_PX * DT;
  vx = Math.max(-MAX_RUN_SPEED_PX, Math.min(MAX_RUN_SPEED_PX, vx));
  vy = Math.max(-TERMINAL_VELOCITY_PX, Math.min(TERMINAL_VELOCITY_PX, vy));
  b.vx = vx;
  b.vy = vy;
  b.x += vx * DT;
  b.y += vy * DT;
  b.dx = b.x - px;
  b.dy = b.y - py;
  collide(L, b);
}

/**
 * A body standing in cell (cellX, cellY): centred horizontally, feet on the
 * top of the row below. `down` is true only when that row is solid.
 */
export function spawnBody(cellX: number, cellY: number, L?: Level): Body {
  return {
    x: cellX * T + SPAWN_OFFSET_X,
    y: (cellY + 1) * T - BH,
    vx: 0,
    vy: 0,
    down: L ? L.solid(cellX, cellY + 1) : true,
    up: false,
    left: false,
    right: false,
    dx: 0,
    dy: 0,
    ms: createMovementState(),
    prevJump: false,
  };
}

export function cloneBody(b: Body): Body {
  return { ...b, ms: { ...b.ms } };
}

/** The cell holding the body's centre (the standing cell when grounded). */
export function bodyCell(b: { x: number; y: number }): Point {
  return { x: Math.floor((b.x + BW / 2) / T), y: Math.floor((b.y + BH / 2) / T) };
}

/** Replay an input list; per-frame [x, y, vx, vy, down] (engine validation, overlays). */
export function replay(level: Level | SolidGrid, start: Point, inputs: readonly Input[]): number[][] {
  const L = asLevel(level);
  const b = spawnBody(start.x, start.y, L);
  const traj: number[][] = [];
  for (const i of inputs) {
    frame(L, b, i.move, i.jump);
    traj.push([b.x, b.y, b.vx, b.vy, b.down ? 1 : 0]);
  }
  return traj;
}

/** Replay inputs and return the body's centre cells, consecutive duplicates removed. */
export function replayPath(level: Level | SolidGrid, start: Point, inputs: readonly Input[]): Point[] {
  const L = asLevel(level);
  const b = spawnBody(start.x, start.y, L);
  const path: Point[] = [bodyCell(b)];
  for (const i of inputs) {
    frame(L, b, i.move, i.jump);
    const c = bodyCell(b);
    const last = path[path.length - 1];
    if (c.x !== last.x || c.y !== last.y) path.push(c);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** One search pass: macro-action length and state quantisation. */
export interface SearchPass {
  /** Frames per macro-action. */
  K: number;
  /** Position quantum, px. */
  qx: number;
  /** Horizontal velocity quantum, px/s. */
  qv: number;
}

/**
 * Default passes: the audit's coarse pass (K 4, 4 px), which finds almost
 * every beatable section quickly, then a finer-in-time pass (K 2) only if
 * the coarse pass ran out of states (never after a time-out). K 2 at 4 px
 * found every case the audit's K 2 at 2 px found on the gap ladder, at about
 * a third of the cost of proving impossibility.
 */
export const DEFAULT_PASSES: readonly SearchPass[] = [
  { K: 4, qx: 4, qv: 32 },
  { K: 2, qx: 4, qv: 32 },
];

/** The audit's own second pass appended: slowest, for offline evaluation. */
export const THOROUGH_PASSES: readonly SearchPass[] = [...DEFAULT_PASSES, { K: 2, qx: 2, qv: 32 }];

export interface SearchOptions {
  /** Wall-clock cap across all passes, ms. Default 300 (config.agentCapMs). */
  capMs?: number;
  /** Node-expansion cap across all passes. Default 2,000,000. */
  maxNodes?: number;
  /** Only simulate inside these columns (inclusive); leaving them is a dead end. */
  xRange?: XRange;
  /** Override the passes. */
  passes?: readonly SearchPass[];
  /** Heuristic weight (1 = plain A*). Larger is greedier. Default 1.5. */
  weight?: number;
  /** Fall-death line, px. Default level height + 3 tiles. */
  deathY?: number;
  /** Column hint for the heuristic when `to` is a predicate. */
  hint?: Point;
  /** Start from this exact body position (px) instead of the cell's spawn. */
  startBody?: { x: number; y: number; vx?: number; vy?: number };
  /** Clock (ms). Default performance.now, falling back to Date.now. */
  now?: () => number;
}

export interface SearchResult {
  found: boolean;
  /** Body centre cells along the route, consecutive duplicates removed. Empty when not found. */
  path: Point[];
  /** Frame-by-frame inputs at 60 fps (present when found). */
  inputs?: Input[];
  /** Frames the route takes (present when found). */
  frames?: number;
  /** Node expansions across all passes. */
  nodes: number;
  /** Distinct quantised states seen in the last pass. */
  visited: number;
  ms: number;
  /** Stopped by capMs or maxNodes before a verdict. Over cap counts as a fail. */
  timedOut: boolean;
  /**
   * Every reachable quantised state was explored without reaching the goal.
   * The strongest "impossible" this agent can give.
   */
  exhausted: boolean;
  /** Standing cell nearest the goal that the agent reached (failures and successes). */
  blockedAt?: Point;
  /** Index of the pass that produced the verdict. */
  pass: number;
  /** The settled start cell (or null if the start could not be placed). */
  start: Point;
}

const ACTIONS: readonly Input[] = [
  { move: 1, jump: false },
  { move: 1, jump: true },
  { move: 0, jump: false },
  { move: 0, jump: true },
  { move: -1, jump: false },
  { move: -1, jump: true },
];

const defaultNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/** Binary min-heap of node indices keyed by f. */
class Heap {
  private v = new Int32Array(1024);
  private k = new Float64Array(1024);
  size = 0;
  push(node: number, key: number): void {
    if (this.size === this.v.length) {
      const nv = new Int32Array(this.v.length * 2);
      nv.set(this.v);
      this.v = nv;
      const nk = new Float64Array(this.k.length * 2);
      nk.set(this.k);
      this.k = nk;
    }
    const v = this.v;
    const k = this.k;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      v[i] = v[p];
      k[i] = k[p];
      i = p;
    }
    v[i] = node;
    k[i] = key;
  }
  pop(): number {
    const v = this.v;
    const k = this.k;
    const top = v[0];
    const n = --this.size;
    if (n > 0) {
      const lv = v[n];
      const lk = k[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && k[r] < k[l] ? r : l;
        if (k[m] >= lk) break;
        v[i] = v[m];
        k[i] = k[m];
        i = m;
      }
      v[i] = lv;
      k[i] = lk;
    }
    return top;
  }
}

/**
 * Open-addressing hash set of non-negative integer keys below 2^53 (the
 * quantised states). Faster and leaner than Set<number> at millions of keys.
 */
class KeySet {
  private keys: Float64Array;
  private mask: number;
  size = 0;
  constructor(capacityPow2 = 1 << 14) {
    this.keys = new Float64Array(capacityPow2).fill(-1);
    this.mask = capacityPow2 - 1;
  }
  private static slot(k: number, mask: number): number {
    // Mix the high and low 32 bits.
    const lo = k >>> 0;
    const hi = (k / 4294967296) >>> 0;
    let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 13;
    return h & mask;
  }
  /** Insert; returns false when the key was already present. */
  add(k: number): boolean {
    if ((this.size + 1) * 2 > this.keys.length) this.rehash();
    const keys = this.keys;
    const mask = this.mask;
    let i = KeySet.slot(k, mask);
    for (;;) {
      const v = keys[i];
      if (v === -1) {
        keys[i] = k;
        this.size++;
        return true;
      }
      if (v === k) return false;
      i = (i + 1) & mask;
    }
  }
  private rehash(): void {
    const old = this.keys;
    this.keys = new Float64Array(old.length * 2).fill(-1);
    this.mask = this.keys.length - 1;
    this.size = 0;
    for (let i = 0; i < old.length; i++) if (old[i] !== -1) this.add(old[i]);
  }
}

/** Struct-of-arrays node storage: no per-node objects. */
class Nodes {
  cap = 4096;
  n = 0;
  f = new Float64Array(this.cap * 6); // x, y, vx, vy, coyote, buffer
  flags = new Uint8Array(this.cap); // 1 down, 2 canCutJump, 4 prevJump
  parent = new Int32Array(this.cap);
  act = new Uint8Array(this.cap);
  g = new Int32Array(this.cap);

  private grow(): void {
    const c = this.cap * 2;
    const f = new Float64Array(c * 6);
    f.set(this.f);
    this.f = f;
    const fl = new Uint8Array(c);
    fl.set(this.flags);
    this.flags = fl;
    const p = new Int32Array(c);
    p.set(this.parent);
    this.parent = p;
    const a = new Uint8Array(c);
    a.set(this.act);
    this.act = a;
    const g = new Int32Array(c);
    g.set(this.g);
    this.g = g;
    this.cap = c;
  }

  add(b: Body, parent: number, act: number, g: number): number {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    const o = i * 6;
    const f = this.f;
    f[o] = b.x;
    f[o + 1] = b.y;
    f[o + 2] = b.vx;
    f[o + 3] = b.vy;
    f[o + 4] = b.ms.coyoteTimer;
    f[o + 5] = b.ms.jumpBufferTimer;
    this.flags[i] = (b.down ? 1 : 0) | (b.ms.canCutJump ? 2 : 0) | (b.prevJump ? 4 : 0);
    this.parent[i] = parent;
    this.act[i] = act;
    this.g[i] = g;
    return i;
  }

  load(i: number, b: Body): void {
    const o = i * 6;
    const f = this.f;
    b.x = f[o];
    b.y = f[o + 1];
    b.vx = f[o + 2];
    b.vy = f[o + 3];
    b.ms.coyoteTimer = f[o + 4];
    b.ms.jumpBufferTimer = f[o + 5];
    const fl = this.flags[i];
    b.down = (fl & 1) !== 0;
    b.ms.canCutJump = (fl & 2) !== 0;
    b.prevJump = (fl & 4) !== 0;
    b.up = b.left = b.right = false;
    b.dx = b.dy = 0;
  }
}

/**
 * Resumable search. `run(budgetMs)` advances for at most that long and
 * returns the result once there is a verdict (found, exhausted or capped),
 * or null if it needs more calls. `search()` below drives it to completion.
 */
export class AgentSearch {
  readonly L: Level;
  readonly start: Point;
  private readonly isGoalCell: (x: number, y: number) => boolean;
  private readonly cols: [number, number] | null;
  private readonly passes: readonly SearchPass[];
  private readonly capMs: number;
  private readonly maxNodes: number;
  private readonly weight: number;
  private readonly deathY: number;
  private readonly minX: number;
  private readonly maxX: number;
  private readonly now: () => number;
  private readonly startBody?: SearchOptions["startBody"];
  private readonly t0: number;

  private passIndex = -1;
  private nodes!: Nodes;
  private heap!: Heap;
  private seen!: KeySet;
  private pass!: SearchPass;
  private expandedTotal = 0;
  private bestH = Infinity;
  private bestCell: Point;
  private result: SearchResult | null = null;
  private readonly scratch: Body;

  constructor(level: Level | SolidGrid, from: Point, to: GoalSpec, o: SearchOptions = {}) {
    this.L = asLevel(level);
    this.now = o.now ?? defaultNow;
    this.t0 = this.now();
    this.start = { x: Math.round(from.x), y: Math.round(from.y) };
    this.isGoalCell = goalPredicate(to);
    this.cols = goalColumns(to, o.hint);
    this.passes = o.passes && o.passes.length ? o.passes : DEFAULT_PASSES;
    this.capMs = o.capMs ?? 300;
    this.maxNodes = o.maxNodes ?? 2_000_000;
    this.weight = o.weight ?? 1.5;
    this.startBody = o.startBody;
    if (o.xRange) {
      // The window always includes the start and, for a cell goal, the goal.
      let x0 = Math.min(o.xRange[0], o.xRange[1], this.start.x);
      let x1 = Math.max(o.xRange[0], o.xRange[1], this.start.x);
      if (this.cols && Number.isFinite(this.cols[0]) && this.cols[0] === this.cols[1]) {
        x0 = Math.min(x0, this.cols[0]);
        x1 = Math.max(x1, this.cols[1]);
      }
      this.minX = x0 * T;
      this.maxX = (x1 + 1) * T;
    } else {
      this.minX = -2 * T;
      this.maxX = (this.L.W + 2) * T;
    }
    this.deathY = o.deathY ?? this.defaultDeathY();
    this.scratch = spawnBody(this.start.x, this.start.y, this.L);
    this.bestCell = { ...this.start };
    this.nextPass();
  }

  /**
   * Body-top line below which the knight can never land again: two tiles
   * under the top of the lowest solid tile in the window (one tile more than
   * TILE_BIAS can snap back), capped at three tiles under the level.
   */
  private defaultDeathY(): number {
    const L = this.L;
    const c0 = Math.max(0, Math.floor(this.minX / T) - 1);
    const c1 = Math.min(L.W - 1, Math.ceil(this.maxX / T) + 1);
    let lowest = -1;
    for (let y = L.H - 1; y >= 0 && lowest < 0; y--)
      for (let x = c0; x <= c1; x++)
        if (L.s[y * L.W + x]) {
          lowest = y;
          break;
        }
    const cap = L.H * T + 3 * T;
    return lowest < 0 ? cap : Math.min(cap, (lowest + 2) * T);
  }

  /** Heuristic in frames: horizontal distance to the goal columns at top speed. */
  private h(x: number): number {
    const c = this.cols;
    if (!c) return 0;
    const cx = x + BW / 2;
    const lo = c[0] * T;
    const hi = (c[1] + 1) * T;
    const d = cx < lo ? lo - cx : cx >= hi ? cx - hi + 1e-9 : 0;
    return (d / MAX_RUN_SPEED_PX) * 60;
  }

  private key(b: Body): number {
    const p = this.pass;
    const fl =
      (b.down ? 1 : 0) |
      (b.ms.canCutJump ? 2 : 0) |
      (b.prevJump ? 4 : 0) |
      (b.ms.coyoteTimer > 0 ? 8 : 0) |
      (b.ms.jumpBufferTimer > 0 ? 16 : 0);
    const kx = Math.round(b.x / p.qx) + 1024;
    const ky = Math.round(b.y / p.qx) + 1024;
    const kvx = Math.round(b.vx / p.qv) + 64;
    const kvy = Math.round(b.vy / 25) + 64;
    return (((kx * 4096 + ky) * 128 + kvx) * 128 + kvy) * 32 + fl;
  }

  private startBodyFresh(): Body {
    const b = spawnBody(this.start.x, this.start.y, this.L);
    if (this.startBody) {
      b.x = this.startBody.x;
      b.y = this.startBody.y;
      b.vx = this.startBody.vx ?? 0;
      b.vy = this.startBody.vy ?? 0;
      b.down = false;
    }
    return b;
  }

  private nextPass(): boolean {
    this.passIndex++;
    if (this.passIndex >= this.passes.length) return false;
    this.pass = this.passes[this.passIndex];
    this.nodes = new Nodes();
    this.heap = new Heap();
    this.seen = new KeySet();
    const b0 = this.startBodyFresh();
    const i0 = this.nodes.add(b0, -1, 255, 0);
    this.seen.add(this.key(b0));
    this.heap.push(i0, this.weight * this.h(b0.x));
    return true;
  }

  private isGoal(b: Body): boolean {
    if (!b.down) return false;
    const c = bodyCell(b);
    return this.isGoalCell(c.x, c.y);
  }

  private finish(found: boolean, timedOut: boolean, exhausted: boolean, goalNode = -1): SearchResult {
    const ms = this.now() - this.t0;
    const res: SearchResult = {
      found,
      path: [],
      nodes: this.expandedTotal,
      visited: this.seen.size,
      ms,
      timedOut,
      exhausted,
      blockedAt: { ...this.bestCell },
      pass: this.passIndex,
      start: { ...this.start },
    };
    if (found && goalNode >= 0) {
      const acts: number[] = [];
      for (let c = goalNode; this.nodes.parent[c] >= 0; c = this.nodes.parent[c]) acts.push(this.nodes.act[c]);
      acts.reverse();
      const K = this.pass.K;
      const inputs: Input[] = [];
      for (const a of acts) for (let i = 0; i < K; i++) inputs.push(ACTIONS[a]);
      res.inputs = inputs;
      res.frames = this.nodes.g[goalNode];
      // Rebuild the centre path by replaying (deterministic).
      const b = this.startBodyFresh();
      const path: Point[] = [bodyCell(b)];
      for (const inp of inputs) {
        frame(this.L, b, inp.move, inp.jump);
        const c = bodyCell(b);
        const last = path[path.length - 1];
        if (c.x !== last.x || c.y !== last.y) path.push(c);
      }
      res.path = path;
      res.blockedAt = bodyCell(b);
    }
    this.result = res;
    return res;
  }

  /** The verdict, once there is one. */
  get done(): SearchResult | null {
    return this.result;
  }

  /**
   * Advance the search for at most `budgetMs` (bounded by the overall cap).
   * Returns the verdict, or null when more work remains.
   */
  run(budgetMs = Infinity): SearchResult | null {
    if (this.result) return this.result;
    const L = this.L;
    const b = this.scratch;
    const sliceEnd = this.now() + budgetMs;
    const deadline = this.t0 + this.capMs;
    let tick = 0;
    for (;;) {
      if (this.heap.size === 0) {
        // This pass ran out of states: try the next, finer one.
        if (!this.nextPass()) return this.finish(false, false, true);
        continue;
      }
      if ((++tick & 127) === 0) {
        const t = this.now();
        if (t >= deadline) return this.finish(false, true, false);
        if (t >= sliceEnd) return null;
      }
      const ni = this.heap.pop();
      this.nodes.load(ni, b);
      if (this.isGoal(b)) return this.finish(true, false, false, ni);
      if (b.down) {
        const hv = this.h(b.x);
        if (hv < this.bestH) {
          this.bestH = hv;
          this.bestCell = bodyCell(b);
        }
      }
      if (++this.expandedTotal > this.maxNodes) return this.finish(false, true, false);
      const K = this.pass.K;
      const g = this.nodes.g[ni] + K;
      for (let a = 0; a < ACTIONS.length; a++) {
        this.nodes.load(ni, b);
        const act = ACTIONS[a];
        let dead = false;
        for (let i = 0; i < K; i++) {
          frame(L, b, act.move, act.jump);
          if (b.y > this.deathY || b.x < this.minX || b.x + BW > this.maxX) {
            dead = true;
            break;
          }
        }
        if (dead) continue;
        if (!this.seen.add(this.key(b))) continue;
        const c = this.nodes.add(b, ni, a, g);
        this.heap.push(c, g + this.weight * this.h(b.x));
      }
    }
  }
}

/**
 * Search for inputs that take the knight from standing in `from` to standing
 * in `to` (a cell, a rectangle or a predicate). Synchronous; bounded by
 * `capMs` and `maxNodes`. Over cap returns found = false, timedOut = true.
 */
export function search(
  level: Level | SolidGrid,
  from: Point,
  to: GoalSpec,
  opts: SearchOptions = {},
): SearchResult {
  const s = new AgentSearch(level, from, to, opts);
  let r: SearchResult | null = null;
  while (!r) r = s.run();
  return r;
}
