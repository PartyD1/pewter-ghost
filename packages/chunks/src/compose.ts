/**
 * Section composer: the rule-based generator behind the algorithm filler's
 * Extend (the "no AI" study condition). Hand-written pieces, a seeded random
 * generator and the knight's jump caps; no training data and no learned
 * weights anywhere.
 *
 * It grows a section left to right like generator.ts (the port of the
 * audit's chunkgen.py, kept untouched for parity with the Python), with
 * three additions:
 *
 *  - A wider piece grammar. Besides the port's flat run, pit, step, platform
 *    over a pit and coin arc: stairs, a raised ledge (mesa), pillars to hop,
 *    a run of equal gaps, stepping stones, a row of blocks overhead, a slime
 *    on a long flat and a coin arc over a gap.
 *  - Pacing. Every piece has an intensity (0 = a rest, 1 = the hardest). A
 *    hard piece is followed by a breather, two rests never sit side by side,
 *    and pieces near the style's target intensity are preferred.
 *  - Echo. Shapes the person has drawn (`style.motifs`, see motifs.ts) are
 *    replayed with small variations: the same gap width one wider, the same
 *    stairs with one more step.
 *
 * Every piece is laid out inside the jump caps for the run-up it leaves, so
 * most sections pass the rule check; the caller still checks each one
 * (@physsim checkRules) and the verifier plays the final answer.
 *
 * Grid: row-major, y down. `ground` is the SURFACE row (the top solid row);
 * the knight stands at ground - 1.
 */
import type { Point } from "../../../apps/editor/src/contracts";
import { capsFor, fullRunway, ladderGap, type Caps } from "./caps";
import { PyRandom } from "./rng";

export const COMPOSE_KINDS = [
  "flat",
  "pit",
  "step",
  "platform_over_pit",
  "coin_row",
  "stairs",
  "mesa",
  "pillars",
  "gap_run",
  "stones",
  "brick_row",
  "enemy_run",
  "coin_jump",
] as const;
export type ComposeKind = (typeof COMPOSE_KINDS)[number];

/** How demanding a piece is, 0 (a rest) .. 1. Gaps add WIDE_GAP_STEP per column over two. */
export const INTENSITY: Record<ComposeKind, number> = {
  flat: 0,
  coin_row: 0.1,
  brick_row: 0.15,
  mesa: 0.3,
  step: 0.3,
  stairs: 0.35,
  pit: 0.4,
  coin_jump: 0.45,
  pillars: 0.45,
  enemy_run: 0.55,
  platform_over_pit: 0.6,
  gap_run: 0.7,
  stones: 0.8,
};
const WIDE_GAP_STEP = 0.06;
/** Rows the floor may climb above, and drop below, the section's starting floor. */
const CLIMB = 5;
const DROP = 3;
/** At or above this a piece is "hard": the next one is a breather. */
export const HARD = 0.6;
const BREATHERS: readonly ComposeKind[] = ["flat", "coin_row", "brick_row"];
/** Pieces that keep to the floor's height (no raised ground, no floating tiles). */
export const CALM_KINDS: readonly ComposeKind[] = ["flat", "pit", "coin_jump", "gap_run", "coin_row", "enemy_run"];
/** Pieces that only add on top of the floor (no gaps). */
export const BUILD_UP_KINDS: readonly ComposeKind[] = ["flat", "coin_row", "brick_row", "mesa", "pillars", "stairs", "step", "enemy_run"];
/** Columns after a block row that stay calm. */
const CALM_AFTER_BLOCKS = 9;
/** Columns a piece needs before it is worth trying. */
const MIN_ROOM: Record<ComposeKind, number> = {
  flat: 1,
  pit: 4,
  step: 3,
  platform_over_pit: 7,
  coin_row: 3,
  stairs: 5,
  mesa: 5,
  pillars: 7,
  gap_run: 8,
  stones: 9,
  brick_row: 6,
  enemy_run: 6,
  coin_jump: 4,
};

/** Cell codes in ComposedChunk.cell: what to draw a solid cell with. */
export const CELL = { NONE: 0, SURFACE: 1, FILL: 2, BRICK: 3 } as const;

/**
 * A shape the person drew, to echo. `size`: pit = empty columns; step =
 * signed rows (negative = up); stairs = signed step count (negative = up);
 * platform = width.
 */
