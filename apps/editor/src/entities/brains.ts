/**
 * Enemy behaviour (G-06), pure and time-based.
 *
 * The old Slime/UltraSlime counted FRAMES (fire every 100 / 50 frames), so on
 * a 144 Hz screen they fired 2.4x as often. These brains take elapsed
 * milliseconds and return a horizontal velocity plus the shots to fire this
 * step; the Phaser sprites (Slime.ts, UltraSlime.ts) apply them. Positions
 * are world pixels of the sprite centre. Patrol spans come from the level
 * model (entity.patrol, inclusive tiles of the floor the enemy stands on), so
 * an enemy never leaves the span the model and the validator reason about.
 */
import type { EnemyTuning } from "../editor/playSettings";

export const ENEMY_TILE_PX = 16;

export interface Shot {
  /** -1 left, 1 right. */
  dir: 1 | -1;
  /** Mega pellets are bigger and a bit faster. */
  mega: boolean;
}

export interface BrainStep {
  vx: number;
  facing: 1 | -1;
  shots: Shot[];
  /** UltraSlime: the burst is about to start (draw a tell). */
  warning?: boolean;
}

/** Patrol span [left, right] in tiles -> allowed centre x range in px. */
export function patrolRangePx(patrol: [number, number] | undefined, spawnX: number, tilePx = ENEMY_TILE_PX): [number, number] {
  if (!patrol) return [spawnX, spawnX];
  return [patrol[0] * tilePx + tilePx / 2, patrol[1] * tilePx + tilePx / 2];
}

// ---------------------------------------------------------------------------
// Slime: walks its whole floor back and forth, fires straight ahead.
// ---------------------------------------------------------------------------

export const SLIME = {
  /** px/s (old: 20). */
  speed: 20,
  /** ms between shots (old: 100 frames = 1667 ms at 60 Hz). */
  fireIntervalMs: 1667,
  pelletSpeed: 100,
  pelletLifeMs: 2000,
  damage: 1,
  health: 10,
} as const;

export interface SlimeState {
  dir: 1 | -1;
  fireTimerMs: number;
}

export const createSlimeState = (): SlimeState => ({ dir: 1, fireTimerMs: 0 });

/**
 * Advance a slime by `dtMs`. `x` is its current centre; `range` the allowed
 * centre range from the patrol span. Fires at most one shot per step.
 */
export function stepSlime(state: SlimeState, dtMs: number, x: number, range: [number, number], tuning: EnemyTuning): BrainStep {
  const dt = Math.max(0, dtMs);
  const [lo, hi] = range;
  const shots: Shot[] = [];
  if (hi - lo < 0.5) {
    // No floor to walk (or a one-tile ledge): stand still.
    state.dir = state.dir || 1;
  } else if (state.dir > 0 && x >= hi) state.dir = -1;
  else if (state.dir < 0 && x <= lo) state.dir = 1;

  if (tuning.fireMul > 0) {
    state.fireTimerMs += dt;
    const interval = SLIME.fireIntervalMs / tuning.fireMul;
    if (state.fireTimerMs >= interval) {
      state.fireTimerMs -= interval;
      if (state.fireTimerMs > interval) state.fireTimerMs = interval * 0.5; // never queue a volley after a stall
      shots.push({ dir: state.dir, mega: false });
    }
  }
  const vx = hi - lo < 0.5 ? 0 : SLIME.speed * tuning.speedMul * state.dir;
  return { vx, facing: state.dir, shots };
}

// ---------------------------------------------------------------------------
// UltraSlime, softened (plan G-06: "Soften the UltraSlime for students").
// Old: chased the knight anywhere at 35 px/s, fired every 50 frames and
// spent half its time in a rapid-fire phase with 2-damage mega pellets.
// New: chases only when the knight is near and on roughly its level, never
// leaves its floor, telegraphs every burst for 600 ms, and a burst is three
// 1-damage mega pellets; between bursts it fires slowly.
// ---------------------------------------------------------------------------

