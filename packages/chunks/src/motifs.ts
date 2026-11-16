/**
 * Motif mining: read the shapes a person has drawn (gap widths, steps,
 * staircases, floating platforms) off a solid grid, so the composer can echo
 * them (compose.ts `style.motifs`). Plain geometry on the tiles; nothing is
 * learned or stored between calls.
 *
 *  1. Floating platforms: short horizontal runs with air above and below.
 *  2. The ground profile: per column, the top of the lowest solid run once
 *     the platforms are set aside (null where the column is empty: a pit).
 *  3. Gaps between two stretches of ground, single steps, and staircases
 *     (three or more steps the same way with treads of one or two columns).
 */
import type { Motif } from "./compose";

export interface MotifGrid {
  w: number;
  h: number;
  /** Row-major, 1 = solid. */
  solid: Uint8Array;
}

export interface MotifOptions {
  /** Read columns x0..x1 only (default the whole grid). */
  x0?: number;
  x1?: number;
  /** Most motifs returned, the rightmost (newest) first (default 8). */
  max?: number;
  /** Widest gap that counts as a jump rather than the edge of the drawing (default 8). */
  maxGap?: number;
  /** Longest floating run that counts as a platform (default 5). */
  maxPlatform?: number;
}

export interface MinedMotifs {
  motifs: Motif[];
  /** Ground surface row per column in [x0, x1], null = no ground. */
  heights: (number | null)[];
  /** Columns in the range that hold ground. */
  groundCols: number;
}

interface Found extends Motif {
  /** Column the shape ends at, for newest-first ordering. */
  at: number;
}

const keyOf = (m: Motif) => `${m.kind}:${m.size}:${m.tread ?? ""}:${m.rise ?? ""}`;

/** The shapes in a grid, newest (rightmost) first, without duplicates. */
export function mineMotifs(g: MotifGrid, opts: MotifOptions = {}): MinedMotifs {
  const x0 = Math.max(0, opts.x0 ?? 0);
  const x1 = Math.min(g.w - 1, opts.x1 ?? g.w - 1);
  const maxGap = opts.maxGap ?? 8;
  const maxPlatform = opts.maxPlatform ?? 5;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < g.w && y < g.h && g.solid[y * g.w + x] === 1;
  const found: Found[] = [];
  if (x1 < x0) return { motifs: [], heights: [], groundCols: 0 };

  // 1. Floating platforms.
  const floating = new Uint8Array(g.w * g.h);
  const platformRuns: { xa: number; xb: number; y: number }[] = [];
  for (let y = 0; y < g.h - 1; y++) {
    let x = x0;
    while (x <= x1) {
      if (!solid(x, y)) {
        x++;
        continue;
      }
      let e = x;
      while (e + 1 <= x1 && solid(e + 1, y)) e++;
      const len = e - x + 1;
      let free = len <= maxPlatform && !solid(x - 1, y) && !solid(e + 1, y);
      for (let k = x; k <= e && free; k++) if (solid(k, y - 1) || solid(k, y + 1)) free = false;
      if (free) {
        for (let k = x; k <= e; k++) floating[y * g.w + k] = 1;
        platformRuns.push({ xa: x, xb: e, y });
      }
      x = e + 1;
    }
  }

  // 2. Ground profile.
  const heights: (number | null)[] = [];
  for (let x = x0; x <= x1; x++) {
    let y = g.h - 1;
    while (y >= 0 && !(solid(x, y) && !floating[y * g.w + x])) y--;
    if (y < 0) {
      heights.push(null);
      continue;
    }
    while (y - 1 >= 0 && solid(x, y - 1) && !floating[(y - 1) * g.w + x]) y--;
    heights.push(y);
  }
  const at = (x: number) => heights[x - x0];
  const groundCols = heights.filter((v) => v !== null).length;

  // A platform's rise is measured from the nearest ground to its left or right.
  for (const p of platformRuns) {
    let base: number | null = null;
    for (let d = 0; d <= maxGap && base === null; d++) {
      const l = p.xa - d >= x0 ? at(p.xa - d) : null;
      const r = p.xb + d <= x1 ? at(p.xb + d) : null;
      base = l ?? r ?? null;
    }
    if (base === null) continue;
    const rise = base - p.y;
    if (rise >= 0 && rise <= 4) found.push({ kind: "platform", size: p.xb - p.xa + 1, rise: Math.max(1, rise), at: p.xb });
  }

  // 3. Gaps, steps, staircases along the ground.
  type Step = { x: number; dh: number };
  const steps: Step[] = [];
  let prev: { x: number; y: number } | null = null;
  for (let x = x0; x <= x1; x++) {
    const y = at(x);
    if (y === null) continue;
    if (prev) {
      const gap = x - prev.x - 1;
      if (gap >= 2 && gap <= maxGap) found.push({ kind: "pit", size: gap, at: x });
      else if (gap === 0 && y !== prev.y && Math.abs(y - prev.y) <= 4) steps.push({ x, dh: y - prev.y });
    }
    prev = { x, y };
  }
  for (let i = 0; i < steps.length; ) {
    let j = i;
    while (
      j + 1 < steps.length &&
      Math.sign(steps[j + 1].dh) === Math.sign(steps[i].dh) &&
      steps[j + 1].x - steps[j].x <= 2 &&
      Math.abs(steps[j + 1].dh) === Math.abs(steps[i].dh)
    )
      j++;
    const count = j - i + 1;
    if (count >= 3) {
      const treads: number[] = [];
      for (let k = i + 1; k <= j; k++) treads.push(steps[k].x - steps[k - 1].x);
      treads.sort((a, b) => a - b);
      found.push({
        kind: "stairs",
        size: Math.sign(steps[i].dh) * count,
        tread: treads[Math.floor(treads.length / 2)] ?? 1,
        rise: Math.abs(steps[i].dh),
        at: steps[j].x,
      });
    } else for (let k = i; k <= j; k++) found.push({ kind: "step", size: steps[k].dh, at: steps[k].x });
    i = j + 1;
  }

  found.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const motifs: Motif[] = [];
  for (const f of found) {
    const { at: _at, ...m } = f;
    const k = keyOf(m);
    if (seen.has(k)) continue;
    seen.add(k);
    motifs.push(m);
    if (motifs.length >= (opts.max ?? 8)) break;
  }
  return { motifs, heights, groundCols };
}
