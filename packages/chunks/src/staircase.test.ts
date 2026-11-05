/**
 * Regression suite for the staircase complaint: the person builds a staircase
 * going up and to the right and the ghost fills in blocks UNDERNEATH it instead
 * of continuing it. Every case here is a staircase the person drew; the
 * expectation is a hand-computed continuation (the same step, one unit further
 * up and right), and a hollow staircase must never get filler below its treads.
 */
import { describe, expect, it } from "vitest";
import { detectFinish, type DetectGrid, type DetectPlacement } from "./detect";

const TILES: Record<string, number> = { grass: 6, dirt: 7, block: 8 };
const W = 40;
const H = 16;
const FLOOR = 13; // rows 13.. are solid ground

/** Level with a floor; `solid` extra cells are marked solid with `tile`. */
function gridOf(solid: [number, number][], tile: string): DetectGrid {
  const tiles = new Uint8Array(W * H);
  for (let y = FLOOR; y < H; y++) for (let x = 0; x < W; x++) tiles[y * W + x] = TILES.dirt;
  for (const [x, y] of solid) tiles[y * W + x] = TILES[tile];
  return { w: W, h: H, tiles, blocked: new Uint8Array(W * H), entities: [] };
}

const paint = (pts: [number, number][], tile: string): DetectPlacement[] =>
  pts.map(([x, y]) => ({ x, y, tile, tool: "paint" }));

/** A tread of `width` cells whose left end is (x, y). */
const tread = (x: number, y: number, width: number): [number, number][] =>
  Array.from({ length: width }, (_, i) => [x + i, y] as [number, number]);

/** `steps` treads: each `run` columns further right and `rise` rows higher. */
function hollowStairs(x0: number, width: number, rise: number, steps: number, run = width): [number, number][][] {
  return Array.from({ length: steps }, (_, i) => tread(x0 + i * run, FLOOR - 1 - i * rise, width));
}

/** Filled steps: a column of `height0 + i * rise` cells per step column group, down to the floor. */
function filledStairs(x0: number, width: number, rise: number, steps: number, height0 = 1): [number, number][][] {
  return Array.from({ length: steps }, (_, i) => {
    const cells: [number, number][] = [];
    for (let c = 0; c < width; c++) for (let y = FLOOR - 1; y >= FLOOR - height0 - i * rise; y--) cells.push([x0 + i * width + c, y]);
    return cells;
  });
}

const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;
const tup = (cs: [number, number][]) => cs.map(([x, y]) => key({ x, y }));
const sorted = (cs: { x: number; y: number }[]) => cs.map(key).sort();

/** Run the detector on the strokes in drawing order. */
function suggest(strokes: [number, number][][], tile: string) {
  const solid = strokes.flat();
  const recent = strokes.flatMap((s) => paint(s, tile));
  const out = detectFinish(gridOf(solid, tile), recent);
  return out[0];
}

const TILE_NAMES = ["grass", "dirt", "block"] as const;

describe("hollow staircases going up and to the right", () => {
  const cases: { name: string; width: number; rise: number; steps: number }[] = [
    { name: "1-wide treads, rise 1", width: 1, rise: 1, steps: 4 },
    { name: "2-wide treads, rise 1", width: 2, rise: 1, steps: 3 },
    { name: "2-wide treads, rise 1, four drawn", width: 2, rise: 1, steps: 4 },
    { name: "3-wide treads, rise 1", width: 3, rise: 1, steps: 3 },
    { name: "2-wide treads, rise 2", width: 2, rise: 2, steps: 3 },
  ];

  for (const tile of TILE_NAMES) {
    for (const c of cases) {
      it(`${c.name} (${tile}): continues the steps, never builds underneath`, () => {
        const drawn = hollowStairs(2, c.width, c.rise, c.steps);
        const best = suggest(drawn, tile);
        expect(best, "a suggestion").toBeDefined();
        // Nothing may be added below the lowest row of the next tread in its own column.
        const next = hollowStairs(2, c.width, c.rise, c.steps + 6).slice(c.steps);
        const want = tup(next.flat());
        const got = sorted(best.adds);
        // The ghost continues the staircase: every cell it adds is on a following tread...
        for (const cell of best.adds) expect(want, `${key(cell)} is not on the next treads`).toContain(key(cell));
        // ...and it adds at least the next full tread.
        expect(got.length).toBeGreaterThanOrEqual(c.width);
        for (const k of tup(next[0])) expect(got).toContain(k);
        expect(best.adds.every((a) => a.tile === tile)).toBe(true);
      });
    }
  }

  it("a partly drawn tread is finished and the steps go on", () => {
    const drawn = hollowStairs(2, 3, 1, 3);
    const partial: [number, number][] = tread(2 + 3 * 3, FLOOR - 1 - 3, 1); // first cell of the 4th tread
    const best = suggest([...drawn, partial], "grass");
    expect(best).toBeDefined();
    const got = sorted(best.adds);
    expect(got).toContain(key({ x: 12, y: FLOOR - 4 })); // the 4th tread starts at x = 11
    expect(got).toContain(key({ x: 13, y: FLOOR - 4 }));
    for (const cell of best.adds) expect(cell.y, "no filler under the treads").toBeLessThan(FLOOR - 1);
  });
});