export interface Motif {
  kind: "pit" | "step" | "stairs" | "platform";
  size: number;
  /** stairs: columns per step. */
  tread?: number;
  /** stairs: rows per step; platform: rows above the floor. */
  rise?: number;
}

/** Everything that shapes a composed section. Ranges are inclusive [lo, hi]. */
export interface ComposeStyle {
  /** Relative weight per piece kind (absent or 0 = never). */
  weights: Partial<Record<ComposeKind, number>>;
  /** Pit width range (empty columns); also bounded by the run-up ladder. */
  gap: [number, number];
  /** Step height range (rows). */
  rise: [number, number];
  /** Chance a column of a flat run (3+ long) gets a slime; decays x0.6 per slime. */
  enemyP: number;
  /** Chance a spot that can hold a coin gets one. */
  coinP: number;
  /** A coin on every `coinEvery`-th column of an arc. */
  coinEvery: number;
  /** Chance a step or stairs go up rather than down. */
  upP: number;
  /** Solid rows from the surface down. */
  fillDepth: number;
  /** Width range of a platform-over-pit piece. */
  platformWidth: [number, number];
  /** Platform height above the ground, rows. */
  platformRise: [number, number];
  /** Target intensity 0..1 the section leans toward. */
  intensity: number;
  /** Shapes to echo (may be empty). */
  motifs: Motif[];
  /** Optional name for logs. */
  name?: string;
}

export interface ComposeOptions {
  /** Columns (default 24) and rows (default 12). */
  w?: number;
  h?: number;
  /** Surface row of the start (default 8). */
  ground?: number;
  seed?: number;
  style?: ComposeStyle;
  /** Jump caps (default capsFor("NORMAL")). */
  caps?: Caps;
  /** Flat safe columns at the start (default 1) and the end (default 2). */
  startRun?: number;
  endRun?: number;
  /** Piece kinds seen in recent sections: made less likely, for variety. */
  avoid?: readonly ComposeKind[];
  /**
   * Columns at the start that get only floor-level pieces (no raised ground
   * or floating tiles): set when something high stands just behind the
   * section, so no new surface lands out of jumping range of it.
   */
  calmLead?: number;
  /**
   * The ground under the whole section is already solid (the starter level's
   * floor): only pieces that build upward, and the floor never drops below
   * where it starts, since a section can add tiles but not dig.
   */
  solidFloor?: boolean;
}

export interface ComposedPiece {
  kind: ComposeKind;
  /** Chunk-relative columns [x0, x1]. */
  x0: number;
  x1: number;
  /** Surface row the piece ends on. */
  y: number;
  /** Pit width, signed step height, step count, platform width, pillar count... */
  size: number;
  /** Terse description for logs and tags ("pit 3", "stairs up 4"). */
  desc: string;
  /** How a person would say it ("a 3-wide gap", "stairs up"). */
  phrase: string;
  intensity: number;
  /** Laid out from one of the person's own shapes. */
  echo: boolean;
}

export interface ComposedChunk {
  w: number;
  h: number;
  ground: number;
  seed: number;
  /** Row-major solid mask (1 solid). */
  grid: Uint8Array;
  /** Row-major CELL code per cell (surface, fill or brick; 0 where empty). */
  cell: Uint8Array;
  /** Ground surface row per column, null = pit. Floating platforms are not surfaces here. */
  heights: (number | null)[];
  /** Floating tiles (platforms, stones, bricks). */
  platforms: Point[];
  coins: Point[];
  slimes: Point[];
  desc: string[];
  pieces: ComposedPiece[];
  /** Surface row of the last column. */
  endY: number;
  /** The hardest piece's intensity (0 for an all-flat section). */
  peak: number;
  style: ComposeStyle;
}

/** A neutral style: a bit of everything, standing-jump gaps, one-row steps. */
export function neutralStyle(caps: Caps = capsFor()): ComposeStyle {
  const stand = Math.max(2, ladderGap(caps, 0));
  return {
    name: "neutral",
    weights: {
      flat: 1,
      pit: 1.2,
      step: 1,
      platform_over_pit: 0.8,
      coin_row: 0.8,
      stairs: 0.7,
      mesa: 0.7,
      pillars: 0.5,
      gap_run: 0.5,
      stones: 0.5,
      brick_row: 0.6,
      enemy_run: 0.4,
      coin_jump: 0.7,
    },
    gap: [2, Math.min(4, stand)],
    rise: [1, 2],
    enemyP: 0.1,
    coinP: 0.6,
    coinEvery: 1,
    upP: 0.55,
    fillDepth: 2,
    platformWidth: [5, 7],
    platformRise: [2, 3],
    intensity: 0.4,
    motifs: [],
  };
}

