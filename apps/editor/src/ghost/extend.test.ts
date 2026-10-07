import { describe, expect, it } from "vitest";
import { TILE } from "../contracts";
import { makeSuggestion } from "../suggest/testUtils";
import { arrowRotation, boxInside, boxVisible, edgeArrow, leadingBox } from "./extend";

const row = (x0: number, n: number, y = 14) => Array.from({ length: n }, (_, i) => ({ x: x0 + i, y, tile: TILE.GRASS }));

describe("leadingBox", () => {
  it("takes the third nearest the anchor for a long horizontal ghost", () => {
    const s = makeSuggestion({ kind: "extend", adds: row(40, 9), anchor: { x: 40, y: 14 } });
    expect(leadingBox(s)).toEqual({ x0: 40, x1: 42, y0: 14, y1: 14 });
  });

  it("works from the right when the anchor is at the right end", () => {
    const s = makeSuggestion({ kind: "extend", adds: row(40, 9), anchor: { x: 48, y: 14 } });
    expect(leadingBox(s)).toEqual({ x0: 46, x1: 48, y0: 14, y1: 14 });
  });

  it("keeps the full vertical extent of a horizontal ghost", () => {
    const adds = [...row(10, 6, 14), { x: 15, y: 12, tile: TILE.BLOCK }];
    const s = makeSuggestion({ kind: "extend", adds, anchor: { x: 10, y: 14 } });
    const b = leadingBox(s);
    expect(b.y0).toBe(12);
    expect(b.y1).toBe(14);
    expect(b.x0).toBe(10);
    expect(b.x1).toBe(12);
  });

  it("uses the vertical axis for a tower", () => {
    const adds = Array.from({ length: 6 }, (_, i) => ({ x: 5, y: 15 - i, tile: TILE.BLOCK }));
    const s = makeSuggestion({ kind: "extend", adds, anchor: { x: 5, y: 15 } });
    expect(leadingBox(s)).toEqual({ x0: 5, x1: 5, y0: 14, y1: 15 });
  });

  it("falls back to the anchor for an empty suggestion", () => {
    const s = makeSuggestion({ adds: [], anchor: { x: 7, y: 8 } });
    expect(leadingBox(s)).toEqual({ x0: 7, y0: 8, x1: 7, y1: 8 });
  });
});

describe("edgeArrow", () => {
  const view = { x: 0, y: 0, w: 40, h: 20 };

  it("is null when the ghost is on screen", () => {
    expect(edgeArrow(view, { x0: 5, y0: 5, x1: 10, y1: 6 })).toBeNull();
    expect(boxInside(view, { x0: 5, y0: 5, x1: 10, y1: 6 })).toBe(true);
  });

  it("points right for a ghost past the right edge, level with the ghost", () => {
    const a = edgeArrow(view, { x0: 38, y0: 10, x1: 49, y1: 11 }, 1);
    expect(a).not.toBeNull();
    expect(a!.side).toBe("right");
    expect(a!.at).toEqual({ x: 39, y: 11 });
    expect(a!.beyond).toBe(10);
  });

  it("points left / up / down", () => {
    expect(edgeArrow(view, { x0: -20, y0: 5, x1: -10, y1: 5 })!.side).toBe("left");
    expect(edgeArrow(view, { x0: 5, y0: -6, x1: 6, y1: -3 })!.side).toBe("up");
    expect(edgeArrow(view, { x0: 5, y0: 22, x1: 6, y1: 24 })!.side).toBe("down");
  });

  it("clamps the arrow to the edge for ghosts far off screen", () => {
    const a = edgeArrow(view, { x0: 100, y0: 50, x1: 102, y1: 51 }, 1)!;
    expect(a.side).toBe("right");
    expect(a.at.y).toBe(19);
    expect(boxVisible(view, { x0: 100, y0: 50, x1: 102, y1: 51 })).toBe(false);
  });

  it("works with fractional views", () => {
    const v = { x: 10.5, y: 0, w: 30.25, h: 20 };
    expect(edgeArrow(v, { x0: 11, y0: 3, x1: 40, y1: 3 })).toBeNull();
    expect(edgeArrow(v, { x0: 11, y0: 3, x1: 41, y1: 3 })!.side).toBe("right");
  });

  it("rotates the glyph per side", () => {
    expect(arrowRotation("right")).toBe(0);
    expect(arrowRotation("down")).toBe(90);
    expect(arrowRotation("left")).toBe(180);
    expect(arrowRotation("up")).toBe(270);
  });
});