export const ULTRA = {
  speed: 26,
  patrolSpeed: 14,
  /** Chase only within this horizontal distance (px) ... */
  chaseRangePx: 8 * ENEMY_TILE_PX,
  /** ... and this vertical distance (px). */
  chaseHeightPx: 3 * ENEMY_TILE_PX,
  fireIntervalMs: 1800,
  /** Calm time between bursts. */
  burstEveryMs: 5000,
  warnMs: 600,
  burstShots: 3,
  burstGapMs: 300,
  pelletSpeed: 110,
  megaPelletSpeed: 120,
  pelletLifeMs: 2000,
  damage: 1,
  megaDamage: 1,
  health: 20,
} as const;

export type UltraPhase = "calm" | "warn" | "burst";

export interface UltraState {
  dir: 1 | -1;
  phase: UltraPhase;
  phaseMs: number;
  fireTimerMs: number;
  burstLeft: number;
}

export const createUltraState = (): UltraState => ({ dir: 1, phase: "calm", phaseMs: 0, fireTimerMs: 0, burstLeft: 0 });

export function stepUltraSlime(
  state: UltraState,
  dtMs: number,
  pos: { x: number; y: number },
  player: { x: number; y: number } | undefined,
  range: [number, number],
  tuning: EnemyTuning,
): BrainStep {
  const dt = Math.max(0, dtMs);
  const [lo, hi] = range;
  const shots: Shot[] = [];
  const canWalk = hi - lo >= 0.5;

  const dx = player ? player.x - pos.x : 0;
  const near =
    !!player && tuning.chase && Math.abs(dx) <= ULTRA.chaseRangePx && Math.abs(player.y - pos.y) <= ULTRA.chaseHeightPx;

  let vx = 0;
  if (near) {
    state.dir = dx >= 0 ? 1 : -1;
    const want = ULTRA.speed * tuning.speedMul * state.dir;
    // Stay on the floor: stop at the span edge instead of walking off it.
    if (canWalk && !((state.dir > 0 && pos.x >= hi) || (state.dir < 0 && pos.x <= lo)) && Math.abs(dx) > 2) vx = want;
  } else if (canWalk) {
    if (state.dir > 0 && pos.x >= hi) state.dir = -1;
    else if (state.dir < 0 && pos.x <= lo) state.dir = 1;
    vx = ULTRA.patrolSpeed * tuning.speedMul * state.dir;
  }

  let warning = false;
  if (tuning.fireMul > 0) {
    const rate = tuning.fireMul;
    state.phaseMs += dt;
    if (state.phase === "calm") {
      state.fireTimerMs += dt;
      const interval = ULTRA.fireIntervalMs / rate;
      if (state.fireTimerMs >= interval) {
        state.fireTimerMs = Math.min(state.fireTimerMs - interval, interval * 0.5);
        shots.push({ dir: state.dir, mega: false });
      }
      if (state.phaseMs >= ULTRA.burstEveryMs / rate) {
        state.phase = "warn";
        state.phaseMs = 0;
      }
    } else if (state.phase === "warn") {
      warning = true;
      vx = 0; // stands still while it winds up: a fair tell
      if (state.phaseMs >= ULTRA.warnMs) {
        state.phase = "burst";
        state.phaseMs = ULTRA.burstGapMs; // first burst shot fires immediately
        state.burstLeft = ULTRA.burstShots;
      }
    } else {
      vx = 0;
      if (state.phaseMs >= ULTRA.burstGapMs && state.burstLeft > 0) {
        state.phaseMs = 0;
        state.burstLeft--;
        shots.push({ dir: state.dir, mega: true });
      }
      if (state.burstLeft === 0) {
        state.phase = "calm";
        state.phaseMs = 0;
        state.fireTimerMs = 0;
      }
    }
  }
  return { vx, facing: state.dir, shots, warning };
}

/** Did a falling knight land on the enemy's head (stomp) rather than touch its side? */
export function isStomp(
  player: { bottom: number; vy: number; prevBottom?: number },
  enemyTop: number,
  tolerancePx = 6,
): boolean {
  if (player.vy <= 0) return false;
  const prev = player.prevBottom ?? player.bottom;
  return prev <= enemyTop + tolerancePx;
}
