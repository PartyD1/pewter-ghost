/**
 * Hand-built fixture windows with hand labels (expected tags). Rows are
 * bottom-aligned when pasted into a level with snapshotFromAscii. Legend in
 * grid.ts: '#' grass, 'c' coin, 's' slime, ...
 */
export interface Fixture {
  name: string;
  rows: string[];
  /** Tags a person would give this window. */
  expect: string[];
  /** Tags that must NOT be detected. */
  reject?: string[];
}

export const FLAT: Fixture = {
  name: "flat",
  rows: [
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "########################",
    "########################",
  ],
  expect: ["rest"],
  reject: ["pit", "wall", "staircase", "gap-run", "tunnel"],
};

export const STAIRCASE: Fixture = {
  name: "staircase",
  rows: [
    "........................",
    "........................",
    "...............#########",
    "..............##########",
    ".............###########",
    "............############",
    "########################",
    "########################",
  ],
  expect: ["staircase", "rest"],
  reject: ["pit", "gap-run", "wall"],
};

export const GAP_RUN: Fixture = {
  name: "gap-run",
  rows: [
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "#####...###...###...####",
    "#####...###...###...####",
  ],
  expect: ["gap-run", "pit", "rest"],
  reject: ["staircase", "pillar-hop", "rising-steps"],
};

export const PILLAR_HOP: Fixture = {
  name: "pillar-hop",
  rows: [
    "........................",
    "........................",
    "........................",
    "........................",
    "......#...#...#.........",
    "......#...#...#.........",
    "#####.#...#...#...######",
    "#####.#...#...#...######",
  ],
  expect: ["pillar-hop", "pit"],
  reject: ["staircase"],
};

export const RISING_STEPS: Fixture = {
  name: "rising-steps",
  rows: [
    "........................",
    "....................####",
    "........................",
    "...............###......",
    "........................",
    "..........###...........",
    "........................",
    ".....###................",
    "........................",
    "####....................",
    "####....................",
  ],
  expect: ["rising-steps", "pit"],
  reject: ["staircase", "gap-run"],
};

export const WALL: Fixture = {
  name: "wall",
  rows: [
    "........................",
    "........................",
    "............#...........",
    "............#...........",
    "............#...........",
    "............#...........",
    "########################",
    "########################",
  ],
  expect: ["wall", "rest"],
  reject: ["pit", "staircase"],
};

export const TUNNEL: Fixture = {
  name: "tunnel",
  rows: [
    "........................",
    "........................",
    "........................",
    "......##########........",
    "......##########........",
    "........................",
    "........................",
    "########################",
    "########################",
  ],
  expect: ["tunnel", "rest"],
  reject: ["pit"],
};

export const COIN_ROW_ON_FLOOR: Fixture = {
  name: "coin-row-on-floor",
  rows: [
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........ccccc...........",
    "########################",
    "########################",
  ],
  expect: ["coin-row-on-floor", "rest"],
  reject: ["coin-arc", "risky-coin"],
};

export const COIN_LADDER: Fixture = {
  name: "coin-ladder",
  rows: [
    "........................",
    "..........c.............",
    "..........c.............",
    "..........c.............",
    "........................",
    "........................",
    "########################",
    "########################",
  ],
  expect: ["coin-ladder", "rest"],
  reject: ["coin-row-on-floor", "risky-coin"],
};

/** Hop arc drawn over flat ground (shape-detected). */
export const HOP_ARC: Fixture = {
  name: "hop-arc",
  rows: [
    "........................",
    "........................",
    "..........ccc...........",
    ".........c...c..........",
    "........c.....c.........",
    "........................",
    "########################",
    "########################",
  ],
  expect: ["coin-arc", "rest"],
  reject: ["coin-row-on-floor"],
};

export const GUARDED: Fixture = {
  name: "guarded-reward",
  rows: [
    "........................",
    "........................",
    "........................",
    "........................",
    "..........f.............",
    "............s...........",
    "########################",
    "########################",
  ],
  expect: ["guarded-reward"],
  reject: ["rest", "enemy-gate"],
};

/** A slime on a small island between two pits: you must get past it. */
export const ENEMY_GATE: Fixture = {
  name: "enemy-gate",
  rows: [
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "..........s.............",
    "######...####...########",
    "######...####...########",
  ],
  expect: ["enemy-gate", "pit", "rest"],
};

export const ALL_FIXTURES: Fixture[] = [
  FLAT,
  STAIRCASE,
  GAP_RUN,
  PILLAR_HOP,
  RISING_STEPS,
  WALL,
  TUNNEL,
  COIN_ROW_ON_FLOOR,
  COIN_LADDER,
  HOP_ARC,
  GUARDED,
  ENEMY_GATE,
];

/** Join fixture rows left to right, bottom-aligned (shorter ones padded on top). */
export function joinRows(parts: readonly string[][]): string[] {
  const h = Math.max(...parts.map((p) => p.length));
  const out = new Array<string>(h).fill("");
  for (const p of parts) {
    const w = Math.max(...p.map((r) => r.length));
    const pad = h - p.length;
    for (let y = 0; y < h; y++) out[y] += y < pad ? ".".repeat(w) : p[y - pad].padEnd(w, ".");
  }
  return out;
}

/** A small "reference level": rest, gap run, rest, staircase, rest, enemy gate, rest. */
export const REFERENCE_ROWS: string[] = joinRows([
  FLAT.rows,
  GAP_RUN.rows,
  FLAT.rows,
  STAIRCASE.rows,
  ENEMY_GATE.rows,
  FLAT.rows,
]);
