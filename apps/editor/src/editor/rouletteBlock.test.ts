import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bumpTarget, faceAt, facePhase, ROULETTE, ROULETTE_CYCLE_MS, RouletteBlocks, slimeCell } from "./rouletteBlock";

const T = 16;

describe("faceAt", () => {
  it("cycles coin, fruit, slime, each for faceMs", () => {
    // (0, 0) starts at the first face.
    expect(facePhase(0, 0)).toBe(0);
    expect(faceAt(0, 0, 0)).toBe("coin");
    expect(faceAt(ROULETTE.faceMs - 1, 0, 0)).toBe("coin");
    expect(faceAt(ROULETTE.faceMs, 0, 0)).toBe("fruit");
    expect(faceAt(2 * ROULETTE.faceMs, 0, 0)).toBe("slime");
    expect(faceAt(3 * ROULETTE.faceMs, 0, 0)).toBe("coin");
  });

  it("neighbours in a row and in a column show different faces", () => {
    for (const t of [0, 250, 700, 1900]) {
      expect(faceAt(t, 10, 5)).not.toBe(faceAt(t, 11, 5));
      expect(faceAt(t, 10, 5)).not.toBe(faceAt(t, 10, 6));
    }
  });

  it("repeats every cycle and gives every face equal time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600_000 }), fc.integer({ min: 0, max: 199 }), fc.integer({ min: 0, max: 19 }), (t, x, y) => {
        expect(faceAt(t + ROULETTE_CYCLE_MS, x, y)).toBe(faceAt(t, x, y));
        const seen = new Set(ROULETTE.faces.map((_, i) => faceAt(t + i * ROULETTE.faceMs, x, y)));
        expect(seen.size).toBe(ROULETTE.faces.length);
      }),
    );
  });

  it("treats a negative clock as the start", () => {
    expect(faceAt(-50, 3, 4)).toBe(faceAt(0, 3, 4));
  });
});

describe("bumpTarget", () => {
  const blocks = (...cells: [number, number][]) => {
    const set = new Set(cells.map(([x, y]) => `${x},${y}`));
    return (x: number, y: number) => set.has(`${x},${y}`);
  };
  /** A 10 px wide head whose top rests under row `row`, starting at px `left`. */
  const head = (left: number, row: number) => ({ left, right: left + 10, top: (row + 1) * T });

  it("finds the block straight above the head", () => {
    expect(bumpTarget(head(5 * T + 3, 4), blocks([5, 4]), T)).toEqual({ x: 5, y: 4 });
  });

  it("is undefined when what was hit is not a question block", () => {
    expect(bumpTarget(head(5 * T + 3, 4), blocks([7, 4], [5, 3]), T)).toBeUndefined();
  });

  it("picks the block the head overlaps more", () => {
    const two = blocks([5, 4], [6, 4]);
    expect(bumpTarget(head(5 * T + 8, 4), two, T)).toEqual({ x: 5, y: 4 }); // 8 px on 5, 2 px on 6
    expect(bumpTarget(head(5 * T + 13, 4), two, T)).toEqual({ x: 6, y: 4 }); // 3 px on 5, 7 px on 6
    expect(bumpTarget(head(5 * T + 11, 4), two, T)).toEqual({ x: 5, y: 4 }); // 5 px each: left wins
  });

  it("hits a block the head only clips when the other tile is something else", () => {
    expect(bumpTarget(head(5 * T + 13, 4), blocks([5, 4]), T)).toEqual({ x: 5, y: 4 });
  });

  it("does not reach a block the head stops exactly beside", () => {
    // Head spans px 96..106 (column 6 only); the block is column 5.
    expect(bumpTarget(head(6 * T, 4), blocks([5, 4]), T)).toBeUndefined();
    // Head spans px 86..96: its right edge touches column 6 without entering it.
    expect(bumpTarget(head(6 * T - 10, 4), blocks([6, 4]), T)).toBeUndefined();
  });
});

describe("slimeCell", () => {
  it("is the cell on top of the block when that is open", () => {
    expect(slimeCell(4, 6, () => false)).toEqual({ x: 4, y: 5 });
  });

  it("is the cell underneath when the top is covered or off the level", () => {
    expect(slimeCell(4, 6, (x, y) => x === 4 && y === 5)).toEqual({ x: 4, y: 7 });
    expect(slimeCell(4, 0, () => false)).toEqual({ x: 4, y: 1 });
  });
});

describe("RouletteBlocks", () => {
  it("pays out the face showing at the moment of the hit, once", () => {
    const r = new RouletteBlocks();
    const t = ROULETTE.faceMs + 10;
    expect(r.isUsed(0, 0)).toBe(false);
    expect(r.bump(0, 0, t)).toBe("fruit");
    expect(r.isUsed(0, 0)).toBe(true);
    expect(r.bump(0, 0, t + ROULETTE.faceMs)).toBeUndefined();
    expect(r.isUsed(1, 0)).toBe(false);
  });

  it("refill brings every block back but keeps the totals", () => {
    const r = new RouletteBlocks();
    r.bump(0, 0, 0); // coin
    r.bump(1, 0, 0); // next face along
    r.refill();
    expect(r.isUsed(0, 0)).toBe(false);
    expect(r.bump(0, 0, 0)).toBe("coin");
    expect(r.counts).toEqual({ coin: 2, fruit: 1, slime: 0 });
  });

  it("counts is a copy", () => {
    const r = new RouletteBlocks();
    const c = r.counts;
    c.coin = 99;
    expect(r.counts.coin).toBe(0);
  });
});
