/**
 * Jump-arc tracer: the tile cells the knight passes through when it jumps a
 * given gap onto a target at a given height difference.
 *
 * Used to place coins "on the arc the knight would take" (G-26). Every arc is
 * a real trajectory of the live movement code: it drives the same
 * `stepMovement` the game's PlayerController uses, inside the same loop the
 * fork's jumpSolver uses (controller at the render rate, then fixed 1/60
 * Arcade steps: gravity -> integrate -> resolve). The loop below mirrors
 * `simulate()` in apps/editor/src/player/jumpSolver.ts line for line, with
 * two extensions the solver does not need:
 *
 *  1. Horizontal input may be RELEASED a number of frames after takeoff.
 *     The solver only ever holds right, because it searches for the widest
 *     gap. A coin arc over a 2-tile gap is not a max-distance jump; a
 *     player hops it and lets go, and that hop is the arc a coin should sit
 *     on.
 *  2. The trajectory is kept (body position per physics step), not just
 *     reduced to landing spans.
 *
 * Coordinates of everything this module returns are TILE OFFSETS in level
 * convention (x right, y DOWN) relative to the takeoff cell: the empty cell
 * the knight stands in on the last solid tile of the takeoff ledge. A jump of
 * gap `g` (empty columns) to a target `dy` rows lower (negative = higher)
 * lands in cell (g + 1, dy).
 *
 * Pixel frame used internally (identical to the solver's): the takeoff
 * ledge's right face is x = 0, its surface is y = 0, y grows downward.
 * The target platform's left face is x = g*16 and its surface y = dy*16.
 */
import {
  createMovementState,
  GRAVITY_PX,
  PLAYER_BODY_PX,
  PLAYER_PHYSICS,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  TILE,
} from "../../../apps/editor/src/player/playerPhysics";

const BODY_W = PLAYER_BODY_PX.width;
const BODY_H = PLAYER_BODY_PX.height;
/** Phaser's World.TILE_BIAS default (see jumpSolver.ts). */
const TILE_BIAS_PX = 16;
/** Arcade's fixed physics step (see jumpSolver.ts, PHYSICS_DT). */
const PHYSICS_DT = 1 / 60;
/** Render rate the arcs are traced at. Arcs are a design aid; 60 Hz is the reference machine. */
export const ARC_RENDER_DT = 1 / 60;
const MAX_FRAMES = 600;

/** One input recipe for a jump. */
export interface ArcInput {
  /** Flat run-up before the ledge, in tiles (body's leading edge starts this far back). */
  runwayTiles: number;
  /** Render frame the jump is pressed on, relative to the frame the body leaves the ledge. */
  jumpOffsetFrames: number;
  /**
   * Render frames after the jump frame during which right is still held;
   * null = held for the whole flight. After that the stick is neutral and
   * air friction bleeds off horizontal speed.
   */
  airHoldFrames: number | null;
}

/** One physics step of a traced flight, px in the solver's frame. */
export interface FlightStep {
  left: number;
  bottom: number;
  vx: number;
  vy: number;
  /** True once the jump impulse has been applied (false during a coyote run-off). */
  jumped: boolean;
  /** True once the body has lost all contact with the takeoff ledge. */
  offPlatform: boolean;
}

/** A flight from the jump press onward, open sky, no target. */
export interface Flight {
  input: ArcInput;
  steps: FlightStep[];
}

/**
 * Render frame on which a body with this run-up first loses contact with the
 * ledge when simply running right (no jump). Mirrors the solver's probe.
 */
export function ledgeFrame(
  runwayPx: number,
  renderDt: number = ARC_RENDER_DT,
): number {
  const state = createMovementState();
  let left = -(runwayPx + BODY_W);
  let bottom = 0;
  let vx = 0;
  let vy = 0;
  let onGround = true;
  let acc = 0;
  for (let f = 0; f < MAX_FRAMES; f++) {
    const r = stepMovement(
      state,
      { moveInput: 1, jumpHeld: false, jumpJustPressed: false },
      vx,
      vy,
      onGround,
      renderDt,
    );
    vx = r.velocityX;
    vy = r.velocityY;
    acc += renderDt;
    while (acc >= PHYSICS_DT - 1e-9) {
      acc -= PHYSICS_DT;
      vy = Math.min(vy + GRAVITY_PX * PHYSICS_DT, TERMINAL_VELOCITY_PX);
      left += vx * PHYSICS_DT;
      bottom += vy * PHYSICS_DT;
      const supported = left < 0;
      if (supported && bottom >= 0 && vy > 0) {
        bottom = 0;
        vy = 0;
        onGround = true;
      } else {
        onGround = supported && bottom === 0 && vy === 0;
      }
      if (!supported) return f;
    }
  }
  return MAX_FRAMES;
}

