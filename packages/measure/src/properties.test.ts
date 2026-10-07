/**
 * Properties (G-22 "How to test"): every measure is stable under horizontal
 * translation. Moving the content and the measured rect together by any
 * number of columns leaves every number, histogram and tag unchanged; whole
 * levels shifted by a whole number of screens give the same series, shifted.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { LEVEL_W, type LevelSnapshot } from "../../../apps/editor/src/contracts";
import { ALL_FIXTURES, REFERENCE_ROWS } from "./__fixtures__/levels";
import { SCREEN_COLS } from "./constants";
import { snapshotFromAscii, type Rect } from "./grid";
import { analyzeWindow, measureWindow, measureWindowFull } from "./measures";
import { measureLevel } from "./level";
import { sliceLevel } from "./slice";

const shift = (r: Rect, dx: number): Rect => ({ ...r, x: r.x + dx });

/** Fixture pasted at column `ox` (with empty level around it), and its rect. */
function placed(rows: string[], ox: number) {
  const snap = snapshotFromAscii(rows, { offsetX: ox });
  const rect: Rect = { x: ox, y: snap.h - rows.length, w: rows[0].length, h: rows.length };
  return { snap, rect };
}

describe("translation invariance", () => {
  for (const f of ALL_FIXTURES) {
    it(`${f.name}: same numbers and tags at any column`, () => {
      const base = placed(f.rows, 1);
      const want = measureWindowFull(base.snap, base.snap.entities, base.rect);
      const maxOx = LEVEL_W - f.rows[0].length - 1;
      for (const ox of [2, 7, 24, 61, 100, maxOx]) {
        const p = placed(f.rows, ox);
        expect(measureWindowFull(p.snap, p.snap.entities, p.rect)).toEqual(want);
        expect(measureWindow(p.snap, p.snap.entities, p.rect)).toEqual(
          measureWindow(base.snap, base.snap.entities, base.rect),
        );
      }
    });
  }

  it("pattern hits move with the content", () => {
    const f = ALL_FIXTURES.find((x) => x.name === "gap-run")!;
    const a = placed(f.rows, 3);
    const b = placed(f.rows, 3 + 50);
    const ha = analyzeWindow(a.snap, a.snap.entities, a.rect).hits;
    const hb = analyzeWindow(b.snap, b.snap.entities, b.rect).hits;
    expect(hb).toEqual(ha.map((h) => ({ ...h, x0: h.x0 + 50, x1: h.x1 + 50 })));
  });

  // Random terrain: column heights, floating platforms, coins and enemies.
  const COLS = 30;
  const ROWS = 12;
  const randomRows = fc
    .record({
      heights: fc.array(fc.integer({ min: 0, max: 7 }), { minLength: COLS, maxLength: COLS }),
      plats: fc.array(
        fc.record({ x: fc.integer({ min: 0, max: COLS - 1 }), y: fc.integer({ min: 1, max: ROWS - 3 }), w: fc.integer({ min: 1, max: 5 }) }),
        { maxLength: 4 },
      ),
      ents: fc.array(
        fc.record({
          x: fc.integer({ min: 0, max: COLS - 1 }),
          y: fc.integer({ min: 0, max: ROWS - 1 }),
          g: fc.constantFrom("c", "c", "c", "f", "s", "U"),
        }),
        { maxLength: 8 },
      ),
    })
    .map(({ heights, plats, ents }) => {
      const grid = Array.from({ length: ROWS }, () => new Array<string>(COLS).fill("."));
      heights.forEach((h, x) => {
        for (let k = 0; k < h; k++) grid[ROWS - 1 - k][x] = "#";
      });
      for (const p of plats) for (let x = p.x; x < Math.min(COLS, p.x + p.w); x++) grid[p.y][x] = "B";
      for (const e of ents) if (grid[e.y][e.x] === ".") grid[e.y][e.x] = e.g;
      return grid.map((r) => r.join(""));
    });

  it("random windows: any rect, any shift", () => {
    fc.assert(
      fc.property(
        randomRows,
        fc.integer({ min: 1, max: LEVEL_W - COLS - 1 }),
        fc.integer({ min: 1, max: LEVEL_W - COLS - 1 }),
        fc.integer({ min: 0, max: COLS - 4 }),
        fc.integer({ min: 4, max: COLS }),
        (rows, oa, ob, rx, rw) => {
          const a = snapshotFromAscii(rows, { offsetX: oa });
          const b = snapshotFromAscii(rows, { offsetX: ob });
          const y = a.h - ROWS;
          const ra: Rect = { x: oa + rx, y, w: Math.min(rw, COLS - rx), h: ROWS };
          const rb = shift(ra, ob - oa);
          expect(measureWindowFull(b, b.entities, rb)).toEqual(measureWindowFull(a, a.entities, ra));
        },
      ),
      { numRuns: 150 },
    );
  });

  it("whole levels shifted by whole screens give shifted series and equal aggregates", () => {
    const ref = (ox: number): LevelSnapshot => snapshotFromAscii(REFERENCE_ROWS, { offsetX: ox });
    expect(REFERENCE_ROWS[0].length + 3 + SCREEN_COLS).toBeLessThan(LEVEL_W);
    const a = measureLevel(ref(3));
    const b = measureLevel(ref(3 + SCREEN_COLS));
    expect(b.whole).toEqual(a.whole);
    // Screen i of a is screen i + 1 of b (the narrow last screen has no full-width partner).
    for (let i = 0; i < a.screens.length - 2; i++) expect(b.screens[i + 1].measures).toEqual(a.screens[i].measures);
    const { extent: ea, ...restA } = a.aggregate;
    const { extent: eb, ...restB } = b.aggregate;
    expect(restB).toEqual(restA);
    expect(eb).toEqual({ x0: ea!.x0 + SCREEN_COLS, x1: ea!.x1 + SCREEN_COLS });
  });

  it("slicing a shifted level gives the same chunks, shifted", () => {
    const a = sliceLevel(snapshotFromAscii(REFERENCE_ROWS, { offsetX: 2 }));
    const b = sliceLevel(snapshotFromAscii(REFERENCE_ROWS, { offsetX: 39 }));
    expect(b.length).toBe(a.length);
    expect(a.length).toBeGreaterThan(0);
    b.forEach((c, i) => {
      expect(c.rect).toEqual(shift(a[i].rect, 37));
      expect(c.rows).toEqual(a[i].rows);
      expect(c.entities).toEqual(a[i].entities);
      expect(c.tags).toEqual(a[i].tags);
      expect(c.measures).toEqual(a[i].measures);
    });
  });
});
