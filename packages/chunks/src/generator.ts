/**
 * Seeded chunk generator: a TypeScript port of the audit's
 * audit-prototypes/generators/chunkgen.py (G-34).
 *
 * A section is laid out left to right from parameterised pieces (flat run,
 * pit, step, platform over a pit, coin arc), each bounded by the jump caps
 * given the run-up the previous piece leaves. With a profile from
 * `profileFor(difficulty, theme)` and the default options the output is
 * identical to `chunkgen.gen(...)` for the same seed (parity.test.ts checks
 * it against the Python on recorded seeds). The extra StyleProfile fields
 * (fill depth, coin probability and spacing, step-up odds, platform sizes)
 * default to the Python's constants and never change the random stream, so
 * they reshape a chunk without breaking reproducibility.
 *
 * Grid: row-major 0/1 (1 solid), y down. `ground` is the SURFACE row (the top
 * solid row); the knight stands at ground - 1.
 */
import type { Point } from "../../../apps/editor/src/contracts";
import { capsFor, fullRunway, ladderGap, type Caps } from "./caps";
import { PyRandom } from "./rng";

export const PIECE_KINDS = ["flat", "pit", "step", "platform_over_pit", "coin_row"] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

export const THEMES: Record<"mixed" | "timing" | "reward" | "breather", PieceKind[]> = {
  mixed: ["flat", "pit", "step", "platform_over_pit", "coin_row"],
  timing: ["pit", "pit", "step", "platform_over_pit"],
  reward: ["coin_row", "platform_over_pit", "flat", "pit"],
  breather: ["flat", "coin_row", "step"],
};
export type Theme = keyof typeof THEMES;
export type Difficulty = 1 | 2 | 3 | 4 | 5;

/** Everything that shapes a chunk. Ranges are inclusive [lo, hi]. */
export interface StyleProfile {
  /** Pieces to draw from; repeat a kind to weight it. */
  kinds: PieceKind[];
  /** Pit width range (empty columns); also bounded by the run-up ladder. */
  gap: [number, number];
  /** Step height range (rows). */
  rise: [number, number];
  /** Chance a flat-run column (in runs of 3+) gets a slime; decays x0.6 per slime. */
  enemyP: number;
  /** Chance a step goes up rather than down (Python 0.6). */
  upP?: number;
  /** Chance each platform tile gets a coin above it (Python 0.7). */
  coinP?: number;
  /**
   * Coin-arc spacing: a coin on every `coinEvery`-th column of an arc
   * (Python 1). Larger values give sparser rewards (reward spacing).
   */
  coinEvery?: number;
  /** Solid rows from the surface down (density); Infinity = to the bottom (Python). */
  fillDepth?: number;
  /** Width range of a platform-over-pit piece (Python [5, 9]). */
  platformWidth?: [number, number];
  /** Platform height above the ground, rows (Python [2, 3]). */
  platformRise?: [number, number];
  /** Optional name for logs and labels. */
  name?: string;
}

export interface GenerateOptions {
  /** Columns (default 24) and rows (default 12). */
  w?: number;
  h?: number;
  /** Surface row of the start (default 8). */
  ground?: number;
  seed?: number;
  /** Style profile (default profileFor(2, "mixed")). */
  profile?: StyleProfile;
  /** Jump caps (default capsFor("NORMAL") from @jump-tables). */
  caps?: Caps;
  /** Flat safe columns at the start (default 3) and the end (default 3). */
  startRun?: number;
  endRun?: number;
}

/** One laid-out piece, chunk-relative columns [x0, x1]. */
export interface Piece {
  kind: PieceKind;
  x0: number;
  x1: number;
  /** Surface row the piece ends on. */
  y: number;
  /** Pit width, step height (signed, negative = up), platform width or coin count. */
  size: number;
  desc: string;
}

export interface GeneratedChunk {
  w: number;
  h: number;
  ground: number;
  seed: number;
  /** Row-major solid mask (1 solid). */
  grid: Uint8Array;
  /** Surface row per column, null = pit. Platforms over pits are not surfaces here. */
  heights: (number | null)[];
  /** Platform tiles (solid cells not part of a column fill). */
  platforms: Point[];
  /** Coins and slimes in placement order (coins may have y = -1 like the Python; see inside()). */
  coins: Point[];
  slimes: Point[];
  /** chunkgen's description list, e.g. ["pit 3", "step up 1"]. */
  desc: string[];
  pieces: Piece[];
  /** Surface row of the last column. */
  endY: number;
  profile: StyleProfile;
}

const GAP_BY_DIFFICULTY = (maxgap: number): Record<Difficulty, [number, number]> => ({
  1: [2, 3],
  2: [2, 4],
  3: [3, 6],
  4: [5, 8],
  5: [7, maxgap],
});
const STEP_BY_DIFFICULTY: Record<Difficulty, [number, number]> = { 1: [1, 1], 2: [1, 2], 3: [1, 3], 4: [2, 4], 5: [3, 5] };
const ENEMY_BY_DIFFICULTY: Record<Difficulty, number> = { 1: 0.0, 2: 0.15, 3: 0.3, 4: 0.45, 5: 0.6 };

