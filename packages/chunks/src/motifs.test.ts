import { describe, expect, it } from "vitest";
import { mineMotifs, type MotifGrid } from "./motifs";

/** Rows of text ('#' solid) into a grid. */
function grid(rows: string[]): MotifGrid {
  const h = rows.length;
  const w = rows[0].length;
  const solid = new Uint8Array(w * h);
  rows.forEach((r, y) => {
    for (let x = 0; x < w; x++) if (r[x] === "#") solid[y * w + x] = 1;
  });
  return { w, h, solid };
}

describe("mineMotifs", () => {
  it("reads gap widths between stretches of ground, newest first", () => {
    const m = mineMotifs(
      grid([
        "....................",
        "....................",
        "####..####...#####..",
        "####..####...#####..",
      ]),
    );
    expect(m.motifs).toEqual([
      { kind: "pit", size: 3 },
      { kind: "pit", size: 2 },
    ]);
    expect(m.groundCols).toBe(13);
    expect(m.heights[0]).toBe(2);
    expect(m.heights[4]).toBeNull();
  });

  it("ignores the empty space after the drawing and gaps too wide to be a jump", () => {
    const m = mineMotifs(grid(["....................", "###..........###....", "###..........###...."]));
    expect(m.motifs).toEqual([]);
  });

  it("reads single steps with their direction (negative = up)", () => {
    const m = mineMotifs(
      grid([
        "................",
        "....####........",
        "########....####",
        "############....",
      ]),
    );
    // Up 1 at x=4; the drop at x=8 lands two rows lower; then up 1 at x=12.
    expect(m.motifs).toEqual(
      expect.arrayContaining([
        { kind: "step", size: -1 },
        { kind: "step", size: 2 },
      ]),
    );
  });

  it("reads a staircase as one shape: count, tread and rise", () => {
    const m = mineMotifs(
      grid([
        "..........##",
        "........####",
        "......######",
        "....########",
        "############",
      ]),
    );
    expect(m.motifs).toEqual([{ kind: "stairs", size: -4, tread: 2, rise: 1 }]);
  });

  it("reads a descending staircase with one-column treads", () => {
    const m = mineMotifs(grid(["###.....", "####....", "#####...", "########"]));
    expect(m.motifs).toEqual([{ kind: "stairs", size: 3, tread: 1, rise: 1 }]);
  });

  it("sets floating platforms aside and reports their width and height above the floor", () => {
    const m = mineMotifs(
      grid([
        "..............",
        ".....###......",
        "..............",
        "..............",
        "####.....#####",
        "####.....#####",
      ]),
    );
    expect(m.motifs).toEqual(expect.arrayContaining([{ kind: "platform", size: 3, rise: 3 }, { kind: "pit", size: 5 }]));
    // The platform is not ground: the columns under it stay a pit.
    expect(m.heights[6]).toBeNull();
  });

  it("honours the column range and the cap, and drops duplicates", () => {
    const g = grid(["##..##..##..##..##", "##..##..##..##..##"]);
    expect(mineMotifs(g).motifs).toEqual([{ kind: "pit", size: 2 }]);
    expect(mineMotifs(g, { x0: 0, x1: 1 }).motifs).toEqual([]);
    const many = mineMotifs(grid(["#..#...#....#.....#", "#..#...#....#.....#"]), { max: 2 });
    expect(many.motifs).toEqual([
      { kind: "pit", size: 5 },
      { kind: "pit", size: 4 },
    ]);
  });

  it("an empty grid has no shapes", () => {
    expect(mineMotifs(grid(["....", "...."]))).toEqual({ motifs: [], heights: [null, null, null, null], groundCols: 0 });
  });
});
