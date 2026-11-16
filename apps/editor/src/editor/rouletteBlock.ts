/**
 * Roulette Block: what the question block does in Play.
 *
 * The block's face cycles coin -> fruit -> slime. Hit it from below and you
 * get whatever is showing at that moment: a coin, a heart back, or a slime
 * that drops out of it. Each block pays out once per attempt (it comes back
 * when the knight respawns, like coins do).
 *
 * The block is solid before and after, so the jump tables, the validator, the
 * playtest agent and every filler see the same level they always did. The
 * face is a function of the Play clock and the block's position (no random
 * numbers), so tests and session replays are exact.
 *
 * Pure: no Phaser. play.ts owns the sprites.
 */

export type RouletteFace = "coin" | "fruit" | "slime";

export const ROULETTE = {
  /** The cycle, in order. */
  faces: ["coin", "fruit", "slime"] as readonly RouletteFace[],
  /** How long each face shows. */
  faceMs: 600,
} as const;

/** A whole turn of the cycle. */
export const ROULETTE_CYCLE_MS = ROULETTE.faces.length * ROULETTE.faceMs;

/**
 * Where in the cycle the block at (x, y) starts. Neighbours start on different
 * faces, so a row of blocks does not flash in step and each one has to be read
 * on its own.
 */
export function facePhase(x: number, y: number): number {
  const n = ROULETTE.faces.length;
  return (((x + 2 * y) % n) + n) % n;
}

/** The face the block at (x, y) shows `elapsedMs` into Play. */
export function faceAt(elapsedMs: number, x: number, y: number): RouletteFace {
  const n = ROULETTE.faces.length;
  const step = Math.floor(Math.max(0, elapsedMs) / ROULETTE.faceMs);
  return ROULETTE.faces[(step + facePhase(x, y)) % n];
}

/** Body edges in world px (Arcade body.left / right / top). */
export interface HeadBox {
  left: number;
  right: number;
  top: number;
}

/**
 * The question block a rising body just hit with its head, or undefined.
 * Call it when the body is blocked from above: its top then rests against the
 * underside of the row it hit. When the head spans two blocks the one it
 * overlaps more is hit (the left one on an exact tie).
 */
export function bumpTarget(
  head: HeadBox,
  isQuestion: (x: number, y: number) => boolean,
  tilePx: number,
): { x: number; y: number } | undefined {
  const y = Math.floor((head.top - 1) / tilePx);
  const x0 = Math.floor(head.left / tilePx);
  const x1 = Math.floor((head.right - 1) / tilePx);
  let best: { x: number; y: number } | undefined;
  let bestOverlap = 0;
  for (let x = x0; x <= x1; x++) {
    if (!isQuestion(x, y)) continue;
    const overlap = Math.min(head.right, (x + 1) * tilePx) - Math.max(head.left, x * tilePx);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = { x, y };
    }
  }
  return best;
}

/**
 * Where a slime that drops out of the block at (x, y) appears: on top of the
 * block, or underneath it (on the knight) when the top is covered.
 */
export function slimeCell(x: number, y: number, isSolid: (x: number, y: number) => boolean): { x: number; y: number } {
  return y - 1 >= 0 && !isSolid(x, y - 1) ? { x, y: y - 1 } : { x, y: y + 1 };
}

export type BumpCounts = Record<RouletteFace, number>;

/** Which blocks have paid out in this attempt, and what came out over the whole Play. */
export class RouletteBlocks {
  private readonly used = new Set<string>();
  private readonly totals: BumpCounts = { coin: 0, fruit: 0, slime: 0 };

  private static key(x: number, y: number): string {
    return `${x},${y}`;
  }

  isUsed(x: number, y: number): boolean {
    return this.used.has(RouletteBlocks.key(x, y));
  }

  /** Hit the block: the face it pays out, or undefined when it is already spent. */
  bump(x: number, y: number, elapsedMs: number): RouletteFace | undefined {
    const k = RouletteBlocks.key(x, y);
    if (this.used.has(k)) return undefined;
    this.used.add(k);
    const face = faceAt(elapsedMs, x, y);
    this.totals[face]++;
    return face;
  }

  /** New attempt (the knight respawned): every block pays out again. Totals stay. */
  refill(): void {
    this.used.clear();
  }

  /** Payouts since this object was made, by face. */
  get counts(): BumpCounts {
    return { ...this.totals };
  }
}