const idx = (w: number, x: number, y: number) => y * w + x;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const num = (n: number) => NUM[n] ?? String(n);

/**
 * Compose one section. Deterministic for (options, seed).
 */
export function composeChunk(opts: ComposeOptions = {}): ComposedChunk {
  const W = opts.w ?? 24;
  const H = opts.h ?? 12;
  const caps = opts.caps ?? capsFor();
  const style = opts.style ?? neutralStyle(caps);
  const seed = opts.seed ?? 0;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 2) throw new RangeError(`bad chunk size ${W}x${H}`);
  const ground = opts.ground ?? 8;
  if (!Number.isInteger(ground) || ground < 0 || ground >= H) throw new RangeError(`ground ${ground} is outside 0..${H - 1}`);
  const startRun = Math.max(0, opts.startRun ?? 1);
  const endRun = Math.max(0, opts.endRun ?? 2);
  const fillDepth = Math.max(1, Math.floor(style.fillDepth));
  const coinEvery = Math.max(1, Math.floor(style.coinEvery));
  const maxRun = fullRunway(caps);
  const standGap = ladderGap(caps, 0);
  /** Highest comfortable step: one under the knight's limit. */
  const stepCap = Math.max(1, Math.trunc(caps.maxStepUp) - 1);
  /** Hop between floating stones (they may differ a row in height). */
  const hopCap = Math.max(2, Math.min(3, standGap - 2));
  /** The floor stays within a few rows of where it started, so a section never drifts off the screen. */
  const yMin = Math.max(3, ground - CLIMB);
  const yMax = opts.solidFloor ? ground : Math.min(H - 2, ground + DROP);
  const avoid = new Set(opts.avoid ?? []);
  /** Until this column only CALM_KINDS are laid (see ComposeOptions.calmLead). */
  let calmUntil = Math.max(0, opts.calmLead ?? 0);
  const [gapLo, gapHi] = style.gap;

  const rnd = new PyRandom(seed);
  const grid = new Uint8Array(W * H);
  const brick = new Uint8Array(W * H);
  const heights: (number | null)[] = new Array(W).fill(null);
  const platforms: Point[] = [];
  const coins: Point[] = [];
  const slimes: Point[] = [];
  const pieces: ComposedPiece[] = [];
  let enemyP = style.enemyP;
  let x = 0;
  let y = ground;
  /** Row (exclusive) the ground is filled down to; raised ground stays solid underneath. */
  let bottom = ground + fillDepth;

  const putCol = (cx: number, surf: number | null) => {
    if (cx < 0 || cx >= W) return;
    heights[cx] = surf;
    if (surf === null) return;
    // Solid from the surface down to the running bottom, so raised ground is a hill, not a ribbon.
    const to = Math.min(H, Math.max(surf + fillDepth, bottom));
    for (let yy = Math.max(0, surf); yy < to; yy++) grid[idx(W, cx, yy)] = 1;
  };
  const floating = (cx: number, cy: number, isBrick = false) => {
    if (cx < 0 || cx >= W || cy < 0 || cy >= H) return;
    grid[idx(W, cx, cy)] = 1;
    if (isBrick) brick[idx(W, cx, cy)] = 1;
    platforms.push({ x: cx, y: cy });
  };
  const coin = (cx: number, cy: number) => {
    if (cx >= 0 && cx < W && cy >= 0 && cy < H) coins.push({ x: cx, y: cy });
  };
  const flatCols = (n: number) => {
    for (let i = 0; i < n; i++) putCol(x++, y);
  };
  const pitCols = (n: number) => {
    for (let i = 0; i < n; i++) putCol(x++, null);
    bottom = y + fillDepth;
  };
  const lowerTo = (ny: number) => {
    y = ny;
    bottom = Math.max(bottom, y + fillDepth);
  };
  /** Flat columns behind the takeoff column (the rule check's run-up). */
  const runway = () => {
    let r = 0;
    for (let k = x - 2; k >= 0 && heights[k] === y && r < maxRun; k--) r++;
    return r;
  };
  const motifsOf = (kind: Motif["kind"]) => style.motifs.filter((m) => m.kind === kind);
  /** With some luck, one of the person's shapes of this kind. */
  const echoOf = (kind: Motif["kind"]): Motif | null => {
    const ms = motifsOf(kind);
    if (!ms.length) return null;
    return rnd.random() < 0.65 ? rnd.choice(ms) : null;
  };
  /** A motif's size with a small variation (-1, 0, 0, +1). */
  const vary = (n: number) => n + rnd.choice([-1, 0, 0, 1]);
  const done = (kind: ComposeKind, x0: number, size: number, desc: string, phrase: string, echo = false, extra = 0) => {
    pieces.push({ kind, x0, x1: x - 1, y, size, desc, phrase, intensity: Math.min(1, INTENSITY[kind] + extra), echo });
    return true;
  };

  /** Pit width for the run-up available, from the style or an echoed gap; 0 when none fits. */
  const pitWidth = (room: number, cap: number): { w: number; echo: boolean } => {
    const lim = Math.min(cap, room - 2);
    if (lim < 2) return { w: 0, echo: false };
    const m = echoOf("pit");
    if (m) {
      const w = clamp(vary(m.size), 2, lim);
      // Squeezed far from the person's width by the room left: no longer their shape.
      return { w, echo: Math.abs(w - m.size) <= 1 };
    }
    return { w: rnd.randint(Math.min(gapLo, lim), Math.min(Math.max(gapLo, gapHi), lim)), echo: false };
  };

  const lay: Record<ComposeKind, (room: number) => boolean> = {
    flat(room) {
      const x0 = x;
      const n = Math.min(room, rnd.randint(2, 4));
      for (let i = 0; i < n; i++) {
        putCol(x, y);
        if (n >= 3 && rnd.random() < enemyP) {
          slimes.push({ x, y: y - 1 });
          enemyP *= 0.6;
        }
        x++;
      }
      return done("flat", x0, n, `flat ${n}`, "a flat run");
    },

    pit(room) {
      const x0 = x;
      const { w, echo } = pitWidth(room, ladderGap(caps, runway()));
      if (w < 2) return false;
      pitCols(w);
      flatCols(2);
      return done("pit", x0, w, `pit ${w}`, `a ${w}-wide gap`, echo, WIDE_GAP_STEP * (w - 2));
    },

    coin_jump(room) {
      const x0 = x;
      const { w, echo } = pitWidth(room, ladderGap(caps, runway()));
      if (w < 2 || y - 3 < 0) return false;
      for (let i = 0; i < w; i++) if (i % coinEvery === 0) coin(x + i, y - (i === 0 || i === w - 1 ? 2 : 3));
      pitCols(w);
      flatCols(2);
      return done("coin_jump", x0, w, `coin jump ${w}`, "a gap with a coin arc", echo, WIDE_GAP_STEP * (w - 2));
    },

    step(room) {
      const x0 = x;
      const m = echoOf("step");
      let up = m ? m.size < 0 : rnd.random() < style.upP;
      const dh = m ? Math.abs(m.size) : rnd.randint(style.rise[0], Math.max(style.rise[0], style.rise[1]));
      let ny = up ? y - Math.min(dh, stepCap) : y + dh;
      if (ny < yMin || ny > yMax) {
        up = !up;
        ny = up ? y - Math.min(dh, stepCap) : y + dh;
      }
      ny = clamp(ny, Math.min(y, yMin), Math.max(y, yMax));
      if (ny === y) return false;
      const d = Math.abs(ny - y);
      if (ny > y) lowerTo(ny);
      else y = ny;
      flatCols(Math.min(room, 3));
      const word = up ? "up" : "down";
      return done("step", x0, up ? -d : d, `step ${word} ${d}`, d === 1 ? `a step ${word}` : `a ${d}-high step ${word}`, !!m && up === m.size < 0);
    },

    stairs(room) {
      const x0 = x;
      const m = echoOf("stairs");
      const tread = clamp(m?.tread ?? rnd.randint(1, 2), 1, 2);
      const riser = clamp(m?.rise ?? (style.rise[1] >= 2 && rnd.random() < 0.25 ? 2 : 1), 1, stepCap);
      let up = m ? m.size < 0 : rnd.random() < style.upP;
      let count = m ? clamp(vary(Math.abs(m.size)), 2, 6) : rnd.randint(3, 5);
      count = Math.min(count, Math.floor((room - 2) / tread));
      const fits = (goUp: boolean) => Math.floor(goUp ? (y - yMin) / riser : (yMax - y) / riser);
      if (fits(up) < 2 && fits(!up) >= 2) up = !up;
      count = Math.min(count, fits(up));
      if (count < 2) return false;
      for (let s = 0; s < count; s++) {
        if (up) y -= riser;
        else lowerTo(y + riser);
        flatCols(tread);
      }
      const topX = up ? x - 1 : x0;
      if (up && rnd.random() < style.coinP) coin(topX, y - 2);
      flatCols(Math.min(2, W - endRun - x));
      const word = up ? "up" : "down";
      return done("stairs", x0, up ? -count : count, `stairs ${word} ${count}`, `stairs ${word}, ${num(count)} steps`, !!m && up === m.size < 0);
    },

    mesa(room) {
      const x0 = x;
      const dh = rnd.randint(1, Math.min(2, stepCap));
      const top = y - dh;
      if (top < 3) return false;
      const n = Math.min(rnd.randint(3, 5), room - 2);
      if (n < 3) return false;
      const base = y;
      y = top;
      const a = x;
      flatCols(n);
      let what = "";
      if (n >= 5 && rnd.random() < Math.min(0.9, style.enemyP * 2)) {
        slimes.push({ x: a + Math.floor(n / 2), y: top - 1 });
        what = " with a slime";
      } else if (rnd.random() < style.coinP) {
        for (let i = 0; i < n; i++) if (i % coinEvery === 0) coin(a + i, top - 2 - (i > 0 && i < n - 1 ? 1 : 0));
        what = " with coins";
      }
      y = base;
      flatCols(2);
      return done("mesa", x0, n, `ledge up ${dh}, ${n} wide`, `a raised ledge${what}`);
    },

    pillars(room) {
      const x0 = x;
      const space = rnd.randint(2, 3);
      let k = rnd.randint(2, 3);
      while (k >= 2 && k * (space + 1) + 2 > room) k--;
      if (k < 2) return false;
      const tall = Math.min(2, stepCap);
      if (y - tall < 3) return false;
      const base = y;
      for (let i = 0; i < k; i++) {
        flatCols(space);
        y = base - rnd.randint(1, tall);
        flatCols(1);
        y = base;
      }
      flatCols(2);
      return done("pillars", x0, k, `pillars ${k}`, `${num(k)} pillars to hop`);
    },

    gap_run(room) {
      const x0 = x;
      // Islands are two wide: one column of run-up before every gap after the first.
      const { w, echo } = pitWidth(room, Math.min(ladderGap(caps, runway()), ladderGap(caps, 1), Math.max(2, standGap - 1)));
      if (w < 2) return false;
      let k = rnd.randint(2, 3);
      while (k >= 2 && k * (w + 2) > room) k--;
      if (k < 2) return false;
      for (let i = 0; i < k; i++) {
        pitCols(w);
        flatCols(2);
      }
      return done("gap_run", x0, k, `gap run ${k}x${w}`, `${num(k)} gaps in a row`, echo, WIDE_GAP_STEP * (w - 2));
    },

    stones(room) {
      const x0 = x;
      const hop = rnd.randint(2, Math.max(2, Math.min(hopCap, gapHi)));
      const wide = rnd.randint(1, 2);
      let k = rnd.randint(2, 3);
      while (k >= 2 && k * (hop + wide) + hop + 2 > room) k--;
      if (k < 2 || y - 2 < 3) return false;
      // Stone rows: level with the floor, one up, or alternating.
      const shape = rnd.choice(["level", "raised", "alternate"] as const);
      for (let i = 0; i < k; i++) {
        pitCols(hop);
        const row = shape === "level" ? y : shape === "raised" ? y - 1 : y - (i % 2 === 0 ? 1 : 0);
        for (let j = 0; j < wide; j++) {
          floating(x, row);
          if (j === 0 && rnd.random() < style.coinP) coin(x, row - 2);
          putCol(x++, null);
        }
      }
      pitCols(hop);
      flatCols(2);
      return done("stones", x0, k, `stones ${k}`, `${num(k)} stepping stones`);
    },

    brick_row(room) {
      const x0 = x;
      const row = y - 4; // three empty cells between the floor and the blocks: room to walk and to jump
      if (row < 1) return false;
      const n = Math.min(rnd.randint(3, 5), room - 3);
      if (n < 3) return false;
      flatCols(1);
      const withCoins = rnd.random() < style.coinP;
      for (let i = 0; i < n; i++) {
        floating(x, row, true);
        if (withCoins && i % 2 === 0) coin(x, y - 3);
        putCol(x++, y);
      }
      flatCols(2);
      // The block tops are a surface four rows up: raised ground right after
      // it would sit too far below and away for the validator's jump check.
      calmUntil = Math.max(calmUntil, x + CALM_AFTER_BLOCKS);
      return done("brick_row", x0, n, `block row ${n}`, withCoins ? "a block row with coins under it" : "a row of blocks overhead");
    },

    platform_over_pit(room) {
      const x0 = x;
      const m = echoOf("platform");
      const [pw0, pw1] = style.platformWidth;
      const hi = Math.min(Math.max(pw0, pw1), room - 2);
      if (hi < 5) return false;
      const w = rnd.randint(Math.min(pw0, hi), hi);
      const pw = clamp(m ? m.size : 3, 2, w - 2);
      const px0 = x + Math.floor((w - pw) / 2);
      const [pr0, pr1] = style.platformRise;
      const ph = y - clamp(m?.rise ?? rnd.randint(pr0, Math.max(pr0, pr1)), 1, stepCap);
      if (ph < 2) return false;
      pitCols(w);
      for (let cx = px0; cx < px0 + pw; cx++) {
        floating(cx, ph);
        if (rnd.random() < style.coinP) coin(cx, ph - 1);
      }
      flatCols(2);
      return done("platform_over_pit", x0, w, `platform over ${w}-wide pit`, "a platform over a pit", !!m);
    },

    enemy_run(room) {
      const x0 = x;
      const n = Math.min(rnd.randint(6, 8), room);
      if (n < 6) return false;
      flatCols(n);
      slimes.push({ x: x0 + Math.floor(n / 2), y: y - 1 });
      return done("enemy_run", x0, n, `slime run ${n}`, "a slime on a long flat");
    },

    coin_row(room) {
      const x0 = x;
      const n = Math.min(room, rnd.randint(3, 5));
      if (n < 3 || y - 3 < 0) return false;
      for (let i = 0; i < n; i++) {
        if (i % coinEvery === 0) coin(x, y - 2 - (i > 0 && i < n - 1 ? 1 : 0));
        putCol(x++, y);
      }
      return done("coin_row", x0, n, `coin arc ${n}`, "a coin arc");
    },
  };

  const used = new Map<ComposeKind, number>();
  const weightOf = (k: ComposeKind): number => {
    let w = style.weights[k] ?? 0;
    if (w <= 0) return 0;
    // Prefer pieces near the target intensity; never rule a kind out for it.
    const d = INTENSITY[k] - style.intensity;
    w *= Math.max(0.15, Math.exp(-(d * d) / (2 * 0.4 * 0.4)));
    w *= Math.pow(0.35, used.get(k) ?? 0);
    if (avoid.has(k)) w *= 0.3;
    if (k === "pit" || k === "gap_run" || k === "coin_jump") w *= motifsOf("pit").length ? 1.6 : 1;
    if (k === "step") w *= motifsOf("step").length ? 1.6 : 1;
    if (k === "stairs") w *= motifsOf("stairs").length ? 2 : 1;
    if (k === "platform_over_pit" || k === "stones") w *= motifsOf("platform").length ? 1.6 : 1;
    return w;
  };

  for (let i = 0; i < startRun && x < W; i++) putCol(x++, y);
  let last: ComposedPiece | null = null;
  while (x < W - endRun) {
    const room = W - endRun - x;
    let pool = COMPOSE_KINDS.filter((k) => MIN_ROOM[k] <= room && weightOf(k) > 0);
    if (last && last.intensity >= HARD) {
      const rest = pool.filter((k) => BREATHERS.includes(k));
      if (rest.length) pool = rest;
    }
    // Two rests never sit side by side: after a flat run only a single filler column may follow.
    if (last && last.kind === "flat") pool = pool.filter((k) => k !== "flat");
    if (x < calmUntil) pool = pool.filter((k) => CALM_KINDS.includes(k));
    if (opts.solidFloor) pool = pool.filter((k) => BUILD_UP_KINDS.includes(k));
    let laid = false;
    if (pool.length) {
      const total = pool.reduce((a, k) => a + weightOf(k), 0);
      let r = rnd.random() * total;
      let pick = pool[pool.length - 1];
      for (const k of pool) {
        r -= weightOf(k);
        if (r < 0) {
          pick = k;
          break;
        }
      }
      const before = pieces.length;
      laid = lay[pick](room);
      if (laid && pieces.length > before) {
        last = pieces[pieces.length - 1];
        used.set(pick, (used.get(pick) ?? 0) + 1);
      }
    }
    // A piece that did not fit here: one flat column, then try again.
    if (!laid) putCol(x++, y);
  }
  while (x < W) putCol(x++, y);

  const cell = new Uint8Array(W * H);
  for (let cy = 0; cy < H; cy++)
    for (let cx = 0; cx < W; cx++) {
      const i = idx(W, cx, cy);
      if (!grid[i]) continue;
      cell[i] = brick[i] ? CELL.BRICK : cy === 0 || !grid[idx(W, cx, cy - 1)] ? CELL.SURFACE : CELL.FILL;
    }
  const peak = pieces.reduce((a, p) => Math.max(a, p.intensity), 0);
  return {
    w: W,
    h: H,
    ground,
    seed,
    grid,
    cell,
    heights,
    platforms,
    coins: coins.filter((c) => !grid[idx(W, c.x, c.y)]),
    slimes,
    desc: pieces.map((p) => p.desc),
    pieces,
    endY: y,
    peak,
    style,
  };
}