/** chunkgen's difficulty x theme table as a profile. */
export function profileFor(difficulty: Difficulty = 2, theme: Theme = "mixed", caps: Caps = capsFor()): StyleProfile {
  const d = Math.max(1, Math.min(5, Math.round(difficulty))) as Difficulty;
  const maxgap = ladderGap(caps, fullRunway(caps));
  return {
    name: `d${d}-${theme}`,
    kinds: [...THEMES[theme]],
    gap: [...GAP_BY_DIFFICULTY(maxgap)[d]] as [number, number],
    rise: [...STEP_BY_DIFFICULTY[d]] as [number, number],
    enemyP: ENEMY_BY_DIFFICULTY[d],
  };
}

const idx = (w: number, x: number, y: number) => y * w + x;

/**
 * Generate one chunk. Deterministic for (options, seed). Matches
 * chunkgen.gen(W=w, H=h, difficulty, theme, seed, ground) when the profile
 * comes from profileFor and no extra profile fields are set.
 */
export function generateChunk(opts: GenerateOptions = {}): GeneratedChunk {
  const W = opts.w ?? 24;
  const H = opts.h ?? 12;
  const caps = opts.caps ?? capsFor();
  const profile = opts.profile ?? profileFor(2, "mixed", caps);
  const seed = opts.seed ?? 0;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 2) throw new RangeError(`bad chunk size ${W}x${H}`);
  if (profile.kinds.length === 0) throw new RangeError("profile.kinds is empty");
  const startRun = opts.startRun ?? 3;
  const endRun = opts.endRun ?? 3;
  const upP = profile.upP ?? 0.6;
  const coinP = profile.coinP ?? 0.7;
  const coinEvery = Math.max(1, Math.floor(profile.coinEvery ?? 1));
  const fillDepth = profile.fillDepth ?? Infinity;
  const [pw0, pw1] = profile.platformWidth ?? [5, 9];
  const [pr0, pr1] = profile.platformRise ?? [2, 3];
  const maxRun = fullRunway(caps);

  const rnd = new PyRandom(seed);
  const grid = new Uint8Array(W * H);
  const heights: (number | null)[] = new Array(W).fill(null);
  const platforms: Point[] = [];
  const coins: Point[] = [];
  const slimes: Point[] = [];
  const desc: string[] = [];
  const pieces: Piece[] = [];
  const [gapLo, gapHi] = profile.gap;
  let enemyP = profile.enemyP;
  let x = 0;
  let y = opts.ground ?? 8;
  if (!Number.isInteger(y) || y < 0 || y >= H) throw new RangeError(`ground ${y} is outside 0..${H - 1}`);

  const putCol = (cx: number, surf: number | null) => {
    if (cx < 0 || cx >= W) return;
    heights[cx] = surf;
    if (surf === null) return;
    const bottom = Math.min(H, surf + fillDepth);
    for (let yy = Math.max(0, surf); yy < bottom; yy++) grid[idx(W, cx, yy)] = 1;
  };
  const piece = (kind: PieceKind, x0: number, size: number, d: string) => {
    desc.push(d);
    pieces.push({ kind, x0, x1: x - 1, y, size, desc: d });
  };

  for (let i = 0; i < startRun; i++) {
    putCol(x, y);
    x++;
  }
  while (x < W - endRun) {
    const kind = rnd.choice(profile.kinds);
    const room = W - endRun - x;
    const x0 = x;
    if (kind === "flat") {
      const n = Math.min(room, rnd.randint(2, 4));
      for (let i = 0; i < n; i++) {
        putCol(x, y);
        if (rnd.random() < enemyP && n >= 3) {
          slimes.push({ x, y: y - 1 });
          enemyP *= 0.6;
        }
        x++;
      }
      piece("flat", x0, n, `flat ${n}`);
    } else if (kind === "pit" && room >= 4) {
      let runway = 0;
      let k = x - 1;
      while (k >= 0 && heights[k] === y && runway < maxRun) {
        runway++;
        k--;
      }
      const lim = Math.min(ladderGap(caps, runway), room - 2);
      const w = lim >= 2 ? rnd.randint(Math.min(gapLo, lim), Math.min(gapHi, lim)) : 0;
      if (w < 2) {
        putCol(x, y);
        x++;
        continue;
      }
      for (let i = 0; i < w; i++) {
        putCol(x, null);
        x++;
      }
      for (let i = 0; i < 2; i++) {
        putCol(x, y);
        x++;
      }
      piece("pit", x0, w, `pit ${w}`);
    } else if (kind === "step" && room >= 3) {
      const up = rnd.random() < upP;
      const dh = rnd.randint(profile.rise[0], profile.rise[1]);
      let ny = up ? y - dh : y + dh;
      ny = Math.max(3, Math.min(H - 2, ny));
      if (up && y - ny > caps.maxStepUp) ny = y - Math.trunc(caps.maxStepUp);
      const dy = ny - y;
      y = ny;
      for (let i = 0; i < Math.min(room, 3); i++) {
        putCol(x, y);
        x++;
      }
      piece("step", x0, dy, `step ${up ? "up" : "down"} ${dh}`);
    } else if (kind === "platform_over_pit" && room >= 7) {
      const w = rnd.randint(pw0, Math.min(pw1, room - 2));
      const px0 = x + Math.floor((w - 3) / 2);
      const ph = y - rnd.randint(pr0, pr1);
      for (let i = 0; i < w; i++) {
        putCol(x, null);
        if (px0 <= x && x < px0 + 3) {
          if (ph >= 0) {
            grid[idx(W, x, ph)] = 1;
            platforms.push({ x, y: ph });
          }
          if (rnd.random() < coinP) coins.push({ x, y: ph - 1 });
        }
        x++;
      }
      for (let i = 0; i < 2; i++) {
        putCol(x, y);
        x++;
      }
      piece("platform_over_pit", x0, w, `platform over ${w}-wide pit`);
    } else if (kind === "coin_row" && room >= 3) {
      const n = Math.min(room, rnd.randint(3, 5));
      for (let i = 0; i < n; i++) {
        putCol(x, y);
        if (i % coinEvery === 0) coins.push({ x, y: y - 2 - (0 < i && i < n - 1 ? 1 : 0) });
        x++;
      }
      piece("coin_row", x0, n, `coin arc ${n}`);
    } else {
      putCol(x, y);
      x++;
    }
  }
  while (x < W) {
    putCol(x, y);
    x++;
  }
  return { w: W, h: H, ground: opts.ground ?? 8, seed, grid, heights, platforms, coins, slimes, desc, pieces, endY: y, profile };
}

