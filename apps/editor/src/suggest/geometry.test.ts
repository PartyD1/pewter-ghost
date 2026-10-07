import { describe, expect, it } from "vitest";
import { TILE } from "../contracts";
import {
  boxesOverlap,
  cellSignature,
  distanceToBox,
  ghostCellMap,
  ghostCells,
  problemKey,
  relatePlacement,
  suggestionBox,
  touchedKeys,
} from "./geometry";
import { asVerified, isVerified } from "./verified";
import { erase, makeSuggestion, paint, placeEntity } from "./testUtils";

const fix = makeSuggestion({
  kind: "fix",
  adds: [{ x: 5, y: 10, tile: TILE.GRASS }],
  removes: [{ x: 7, y: 12 }],
  entities: [{ kind: "coin", x: 6, y: 9 }],
  label: "Gap 9 ·  knight clears 6",
  anchor: { x: 7, y: 12 },
});

describe("geometry", () => {
  it("lists every touched cell", () => {
    expect(ghostCells(fix)).toEqual([
      { x: 5, y: 10, type: "add", tile: TILE.GRASS },
      { x: 7, y: 12, type: "remove" },
      { x: 6, y: 9, type: "entity", kind: "coin" },
    ]);
    expect([...touchedKeys(fix)].sort()).toEqual(["5,10", "6,9", "7,12"]);
  });

  it("computes the bounding box, or the anchor when empty", () => {
    expect(suggestionBox(fix)).toEqual({ x0: 5, y0: 9, x1: 7, y1: 12 });
    const empty = makeSuggestion({ adds: [], anchor: { x: 3, y: 4 } });
    expect(suggestionBox(empty)).toEqual({ x0: 3, y0: 4, x1: 3, y1: 4 });
  });

  it("overlaps with a margin", () => {
    const a = { x0: 0, y0: 0, x1: 2, y1: 2 };
    expect(boxesOverlap(a, { x0: 2, y0: 2, x1: 4, y1: 4 })).toBe(true);
    expect(boxesOverlap(a, { x0: 3, y0: 0, x1: 4, y1: 1 })).toBe(false);
    expect(boxesOverlap(a, { x0: 3, y0: 0, x1: 4, y1: 1 }, 1)).toBe(true);
    expect(boxesOverlap(a, { x0: 0, y0: 4, x1: 1, y1: 5 }, 1)).toBe(false);
  });

  it("measures Chebyshev distance to a box", () => {
    const b = { x0: 10, y0: 10, x1: 12, y1: 12 };
    expect(distanceToBox({ x: 11, y: 11 }, b)).toBe(0);
    expect(distanceToBox({ x: 5, y: 11 }, b)).toBe(5);
    expect(distanceToBox({ x: 14, y: 15 }, b)).toBe(3);
  });

  it("relates placements: match, conflict, outside", () => {
    const m = ghostCellMap(fix);
    expect(relatePlacement(m, paint(0, 5, 10, TILE.GRASS)).relation).toBe("match");
    expect(relatePlacement(m, paint(0, 5, 10, TILE.DIRT)).relation).toBe("conflict");
    expect(relatePlacement(m, erase(0, 5, 10)).relation).toBe("conflict");
    expect(relatePlacement(m, erase(0, 7, 12)).relation).toBe("match");
    expect(relatePlacement(m, paint(0, 7, 12)).relation).toBe("conflict");
    expect(relatePlacement(m, placeEntity(0, 6, 9, "coin")).relation).toBe("match");
    expect(relatePlacement(m, placeEntity(0, 6, 9, "slime")).relation).toBe("conflict");
    expect(relatePlacement(m, paint(0, 6, 9)).relation).toBe("conflict");
    expect(relatePlacement(m, paint(0, 50, 9)).relation).toBe("outside");
  });

  it("signature ignores order", () => {
    const a = makeSuggestion({ adds: [{ x: 1, y: 1, tile: 1 }, { x: 2, y: 1, tile: 1 }] });
    const b = makeSuggestion({ adds: [{ x: 2, y: 1, tile: 1 }, { x: 1, y: 1, tile: 1 }] });
    const c = makeSuggestion({ adds: [{ x: 2, y: 1, tile: 5 }, { x: 1, y: 1, tile: 1 }] });
    expect(cellSignature(a)).toBe(cellSignature(b));
    expect(cellSignature(a)).not.toBe(cellSignature(c));
  });

  it("problem key normalises the label and uses the anchor", () => {
    expect(problemKey(fix)).toBe("gap 9 · knight clears 6@7,12");
    expect(problemKey({ label: " gap 9 · KNIGHT clears 6", anchor: { x: 7, y: 12 } })).toBe(
      problemKey(fix),
    );
  });
});

describe("verified brand", () => {
  it("asVerified brands a copy; isVerified checks it", () => {
    const raw = { ...makeSuggestion(), verified: false } as unknown as Parameters<typeof asVerified>[0];
    delete (raw as { __verified?: true }).__verified;
    expect(isVerified(raw)).toBe(false);
    const v = asVerified(raw);
    expect(isVerified(v)).toBe(true);
    expect(raw.verified).toBe(false);
    expect(isVerified(null)).toBe(false);
  });
});
