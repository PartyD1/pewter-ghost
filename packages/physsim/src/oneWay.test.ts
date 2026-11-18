/**
 * One-way platforms (`-` here, the Grass half tile in a level): the knight
 * jumps up and walks sideways through them, stands on them, and drops through
 * by holding down. Physics parity with Phaser is in sim.parity.test.ts.
 */
import { describe, expect, it } from "vitest";
import { TILE } from "../../../apps/editor/src/contracts";
import { gridFromCells, gridFromRows, type SolidGrid } from "./grid";
import { bodyCell, frame, Level, search, spawnBody, type Body, type Input } from "./sim";

/** Run `n` frames of one input; returns the body. */
function hold(L: Level, b: Body, n: number, inp: Input): Body {
  for (let i = 0; i < n; i++) frame(L, b, inp.move, inp.jump, inp.down);
  return b;
}

const IDLE: Input = { move: 0, jump: false };

/** Ground at row 8, a full-width platform at `row`. */
function platformOver(row: number, ch = "-"): SolidGrid {
  const rows = Array.from({ length: 9 }, () => "..........");
  rows[row] = ch.repeat(10);
  rows[8] = "##########";
  return gridFromRows(rows);
}

describe("one-way platforms", () => {
  it("a full jump goes up through a platform and lands on top of it", () => {
    const L = new Level(platformOver(4));
    const b = hold(L, spawnBody(2, 7, L), 30, { move: 0, jump: true });
    hold(L, b, 60, IDLE);
    expect(b.down).toBe(true);
    expect(bodyCell(b)).toEqual({ x: 2, y: 3 });
  });

  it("the same platform as a solid block stops the jump (head bonk)", () => {
    const L = new Level(platformOver(4, "#"));
    const b = hold(L, spawnBody(2, 7, L), 30, { move: 0, jump: true });
    hold(L, b, 60, IDLE);
    expect(bodyCell(b)).toEqual({ x: 2, y: 7 });
  });

  it("a jump whose feet stay inside the platform falls back down instead of popping up", () => {
    // Row 3's top is 4 tiles + 1 above the feet: the apex (4.6 tiles) ends with the feet inside it.
    const L = new Level(platformOver(3));
    const b = hold(L, spawnBody(2, 7, L), 30, { move: 0, jump: true });
    hold(L, b, 90, IDLE);
    expect(b.down).toBe(true);
    expect(bodyCell(b)).toEqual({ x: 2, y: 7 });
  });

  it("walks sideways through platform tiles in its own row", () => {
    const g = gridFromRows(["..........", "...---....", "##########"]);
    const L = new Level(g);
    const b = hold(L, spawnBody(0, 1, L), 60, { move: 1, jump: false });
    expect(b.down).toBe(true);
    expect(bodyCell(b).y).toBe(1);
    expect(bodyCell(b).x).toBeGreaterThanOrEqual(7);
  });

  it("stands on a platform, and holding down drops through it to the ground", () => {
    const L = new Level(platformOver(4));
    const b = spawnBody(2, 3, L);
    expect(b.down).toBe(true);
    hold(L, b, 20, IDLE);
    expect(bodyCell(b)).toEqual({ x: 2, y: 3 });
    hold(L, b, 1, { move: 0, jump: false, down: true });
    hold(L, b, 60, IDLE);
    expect(b.down).toBe(true);
    expect(bodyCell(b)).toEqual({ x: 2, y: 7 });
  });

  it("holding down on solid ground, or half on solid ground, does nothing", () => {
    // Feet over the block at x=3 and the platform at x=4 (spawn centres the 10 px body in the cell, then nudge right).
    const L2 = new Level(gridFromRows(["..........", "...#------", "..........", "##########"]));
    const b2 = spawnBody(3, 0, L2);
    b2.x += 4;
    hold(L2, b2, 30, { move: 0, jump: false, down: true });
    expect(b2.down).toBe(true);
    expect(bodyCell(b2).y).toBe(0);
    // And plain ground.
    const L3 = new Level(platformOver(4));
    const b3 = hold(L3, spawnBody(2, 7, L3), 30, { move: 0, jump: false, down: true });
    expect(bodyCell(b3)).toEqual({ x: 2, y: 7 });
    expect(b3.down).toBe(true);
  });

  it("holding down through a stack of platforms falls through all of them", () => {
    const L = new Level(gridFromRows(["..........", "----------", "----------", "..........", "..........", "##########"]));
    const b = spawnBody(2, 0, L);
    hold(L, b, 10, IDLE);
    expect(bodyCell(b).y).toBe(0);
    hold(L, b, 60, { move: 0, jump: false, down: true });
    expect(bodyCell(b)).toEqual({ x: 2, y: 4 });
  });

  it("the agent drops through a platform to reach a goal below it, and jumps up through one", () => {
    const box = gridFromRows([
      "#........#",
      "#........#",
      "#........#",
      "#--------#",
      "#........#",
      "#........#",
      "#........#",
      "##########",
    ]);
    const down = search(box, { x: 4, y: 2 }, { x: 2, y: 6 }, { capMs: 5000 });
    expect(down.found).toBe(true);
    expect(down.inputs!.some((i) => i.down)).toBe(true);
    const up = search(box, { x: 4, y: 6 }, { x: 6, y: 2 }, { capMs: 5000 });
    expect(up.found).toBe(true);
    // A solid ceiling instead: no way up.
    const shut = gridFromRows(["#........#", "#........#", "#........#", "##########", "#........#", "#........#", "#........#", "##########"]);
    const r = search(shut, { x: 4, y: 6 }, { x: 6, y: 2 }, { capMs: 20_000 });
    expect(r.found).toBe(false);
  });

  it("a level's Grass half tiles are one-way in the agent's grid", () => {
    const cells = [0, 0, 0, TILE.GRASS_HALF, TILE.GRASS_HALF, TILE.GRASS_HALF, 0, 0, 0, 0, 0, 0, TILE.GRASS, TILE.GRASS, TILE.GRASS];
    const g = gridFromCells(cells, 3, 5);
    const L = new Level(g);
    const b = hold(L, spawnBody(1, 3, L), 30, { move: 0, jump: true });
    hold(L, b, 60, IDLE);
    expect(bodyCell(b)).toEqual({ x: 1, y: 0 });
  });
});