/** Is a chunk-relative point inside the chunk? (The Python can emit a coin at y = -1.) */
export const inside = (c: Pick<GeneratedChunk, "w" | "h">, p: Point): boolean =>
  p.x >= 0 && p.y >= 0 && p.x < c.w && p.y < c.h;

export const isSolidAt = (c: Pick<GeneratedChunk, "w" | "h" | "grid">, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < c.w && y < c.h && c.grid[idx(c.w, x, y)] === 1;

/** ASCII rows like chunkgen's __main__ print: # solid, c coin, s slime, . empty. */
export function chunkRows(c: GeneratedChunk): string[] {
  const coin = new Set(c.coins.map((p) => `${p.x},${p.y}`));
  const slime = new Set(c.slimes.map((p) => `${p.x},${p.y}`));
  const rows: string[] = [];
  for (let y = 0; y < c.h; y++) {
    let s = "";
    for (let x = 0; x < c.w; x++)
      s += c.grid[idx(c.w, x, y)] ? "#" : coin.has(`${x},${y}`) ? "c" : slime.has(`${x},${y}`) ? "s" : ".";
    rows.push(s);
  }
  return rows;
}

export interface ChunkMetrics {
  pits: number[];
  maxPit: number;
  coins: number;
  slimes: number;
}

/** chunkgen.metrics: widths of fully empty column runs (pits), coin and slime counts. */
export function chunkMetrics(c: GeneratedChunk): ChunkMetrics {
  const pits: number[] = [];
  let run: number | null = null;
  for (let x = 0; x < c.w; x++) {
    let empty = true;
    for (let y = 0; y < c.h && empty; y++) if (c.grid[idx(c.w, x, y)]) empty = false;
    if (empty && run === null) run = x;
    if (!empty && run !== null) {
      pits.push(x - run);
      run = null;
    }
  }
  return { pits, maxPit: pits.length ? Math.max(...pits) : 0, coins: c.coins.length, slimes: c.slimes.length };
}

/** Pattern-like tags for a chunk (measure's vocabulary where it fits, plus piece kinds). */
export function chunkTags(c: Pick<GeneratedChunk, "pieces" | "coins" | "slimes">): string[] {
  const tags = new Set<string>();
  let pits = 0;
  let ups = 0;
  for (const p of c.pieces) {
    if (p.kind === "pit") pits++;
    if (p.kind === "step") {
      tags.add("step");
      if (p.size < 0) ups++;
    }
    if (p.kind === "platform_over_pit") tags.add("pillar-hop").add("platform");
    if (p.kind === "coin_row") tags.add("coin-arc");
    if (p.kind === "flat" && p.size >= 4) tags.add("rest");
  }
  if (pits) tags.add("pit");
  if (pits >= 2) tags.add("gap-run");
  if (ups >= 2) tags.add("rising-steps");
  if (c.slimes.length) tags.add("enemy");
  return [...tags];
}
