import { describe, expect, it } from "vitest";
import { LEVEL_H, LEVEL_W, TILE } from "../../../apps/editor/src/contracts";
import {
  clipRect,
  contentBounds,
  cropGrid,
  hasSolidBelow,
  headroom,
  isSolid,
  isStanding,
  parseAscii,
  renderAscii,
  snapshotFromAscii,
  tileAt,
} from "./grid";

const ROWS = [
  "....c...",
  "..BB..s.",
  "=?......",
  "##dd####",
];

describe("ASCII fixtures", () => {
  it("parses tiles, entities and start", () => {
    const p = parseAscii([...ROWS, "P......."]);
    expect(p.grid.w).toBe(8);
    expect(p.grid.h).toBe(5);
    expect(tileAt(p.grid, 2, 1)).toBe(TILE.BLOCK);
    expect(tileAt(p.grid, 0, 2)).toBe(TILE.GRASS_HALF);
    expect(tileAt(p.grid, 1, 2)).toBe(TILE.QUESTION);
    expect(tileAt(p.grid, 2, 3)).toBe(TILE.DIRT);
    expect(tileAt(p.grid, 0, 3)).toBe(TILE.GRASS);
    expect(p.entities.map((e) => [e.kind, e.x, e.y])).toEqual([
      ["coin", 4, 0],
      ["slime", 6, 1],
    ]);
    expect(p.start).toEqual({ x: 0, y: 4 });
  });

  it("round-trips through renderAscii", () => {
    const p = parseAscii(ROWS);
    expect(renderAscii(p.grid, p.entities)).toEqual(ROWS);
    expect(renderAscii(p.grid, p.entities, { x: 1, y: 1, w: 3, h: 2 })).toEqual([".BB", "?.."]);
  });

  it("rejects unknown glyphs", () => {
    expect(() => parseAscii(["..x."])).toThrow(/unknown glyph 'x'/);
  });

  it("pastes into a full level, bottom-aligned by default", () => {
    const s = snapshotFromAscii(ROWS, { offsetX: 10 });
    expect(s.w).toBe(LEVEL_W);
    expect(s.h).toBe(LEVEL_H);
    expect(s.cells.length).toBe(LEVEL_W * LEVEL_H);
    expect(isSolid(s, 10, LEVEL_H - 1)).toBe(true);
    expect(isSolid(s, 9, LEVEL_H - 1)).toBe(false);
    expect(s.entities.find((e) => e.kind === "coin")).toMatchObject({ x: 14, y: LEVEL_H - 4 });
    expect(s.authors[(LEVEL_H - 1) * LEVEL_W + 10]).toBe(1);
    expect(s.authors[0]).toBe(0);
  });

  it("drops content pasted outside the level", () => {
    const s = snapshotFromAscii(ROWS, { offsetX: LEVEL_W - 2 });
    expect(s.entities).toHaveLength(0);
    expect(isSolid(s, LEVEL_W - 1, LEVEL_H - 1)).toBe(true);
  });
});

describe("cell queries", () => {
  const { grid } = parseAscii(ROWS);
  it("standing, headroom and below", () => {
    expect(isStanding(grid, 0, 1)).toBe(true); // above '='
    expect(isStanding(grid, 2, 0)).toBe(true); // on the B
    expect(isStanding(grid, 2, 1)).toBe(false); // inside the B
    expect(isStanding(grid, 4, 2)).toBe(true);
    expect(isStanding(grid, 4, 3)).toBe(false);
    expect(headroom(grid, 2, 2)).toBe(1); // ceiling B right above
    expect(headroom(grid, 5, 2)).toBe(Infinity);
    expect(hasSolidBelow(grid, 5, 0)).toBe(true);
    expect(hasSolidBelow(grid, 5, 3)).toBe(false);
  });
  it("outside the grid is empty", () => {
    expect(isSolid(grid, -1, 3)).toBe(false);
    expect(isSolid(grid, 0, 4)).toBe(false);
    expect(isStanding(grid, 0, 3)).toBe(false);
  });
  it("clips rects and finds content", () => {
    expect(clipRect(grid, { x: -2, y: 1, w: 5, h: 10 })).toEqual({ x: 0, y: 1, w: 3, h: 3 });
    expect(clipRect(grid, { x: 20, y: 0, w: 5, h: 5 }).w).toBe(0);
    expect(contentBounds(grid, [])).toEqual({ x: 0, y: 1, w: 8, h: 3 });
    expect(contentBounds(grid, [{ kind: "coin", x: 4, y: 0 }])).toEqual({ x: 0, y: 0, w: 8, h: 4 });
    expect(contentBounds(parseAscii(["...."]).grid)).toBeNull();
    const c = cropGrid(grid, { x: 2, y: 1, w: 2, h: 1 });
    expect(c).toEqual({ w: 2, h: 1, cells: [TILE.BLOCK, TILE.BLOCK] });
  });
});
