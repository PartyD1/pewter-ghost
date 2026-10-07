import { describe, expect, it } from "vitest";
import { TILE } from "../contracts";
import { makeSuggestion } from "../suggest/testUtils";
import { dashSegments, fadeProgress, outlineEdges, planGhost, planSize } from "./plan";

describe("outlineEdges", () => {
  it("draws a single cell as four unit edges", () => {
    const e = outlineEdges([{ x: 3, y: 4 }]);
    expect(e).toHaveLength(4);
    expect(e).toContainEqual({ x0: 3, y0: 4, x1: 4, y1: 4 });
    expect(e).toContainEqual({ x0: 3, y0: 5, x1: 4, y1: 5 });
    expect(e).toContainEqual({ x0: 3, y0: 4, x1: 3, y1: 5 });
    expect(e).toContainEqual({ x0: 4, y0: 4, x1: 4, y1: 5 });
  });

  it("merges a row of cells into one rectangle (no inner edges)", () => {
    const e = outlineEdges([0, 1, 2, 3].map((x) => ({ x: 10 + x, y: 2 })));
    expect(e).toHaveLength(4);
    expect(e).toContainEqual({ x0: 10, y0: 2, x1: 14, y1: 2 });
    expect(e).toContainEqual({ x0: 10, y0: 3, x1: 14, y1: 3 });
  });

  it("outlines an L shape with six runs and the right perimeter", () => {
    const cells = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];
    const e = outlineEdges(cells);
    const perimeter = e.reduce((n, s) => n + Math.abs(s.x1 - s.x0) + Math.abs(s.y1 - s.y0), 0);
    expect(perimeter).toBe(8);
    expect(e).toHaveLength(6);
  });

  it("keeps separate pieces separate and ignores duplicates", () => {
    const e = outlineEdges([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ]);
    expect(e).toHaveLength(8);
  });

  it("is empty for no cells", () => {
    expect(outlineEdges([])).toEqual([]);
  });
});

describe("planGhost", () => {
  const s = makeSuggestion({
    kind: "fix",
    adds: [
      { x: 10, y: 15, tile: TILE.GRASS },
      { x: 11, y: 15, tile: TILE.GRASS },
    ],
    removes: [{ x: 12, y: 15 }],
    entities: [{ kind: "coin", x: 11, y: 14 }],
  });

  it("splits adds, removes and entities and outlines adds + entities only", () => {
    const p = planGhost(s);
    expect(p.adds).toHaveLength(2);
    expect(p.removes).toEqual([{ x: 12, y: 15 }]);
    expect(p.entities).toEqual([{ kind: "coin", x: 11, y: 14 }]);
    expect(p.box).toEqual({ x0: 10, y0: 14, x1: 12, y1: 15 });
    // Removal cell is not inside the dashed outline.
    expect(p.outline.some((e) => e.x0 === 13 || e.x1 === 13)).toBe(false);
    expect(planSize(p)).toBe(4);
  });

  it("limits the plan to the remaining cells (partial accept) but keeps the box", () => {
    const p = planGhost(s, [{ type: "add", x: 11, y: 15, tile: TILE.GRASS }, { type: "remove", x: 12, y: 15 }]);
    expect(p.adds).toEqual([{ x: 11, y: 15, tile: TILE.GRASS }]);
    expect(p.entities).toEqual([]);
    expect(p.removes).toHaveLength(1);
    expect(p.box).toEqual({ x0: 10, y0: 14, x1: 12, y1: 15 });
  });
});

describe("dashSegments", () => {
  it("covers a line with dashes and gaps and clips the last dash", () => {
    const d = dashSegments(0, 0, 10, 0, 4, 2);
    expect(d).toEqual([
      [0, 0, 4, 0],
      [6, 0, 10, 0],
    ]);
    const v = dashSegments(0, 0, 0, 5, 4, 3);
    expect(v).toEqual([[0, 0, 0, 4]]);
  });

  it("returns nothing for a zero-length line or zero dash", () => {
    expect(dashSegments(1, 1, 1, 1, 4, 2)).toEqual([]);
    expect(dashSegments(0, 0, 5, 0, 0, 2)).toEqual([]);
  });
});

describe("fadeProgress", () => {
  it("goes 0 → 1 over the duration and treats 0 ms as done", () => {
    expect(fadeProgress(100, 100, 120)).toBe(0);
    expect(fadeProgress(160, 100, 120)).toBeCloseTo(0.5);
    expect(fadeProgress(500, 100, 120)).toBe(1);
    expect(fadeProgress(0, 100, 120)).toBe(0);
    expect(fadeProgress(100, 100, 0)).toBe(1);
  });
});