/** Render frame on which an arc input presses jump (from a standing start at frame 0). */
export function arcJumpFrame(
  input: ArcInput,
  renderDt = ARC_RENDER_DT,
): number {
  return (
    ledgeFrame(Math.max(0, input.runwayTiles) * TILE, renderDt) +
    input.jumpOffsetFrames
  );
}

/**
 * Trace one jump in open sky. Returns null when the input does not produce a
 * real jump (the press fell outside coyote time) or the knight comes back
 * down on the takeoff ledge (a hop in place is not an arc over a gap).
 *
 * Steps are recorded from the jump's render frame onward and stop once the
 * body is `stopBelowTiles` below the takeoff surface.
 */
export function traceFlight(
  input: ArcInput,
  stopBelowTiles: number,
  renderDt = ARC_RENDER_DT,
): Flight | null {
  const runwayPx = Math.max(0, input.runwayTiles) * TILE;
  const jumpFrame = arcJumpFrame(input, renderDt);
  if (jumpFrame < 0) return null;
  const stopBelowPx = stopBelowTiles * TILE;

  const state = createMovementState();
  let left = -(runwayPx + BODY_W);
  let bottom = 0;
  let vx = 0;
  let vy = 0;
  let onGround = true;
  let prevJumpHeld = false;
  let everOff = false;
  let acc = 0;
  let jumpRenderFrame = -1;
  const steps: FlightStep[] = [];

  for (let f = 0; f < MAX_FRAMES; f++) {
    const jumpHeld = f >= jumpFrame;
    const jumpJustPressed = jumpHeld && !prevJumpHeld;
    prevJumpHeld = jumpHeld;
    let moveInput: 0 | 1 = 1;
    if (
      jumpRenderFrame >= 0 &&
      input.airHoldFrames !== null &&
      f - jumpRenderFrame > input.airHoldFrames
    ) {
      moveInput = 0;
    }

    const r = stepMovement(
      state,
      { moveInput, jumpHeld, jumpJustPressed },
      vx,
      vy,
      onGround,
      renderDt,
    );
    vx = r.velocityX;
    vy = r.velocityY;
    if (r.jumped) jumpRenderFrame = f;
    // The press was made but no jump fired: coyote time already ran out.
    if (f === jumpFrame && !r.jumped) return null;

    acc += renderDt;
    while (acc >= PHYSICS_DT - 1e-9) {
      acc -= PHYSICS_DT;
      vy = Math.min(vy + GRAVITY_PX * PHYSICS_DT, TERMINAL_VELOCITY_PX);
      left += vx * PHYSICS_DT;
      bottom += vy * PHYSICS_DT;
      const supported = left < 0;
      if (supported && bottom >= 0 && vy > 0) {
        bottom = 0;
        vy = 0;
        onGround = true;
        // Came back down on the takeoff ledge after jumping: not an arc.
        if (jumpRenderFrame >= 0) return null;
      } else {
        onGround = supported && bottom === 0 && vy === 0;
      }
      if (!supported) everOff = true;
      // Record from the jump or from running off the ledge, whichever is
      // first: a coyote jump's arc starts with the short dip off the edge.
      if (jumpRenderFrame >= 0 || everOff) {
        steps.push({
          left,
          bottom,
          vx,
          vy,
          offPlatform: everOff,
          jumped: jumpRenderFrame >= 0,
        });
      }
      if (everOff && bottom > stopBelowPx) {
        return jumpRenderFrame >= 0 ? { input, steps } : null;
      }
    }
  }
  return jumpRenderFrame >= 0 ? { input, steps } : null;
}

/** Where a flight lands on a target, if it does. */
export interface Landing {
  /** Index into `flight.steps` of the deciding step. */
  step: number;
  /** Body right edge at the deciding step, px. */
  right: number;
}

/**
 * Does Phaser seat the body on the target's edge tile, or shove it back out
 * of the face? A transcription of `SeparateTile` for a body moving down and
 * right into the top-left tile of a platform (faces top and left exposed),
 * checked against the real code in arcs.test.ts.
 *
 * `a` = how far the body's right edge is past the platform's left face,
 * `sink` = how far its bottom is below the surface, both px.
 *
 * The fork's solver uses the shorter rule `sink <= a`. That is exact for the
 * cases the solver asks about (the deciding step for a gap is at most one
 * step of travel past the face, so `a` is a few px), but an arc that drifts
 * slowly over the lip while still above the surface and then drops onto it
 * arrives with `a` up to a whole body width, where Phaser measures X
 * penetration to the NEARER vertical face of the tile and can shove a body
 * that "sank less than it overlapped". Coins on such an arc would be a lie.
 */
