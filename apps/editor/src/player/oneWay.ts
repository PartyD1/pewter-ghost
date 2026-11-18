/**
 * One-way platforms (the "Grass half" tile), pure rules with no Phaser
 * import. Play (editor/render.ts faces, editor/play.ts collider) and the
 * playtest agent (packages/physsim sim.ts) both use these, so the agent's
 * routes still replay frame for frame in the game.
 *
 * - From below and from the sides the knight passes through.
 * - It can stand on top: a one-way tile collides on its top face only, and
 *   only in a physics step where the body moves down and its bottom was at or
 *   above the tile's top before the step (`oneWayCatches`). A knight whose
 *   jump ends with its feet still inside the platform falls back down instead
 *   of popping up onto it.
 * - Holding down while standing on one drops through it: for that step
 *   one-way tiles are ignored (`dropping`). After that step the feet are
 *   already below the top, so the rule above lets the knight fall on. Full
 *   solid tiles still hold it, so standing partly on solid ground there is no
 *   drop.
 */

/** Cell kinds for collision. Outside the level counts as empty. */
export const CELL_EMPTY = 0;
export const CELL_SOLID = 1;
export const CELL_ONE_WAY = 2;
export type CellKind = typeof CELL_EMPTY | typeof CELL_SOLID | typeof CELL_ONE_WAY;

/** Face bits: 1 top, 2 bottom, 4 left, 8 right. */
export const FACE_TOP = 1;
export const FACE_BOTTOM = 2;
export const FACE_LEFT = 4;
export const FACE_RIGHT = 8;

/**
 * Slack, px, for "the feet were at or above the top". Standing leaves the
 * bottom within float error of the top; the first step of a drop falls
 * GRAVITY/60² ≈ 0.42 px, well past it.
 */
export const ONE_WAY_EPS_PX = 0.01;

/**
 * Exposed collision faces of the tile at (x, y), replacing Phaser's
 * CalculateFacesWithin (which treats every colliding tile alike):
 *  - solid: top and bottom exposed unless that neighbour is solid (a one-way
 *    neighbour leaves them exposed, so you can't drop into a block below a
 *    platform or jump into one above it); left and right exposed only toward
 *    an empty cell (a one-way neighbour hides them, as Phaser would, so
 *    walking off a platform onto ground at the same height never snags on
 *    the ground's side);
 *  - one-way: top only, and only when the cell above is empty (a stack of
 *    platforms acts as one);
 *  - empty: none.
 */
export function tileFaces(kind: (x: number, y: number) => CellKind, x: number, y: number): number {
  const k = kind(x, y);
  if (k === CELL_EMPTY) return 0;
  if (k === CELL_ONE_WAY) return kind(x, y - 1) === CELL_EMPTY ? FACE_TOP : 0;
  let f = 0;
  if (kind(x, y - 1) !== CELL_SOLID) f |= FACE_TOP;
  if (kind(x, y + 1) !== CELL_SOLID) f |= FACE_BOTTOM;
  if (kind(x - 1, y) === CELL_EMPTY) f |= FACE_LEFT;
  if (kind(x + 1, y) === CELL_EMPTY) f |= FACE_RIGHT;
  return f;
}

/**
 * Whether a one-way tile with top `tileTop` stops a body this step:
 * moving down (`dy` = this step's y delta), feet at or above the top before
 * the step (`prevBottom`), and not dropping through.
 */
export function oneWayCatches(prevBottom: number, dy: number, tileTop: number, dropping: boolean): boolean {
  return !dropping && dy > 0 && prevBottom <= tileTop + ONE_WAY_EPS_PX;
}

/** The knight drops through one-way tiles on a step where down is held and it stood on the ground. */
export function isDropping(downHeld: boolean, onGround: boolean): boolean {
  return downHeld && onGround;
}