describe("filled staircases going up and to the right", () => {
  for (const tile of TILE_NAMES) {
    it(`1-wide columns growing by 1 (${tile}): the next column is filled to the floor`, () => {
      const drawn = filledStairs(2, 1, 1, 4);
      const best = suggest(drawn, tile);
      expect(best, "a suggestion").toBeDefined();
      // The next column is x = 6 with height 5: rows FLOOR-1 .. FLOOR-5.
      const col6 = Array.from({ length: 5 }, (_, i) => key({ x: 6, y: FLOOR - 1 - i }));
      for (const k of col6) expect(sorted(best.adds)).toContain(k);
    });

    it(`2-wide steps rising 1 (${tile}): the next step is filled to the floor`, () => {
      const drawn = filledStairs(2, 2, 1, 3);
      const best = suggest(drawn, tile);
      expect(best, "a suggestion").toBeDefined();
      const next = filledStairs(2, 2, 1, 5)[3];
      for (const [x, y] of next) expect(sorted(best.adds)).toContain(key({ x, y }));
    });
  }

  it("a step being drawn sideways is completed, then the steps go on", () => {
    // 2-wide steps of heights 1, 2, 3 where the third step has only its first column.
    const drawn = filledStairs(2, 2, 1, 3);
    drawn[2] = drawn[2].filter(([x]) => x === 2 + 2 * 2);
    const best = suggest(drawn, "grass");
    expect(best, "a suggestion").toBeDefined();
    const got = sorted(best.adds);
    for (let y = FLOOR - 1; y >= FLOOR - 3; y--) expect(got).toContain(key({ x: 7, y })); // second column of step 3
    for (let y = FLOOR - 1; y >= FLOOR - 4; y--) expect(got).toContain(key({ x: 8, y })); // step 4 starts
    expect(best.adds.every((a) => a.y < FLOOR)).toBe(true);
  });

  it("a column still going up is completed to the step height, not stacked higher", () => {
    // 1-wide steps of heights 1, 2, 3, and the fourth column drawn up to height 2 so far.
    const drawn = filledStairs(2, 1, 1, 3);
    drawn.push([[5, FLOOR - 1], [5, FLOOR - 2]]);
    const best = suggest(drawn, "grass");
    expect(best, "a suggestion").toBeDefined();
    const got = sorted(best.adds);
    expect(got).toContain(key({ x: 5, y: FLOOR - 3 }));
    expect(got).toContain(key({ x: 5, y: FLOOR - 4 }));
    expect(got).not.toContain(key({ x: 5, y: FLOOR - 5 })); // the column is not taller than its step
    expect(got).toContain(key({ x: 6, y: FLOOR - 5 })); // the next step goes one higher
  });

  it("never offers a pillar on top of the last column", () => {
    const best = suggest(filledStairs(2, 1, 1, 4), "grass");
    expect(best.pattern).toBe("staircase");
  });
});

describe("staircases made of two tiles (grass over dirt)", () => {
  interface C {
    x: number;
    y: number;
    tile: string;
  }
  const idOf = (t: string) => TILES[t];

  function suggestMixed(strokes: C[][]) {
    const tiles = new Uint8Array(W * H);
    for (let y = FLOOR; y < H; y++) for (let x = 0; x < W; x++) tiles[y * W + x] = TILES.dirt;
    for (const c of strokes.flat()) tiles[c.y * W + c.x] = idOf(c.tile);
    const recent: DetectPlacement[] = strokes.flat().map((c) => ({ ...c, tool: "paint" }));
    return detectFinish({ w: W, h: H, tiles, blocked: new Uint8Array(W * H), entities: [] }, recent)[0];
  }

  /** Steps of `w` columns rising `r`: a grass tread over `body` dirt rows (clipped by the floor). */
  function mixedStairs(w: number, r: number, steps: number, body: number): C[][] {
    return Array.from({ length: steps }, (_, i) => {
      const cells: C[] = [];
      const top = FLOOR - 1 - i * r;
      for (let k = 0; k < w; k++) {
        const x = 2 + i * w + k;
        cells.push({ x, y: top, tile: "grass" });
        for (let y = top + 1; y <= Math.min(FLOOR - 1, top + body); y++) cells.push({ x, y, tile: "dirt" });
      }
      return cells;
    });
  }

  it("grass-topped, dirt-filled steps keep their caps: grass on top, dirt below", () => {
    const best = suggestMixed(mixedStairs(2, 1, 3, 12));
    expect(best.pattern).toBe("staircase");
    // The next step is x = 8, 9 with height 4: grass at row FLOOR-4, dirt under it.
    const byKey = new Map(best.adds.map((a) => [key(a), a.tile]));
    for (const x of [8, 9]) {
      expect(byKey.get(key({ x, y: FLOOR - 4 })), `cap at ${x}`).toBe("grass");
      for (let y = FLOOR - 3; y <= FLOOR - 1; y++) expect(byKey.get(key({ x, y })), `body at ${x},${y}`).toBe("dirt");
    }
    expect([...byKey.values()].filter((t) => t === "grass").length).toBeGreaterThan(0);
  });

  it("thick hollow steps (grass over one dirt row) repeat as a unit, not as a column", () => {
    const best = suggestMixed(mixedStairs(3, 1, 4, 1));
    expect(["repeat", "platforms", "zigzag"]).toContain(best.pattern);
    // The next step: grass tread at height FLOOR-1-4, dirt row under it; nothing below that.
    const byKey = new Map(best.adds.map((a) => [key(a), a.tile]));
    for (let x = 14; x <= 16; x++) {
      expect(byKey.get(key({ x, y: FLOOR - 5 }))).toBe("grass");
      expect(byKey.get(key({ x, y: FLOOR - 4 }))).toBe("dirt");
      expect(byKey.has(key({ x, y: FLOOR - 3 })), "no filler below the dirt row").toBe(false);
    }
  });
});