export function seatsOnEdgeTile(a: number, sink: number, vx: number): boolean {
  if (sink <= 0 || sink > TILE_BIAS_PX) return false; // TileCheckY gives up past TILE_BIAS
  if (a >= TILE + BODY_W) return true; // past the edge tile: interior tiles have no side faces
  if (vx === 0) return true; // deltaX = 0: no corner test, vertical-first
  const minX = Math.min(Math.abs(a), Math.abs(TILE + BODY_W - a)); // |right - tileLeft|, |left - tileRight|
  const minY = Math.min(Math.abs(sink), Math.abs(sink - (TILE + BODY_H))); // |bottom - tileTop|, |top - tileBottom|
  if (minX < minY) {
    // X first. TileCheckX ignores overlaps deeper than TILE_BIAS, then Y seats it.
    return a > TILE_BIAS_PX;
  }
  return true;
}

/**
 * For one flight and one target height, which integer gaps does it land, and
 * on which step? Like the solver's `gapSpansFor`, the first step that
 * overlaps the target box decides each gap; whether it seats or shoves is
 * `seatsOnEdgeTile`. Only steps after the jump may land (a coyote run-off
 * that drops straight onto a 1-tile gap's far side is a walk, not an arc).
 */
export function landingsFor(
  flight: Flight,
  dy: number,
  maxGap: number,
): Map<number, Landing> {
  const targetY = dy * TILE;
  const out = new Map<number, Landing>();
  let cursor = -Infinity;
  const steps = flight.steps;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.offPlatform) continue;
    if (s.bottom <= targetY) continue;
    const right = s.left + BODY_W;
    if (right <= cursor) continue;
    const sink = s.bottom - targetY;
    if (s.jumped && s.vy > 0) {
      const gLo = Math.max(1, Math.floor(cursor / TILE) + 1);
      const gHi = Math.min(maxGap, Math.floor((right - 1e-9) / TILE));
      for (let g = gLo; g <= gHi; g++) {
        const face = g * TILE;
        if (face <= cursor || face >= right || out.has(g)) continue;
        if (seatsOnEdgeTile(right - face, sink, s.vx))
          out.set(g, { step: i, right });
      }
    }
    cursor = right;
  }
  return out;
}

/** Tile column/row offset of a px coordinate, relative to the takeoff cell. */
const cellX = (px: number) => Math.floor(px / TILE) + 1;
const cellY = (px: number) => Math.floor(px / TILE) + 1;

export interface TracedArc {
  gap: number;
  dy: number;
  input: ArcInput;
  /**
   * Airborne cells the body's CENTRE passes through, in flight order, as
   * [x, y] offsets. A coin in any of these is collected by the jump. Cells on
   * the takeoff row over the ledge and on the landing row over the target are
   * left out: a coin there is a coin on the floor.
   */
  cells: [number, number][];
  /**
   * Every cell the body's 10x14 box touches in flight, as per-column
   * vertical spans [x, yMin, yMax]. Anything solid in here clips the jump;
   * the validator uses it as the headroom check.
   */
  sweep: [number, number, number][];
  /**
   * One coin per gap column (x = 1..gap): the cell the body's centre is in
   * when it crosses that column's centre line. The classic coin arc.
   */
  coins: [number, number][];
  /** Highest row offset the body's centre reaches (most negative y). */
  apexDy: number;
  /** Landing centre minus the target's leading face, px. */
  overshootPx: number;
}

/** Desired landing: body centre this many px past the target's leading face. */
const IDEAL_OVERSHOOT_PX = 10;

/**
 * How "natural" a jump is as THE arc for a gap. Lower is better:
 *  - land on the first target tile, not deep onto the platform or on its lip;
 *  - prefer holding right the whole way (no mid-air release);
 *  - prefer pressing jump right at the ledge.
 */
function arcCost(input: ArcInput, overshootPx: number): number {
  return (
    Math.abs(overshootPx - IDEAL_OVERSHOOT_PX) +
    (input.airHoldFrames === null ? 0 : 3) +
    Math.abs(input.jumpOffsetFrames) * 1.5 +
    input.runwayTiles * 0.25
  );
}

/** Input grid searched for arcs. */
export function arcInputGrid(maxRunwayTiles: number): ArcInput[] {
  const inputs: ArcInput[] = [];
  const coyoteFrames = Math.ceil(PLAYER_PHYSICS.COYOTE_TIME / ARC_RENDER_DT);
  for (let r4 = 0; r4 <= maxRunwayTiles * 4; r4++) {
    // Short run-ups also try pressing jump well before the edge (down to a
    // jump from a standstill): that is the only way onto a high ledge
    // across a narrow gap, where a moving takeoff smacks into its face.
    const earliest = r4 <= 4 ? -16 : -3;
    for (let off = earliest; off <= coyoteFrames; off++) {
      inputs.push({
        runwayTiles: r4 / 4,
        jumpOffsetFrames: off,
        airHoldFrames: null,
      });
      for (let h = 0; h <= 40; h++) {
        inputs.push({
          runwayTiles: r4 / 4,
          jumpOffsetFrames: off,
          airHoldFrames: h,
        });
      }
    }
  }
  return inputs;
}