/** ASCII rows: # ground, = floating tile, B block row, c coin, s slime, . empty. */
export function composedRows(c: ComposedChunk): string[] {
  const coin = new Set(c.coins.map((p) => `${p.x},${p.y}`));
  const slime = new Set(c.slimes.map((p) => `${p.x},${p.y}`));
  const float = new Set(c.platforms.map((p) => `${p.x},${p.y}`));
  const rows: string[] = [];
  for (let y = 0; y < c.h; y++) {
    let s = "";
    for (let x = 0; x < c.w; x++) {
      const i = idx(c.w, x, y);
      const k = `${x},${y}`;
      s += c.cell[i] === CELL.BRICK ? "B" : c.grid[i] ? (float.has(k) ? "=" : "#") : coin.has(k) ? "c" : slime.has(k) ? "s" : ".";
    }
    rows.push(s);
  }
  return rows;
}

/** Pattern-like tags for a section (measure's vocabulary where it fits, plus a few of its own). */
export function composedTags(c: Pick<ComposedChunk, "pieces" | "coins" | "slimes">): string[] {
  const tags = new Set<string>();
  let pits = 0;
  let ups = 0;
  for (const p of c.pieces) {
    switch (p.kind) {
      case "pit":
        pits++;
        break;
      case "coin_jump":
        pits++;
        tags.add("coin-arc").add("risky-coin");
        break;
      case "gap_run":
        pits += 2;
        break;
      case "step":
        tags.add("step");
        if (p.size < 0) ups++;
        break;
      case "stairs":
        tags.add("staircase");
        if (p.size < 0) tags.add("rising-steps");
        break;
      case "mesa":
        tags.add("ledge");
        break;
      case "pillars":
        tags.add("wall");
        break;
      case "stones":
        tags.add("pillar-hop").add("pit");
        break;
      case "platform_over_pit":
        tags.add("pillar-hop").add("platform");
        break;
      case "brick_row":
        tags.add("overhang");
        break;
      case "enemy_run":
        tags.add("enemy-gate");
        break;
      case "coin_row":
        tags.add("coin-arc");
        break;
      case "flat":
        if (p.size >= 4) tags.add("rest");
        break;
    }
  }
  if (pits) tags.add("pit");
  if (pits >= 2) tags.add("gap-run");
  if (ups >= 2) tags.add("rising-steps");
  if (c.slimes.length) tags.add("enemy");
  return [...tags];
}

/** The piece kinds of a section, without flat runs (what a caller passes back as `avoid`). */
export function composedKinds(c: Pick<ComposedChunk, "pieces">): ComposeKind[] {
  return [...new Set(c.pieces.map((p) => p.kind).filter((k) => k !== "flat"))];
}
