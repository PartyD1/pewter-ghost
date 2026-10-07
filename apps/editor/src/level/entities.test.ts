import { describe, expect, it } from "vitest";
import { TILE } from "../contracts";
import { computePatrol, idCounterOf, isCollectableKind, isEnemyKind, isEntityKind, samePatrol } from "./entities";
import { LevelModel } from "./LevelModel";

/** Build a model from ASCII rows: '#' solid, '.' empty. */
function fromRows(rows: string[]): LevelModel {
  const m = new LevelModel({ w: rows[0].length, h: rows.length, start: { x: 0, y: 0 } });
  const cells = [];
  for (let y = 0; y < rows.length; y++)
    for (let x = 0; x < rows[y].length; x++) if (rows[y][x] === "#") cells.push({ x, y, tile: TILE.BLOCK });
  m.paint(cells);
  return m;
}

describe("computePatrol", () => {
  it("spans the contiguous floor under the enemy", () => {
    const m = fromRows([
      "..........",
      "..........",
      ".######...",
      "##########",
    ]);
    expect(computePatrol(m, 3, 1)).toEqual([1, 6]);
    expect(computePatrol(m, 1, 1)).toEqual([1, 6]);
    expect(computePatrol(m, 8, 2)).toEqual([7, 9]);
  });

  it("stops at walls on the walking row", () => {
    const m = fromRows([
      "..#.......",
      "##########",
    ]);
    expect(computePatrol(m, 5, 0)).toEqual([3, 9]);
    expect(computePatrol(m, 0, 0)).toEqual([0, 1]);
  });

  it("stops at gaps in the floor", () => {
    const m = fromRows([
      "..........",
      "###.##.###",
    ]);
    expect(computePatrol(m, 4, 0)).toEqual([4, 5]);
    expect(computePatrol(m, 0, 0)).toEqual([0, 2]);
  });

  it("returns undefined without a floor, inside a tile or outside the level", () => {
    const m = fromRows([
      "....",
      ".#..",
      "....",
    ]);
    expect(computePatrol(m, 2, 0)).toBeUndefined();
    expect(computePatrol(m, 1, 1)).toBeUndefined();
    expect(computePatrol(m, 1, 2)).toBeUndefined(); // bottom row: floor is outside
    expect(computePatrol(m, -1, 0)).toBeUndefined();
    expect(computePatrol(m, 1, 0)).toEqual([1, 1]);
  });
});

describe("entity helpers", () => {
  it("classifies kinds", () => {
    expect(isEntityKind("coin")).toBe(true);
    expect(isEntityKind("dragon")).toBe(false);
    expect(isEntityKind(3)).toBe(false);
    expect(isEnemyKind("slime")).toBe(true);
    expect(isEnemyKind("coin")).toBe(false);
    expect(isCollectableKind("fruit")).toBe(true);
    expect(isCollectableKind("flag")).toBe(false);
  });

  it("compares patrols and parses id counters", () => {
    expect(samePatrol(undefined, undefined)).toBe(true);
    expect(samePatrol([1, 2], [1, 2])).toBe(true);
    expect(samePatrol([1, 2], undefined)).toBe(false);
    expect(samePatrol([1, 2], [1, 3])).toBe(false);
    expect(idCounterOf("e42")).toBe(42);
    expect(idCounterOf("x42")).toBe(0);
    expect(idCounterOf("e")).toBe(0);
    expect(idCounterOf("e1.5")).toBe(0);
  });
});
