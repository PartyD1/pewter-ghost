import { describe, expect, it } from "vitest";
import { TILE } from "../../../apps/editor/src/contracts";
import {
  goalColumns,
  goalPredicate,
  gridFromCells,
  gridFromMatrix,
  gridFromRows,
  gridToRows,
  isStandable,
  settleStart,
  surfaces,
  toUint8Grid,
} from "./grid";

const ROWS = [
  "..........", //
  "......##..",
  "..........",
  "##..######",
  "##..######",
];

describe("grid helpers", () => {
  it("parses ASCII rows and renders them back", () => {
    const g = gridFromRows(ROWS);
    expect(g.w).toBe(10);
    expect(g.h).toBe(5);
    expect(g.solid[3 * 10 + 0]).toBe(1);
    expect(g.solid[3 * 10 + 2]).toBe(0);
    expect(gridToRows(g)).toEqual(ROWS);
    expect(gridToRows(g, { "0,0": "S" })[0]).toBe("S.........");
  });

  it("pads short rows with empty cells", () => {
    const g = gridFromRows(["#", "###"]);
    expect(g.w).toBe(3);
    expect([...g.solid]).toEqual([1, 0, 0, 1, 1, 1]);
  });

  it("builds from a matrix and from level tile ids", () => {
    const m = gridFromMatrix([
      [0, 1],
      [1, 0],
    ]);
    expect([...m.solid]).toEqual([0, 1, 1, 0]);
    const c = gridFromCells([TILE.EMPTY, TILE.GRASS, TILE.QUESTION, 2, TILE.DIRT, TILE.GRASS_HALF], 3, 2);
    expect([...c.solid]).toEqual([0, 1, 1, 0, 1, 1]);
    expect([...toUint8Grid({ w: 2, h: 1, solid: [true, false] }).solid]).toEqual([1, 0]);
  });

  it("knows standing cells (out of bounds is empty, never standable)", () => {
    const g = gridFromRows(ROWS);
    expect(isStandable(g, 0, 2)).toBe(true);
    expect(isStandable(g, 2, 2)).toBe(false); // over the pit
    expect(isStandable(g, 6, 0)).toBe(true); // on the floating slab
    expect(isStandable(g, 0, 4)).toBe(false); // bottom row has nothing below
    expect(isStandable(g, -1, 2)).toBe(false);
  });

  it("settles a start onto the surface below, or above when inside a block", () => {
    const g = gridFromRows(ROWS);
    expect(settleStart(g, { x: 0, y: 0 })).toEqual({ x: 0, y: 2 });
    expect(settleStart(g, { x: 0, y: 4 })).toEqual({ x: 0, y: 2 });
    expect(settleStart(g, { x: 6, y: 0 })).toEqual({ x: 6, y: 0 });
    expect(settleStart(g, { x: 2, y: 0 })).toBeNull(); // bottomless pit
    expect(settleStart(g, { x: 40, y: 0 })).toBeNull();
  });

  it("lists surfaces as maximal runs, optionally inside a column window", () => {
    const g = gridFromRows(ROWS);
    expect(surfaces(g)).toEqual([
      { y: 2, x0: 0, x1: 1 },
      { y: 2, x0: 4, x1: 9 },
      { y: 0, x0: 6, x1: 7 },
    ]);
    expect(surfaces(g, [5, 6])).toEqual([
      { y: 2, x0: 5, x1: 6 },
      { y: 0, x0: 6, x1: 6 },
    ]);
  });

  it("compiles goals: point, rectangle, predicate", () => {
    expect(goalPredicate({ x: 3, y: 4 })(3, 4)).toBe(true);
    expect(goalPredicate({ x: 3, y: 4 })(3, 5)).toBe(false);
    const r = goalPredicate({ x0: 10 });
    expect(r(10, 0)).toBe(true);
    expect(r(9, 0)).toBe(false);
    expect(goalPredicate({ x0: 1, x1: 2, y0: 3, y1: 3 })(2, 3)).toBe(true);
    expect(goalPredicate(({ x }) => x % 2 === 0)(4, 0)).toBe(true);
    expect(goalColumns({ x: 3, y: 4 })).toEqual([3, 3]);
    expect(goalColumns({ x0: 7 })).toEqual([7, Infinity]);
    expect(goalColumns(() => true)).toBeNull();
    expect(goalColumns(() => true, { x: 5, y: 0 })).toEqual([5, 5]);
  });
});