function arcFromLanding(
  flight: Flight,
  gap: number,
  dy: number,
  landing: Landing,
): TracedArc {
  const targetY = dy * TILE;
  const cells: [number, number][] = [];
  const seen = new Set<string>();
  const sweepCols = new Map<number, [number, number]>();
  let apexDy = 0;

  const visit = (left: number, bottom: number) => {
    const cx = cellX(left + BODY_W / 2);
    const cy = cellY(bottom - BODY_H / 2);
    if (cy < apexDy) apexDy = cy;
    const onTakeoffFloor = cy === 0 && cx <= 0;
    const onLandingFloor = cy === dy && cx >= gap + 1;
    const key = `${cx},${cy}`;
    if (!onTakeoffFloor && !onLandingFloor && !seen.has(key)) {
      seen.add(key);
      cells.push([cx, cy]);
    }
    const x0 = cellX(left);
    const x1 = cellX(left + BODY_W - 1e-6);
    const y0 = cellY(bottom - BODY_H);
    const y1 = cellY(bottom - 1e-6);
    for (let x = x0; x <= x1; x++) {
      const span = sweepCols.get(x);
      if (!span) sweepCols.set(x, [y0, y1]);
      else {
        span[0] = Math.min(span[0], y0);
        span[1] = Math.max(span[1], y1);
      }
    }
  };

  const path: { cx: number; cy: number }[] = [];
  for (let i = 0; i < landing.step; i++) {
    const st = flight.steps[i];
    visit(st.left, st.bottom);
    path.push({ cx: st.left + BODY_W / 2, cy: st.bottom - BODY_H / 2 });
  }
  // The deciding step seats the body on the target surface.
  const last = flight.steps[landing.step];
  visit(last.left, targetY);
  path.push({ cx: last.left + BODY_W / 2, cy: targetY - BODY_H / 2 });

  // Coins: where the centre crosses each gap column's centre line.
  const coins: [number, number][] = [];
  for (let x = 1; x <= gap; x++) {
    const line = (x - 1) * TILE + TILE / 2;
    // A late (coyote) jump can leave the ground already past the first
    // column's centre; its coin goes where the jump starts.
    if (path[0].cx >= line) {
      coins.push([x, cellY(path[0].cy)]);
      continue;
    }
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (a.cx < line && b.cx >= line) {
        const t = (line - a.cx) / (b.cx - a.cx);
        coins.push([x, cellY(a.cy + (b.cy - a.cy) * t)]);
        break;
      }
    }
  }

  const sweep = [...sweepCols.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, [a, b]]) => [x, a, b] as [number, number, number]);
  const overshootPx = landing.right - BODY_W / 2 - gap * TILE;
  return {
    gap,
    dy,
    input: flight.input,
    cells,
    sweep,
    coins,
    apexDy,
    overshootPx,
  };
}

/**
 * Pick the most natural traced arc for every (gap, dy) pair requested.
 *
 * `wanted(dy)` gives the largest gap to produce an arc for at that dy (0 or
 * less = none). Flights are traced once and shared across every target, so
 * the whole table is a few million cheap physics steps.
 */
export function traceArcs(
  dys: readonly number[],
  wanted: (dy: number) => number,
  maxRunwayTiles: number,
): TracedArc[] {
  const maxDy = Math.max(...dys);
  const flights: Flight[] = [];
  for (const input of arcInputGrid(maxRunwayTiles)) {
    const fl = traceFlight(input, Math.max(maxDy, 0) + 2);
    if (fl) flights.push(fl);
  }

  const out: TracedArc[] = [];
  for (const dy of dys) {
    const gMax = wanted(dy);
    if (gMax < 1) continue;
    const best = new Map<
      number,
      { cost: number; flight: Flight; landing: Landing }
    >();
    for (const fl of flights) {
      for (const [g, landing] of landingsFor(fl, dy, gMax)) {
        const overshoot = landing.right - BODY_W / 2 - g * TILE;
        const cost = arcCost(fl.input, overshoot);
        const cur = best.get(g);
        if (!cur || cost < cur.cost) best.set(g, { cost, flight: fl, landing });
      }
    }
    for (let g = 1; g <= gMax; g++) {
      const b = best.get(g);
      if (b) out.push(arcFromLanding(b.flight, g, dy, b.landing));
    }
  }
  return out;
}
