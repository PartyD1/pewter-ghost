import { describe, expect, it } from "vitest";
import { detectFinish, type DetectGrid, type DetectPlacement } from "./detect";

const GRASS = 6;

/** '#' grass, 'o' coin, 'X' blocked, '.' empty. */
function grid(rows: string[]): DetectGrid {
  const h = rows.length;
  const w = rows[0].length;
  const tiles = new Uint8Array(w * h);
  const blocked = new Uint8Array(w * h);
  const entities: DetectGrid["entities"][number][] = [];
  rows.forEach((r, y) =>
    [...r].forEach((ch, x) => {
      if (ch === "#") tiles[y * w + x] = GRASS;
      if (ch === "X") blocked[y * w + x] = 1;
      if (ch === "o") entities.push({ kind: "coin", x, y });
    }),
  );
  return { w, h, tiles, blocked, entities };
}

const paint = (pts: [number, number][], tile = "grass"): DetectPlacement[] =>
  pts.map(([x, y]) => ({ x, y, tile, tool: "paint" }));

/** Mark cells solid (or coins) in rows. */
function draw(rows: string[], pts: [number, number][], ch = "#"): string[] {
  const g = rows.map((r) => [...r]);
  for (const [x, y] of pts) g[y][x] = ch;
  return g.map((r) => r.join(""));
}

const blank = (w: number, h: number, groundRow?: number) =>
  Array.from({ length: h }, (_, y) => (groundRow !== undefined && y >= groundRow ? "#" : ".").repeat(w));

const cells = (xs: { x: number; y: number }[]) => xs.map((c) => [c.x, c.y]);

describe("detectFinish: single-cell repeats", () => {
  it("finishes a rising staircase with a coin on top", () => {
    const pts: [number, number][] = [[2, 9], [3, 8], [4, 7]];
    const [best] = detectFinish(grid(draw(blank(16, 12, 10), pts)), paint(pts));
    expect(best.pattern).toBe("staircase");
    expect(best.repeats).toBe(3);
    expect(best.touchesLast).toBe(true);
    expect(cells(best.adds)).toEqual([[5, 6], [6, 5], [7, 4]]);
    expect(best.entities).toEqual([{ kind: "coin", x: 7, y: 3 }]);
    expect(best.adds.every((a) => a.tile === "grass")).toBe(true);
  });

  it("continues a row by four and a column down to the floor", () => {
    const row: [number, number][] = [[2, 5], [3, 5], [4, 5]];
    const r = detectFinish(grid(draw(blank(16, 12, 10), row)), paint(row))[0];
    expect(r.pattern).toBe("row");
    expect(cells(r.adds)).toEqual([[5, 5], [6, 5], [7, 5], [8, 5]]);

    const col: [number, number][] = [[5, 5], [5, 6], [5, 7]];
    const c = detectFinish(grid(draw(blank(16, 12, 10), col)), paint(col))[0];
    expect(c.pattern).toBe("column");
    expect(cells(c.adds)).toEqual([[5, 8], [5, 9]]); // stops at the ground (row 10)
  });

  it("stops at obstacles and the window edge", () => {
    const pts: [number, number][] = [[10, 9], [11, 8], [12, 7]];
    const rows = draw(draw(blank(14, 12, 10), pts), [[14 - 1, 6]], "X");
    const r = detectFinish(grid(rows), paint(pts));
    expect(r.length === 0 || r[0].pattern !== "staircase" || r[0].adds.length === 0).toBe(true);
  });

  it("two cells are a weak repeat; spaced cells need three", () => {
    const two: [number, number][] = [[2, 9], [3, 8]];
    const r = detectFinish(grid(draw(blank(16, 12, 10), two)), paint(two))[0];
    expect(r.pattern).toBe("staircase");
    expect(r.repeats).toBe(2);
    const spaced2: [number, number][] = [[2, 7], [5, 7]];
    expect(detectFinish(grid(draw(blank(16, 12, 10), spaced2)), paint(spaced2)).filter((p) => p.pattern === "spaced")).toEqual([]);
    const spaced3: [number, number][] = [[2, 7], [5, 7], [8, 7]];
    const s = detectFinish(grid(draw(blank(16, 12, 10), spaced3)), paint(spaced3))[0];
    expect(s.pattern).toBe("spaced");
    expect(cells(s.adds)).toEqual([[11, 7], [14, 7]]);
  });

  it("ignores erased cells and erase events", () => {
    const pts: [number, number][] = [[2, 9], [3, 8], [4, 7]];
    // (4,7) was painted then erased: it is not in the grid.
    const rows = draw(blank(16, 12, 10), pts.slice(0, 2));
    const recent = [...paint(pts), { x: 4, y: 7, tile: "erase", tool: "erase" as const }];
    const [best] = detectFinish(grid(rows), recent);
    expect(best.repeats).toBe(2);
    expect(cells(best.adds)[0]).toEqual([4, 7]);
  });
});

describe("detectFinish: unit repeats", () => {
  const pillar = (x: number): [number, number][] => [[x, 7], [x, 8], [x, 9]];

  it("repeats grounded pillars at a constant offset", () => {
    const pts = [...pillar(2), ...pillar(5), ...pillar(8)];
    const [best] = detectFinish(grid(draw(blank(16, 12, 10), pts)), paint(pts));
    expect(best.pattern).toBe("pillars");
    expect(best.repeats).toBe(3);
    expect(cells(best.adds)).toEqual([...pillar(11), ...pillar(14)]);
  });

  it("completes a pillar still being drawn", () => {
    const pts = [...pillar(2), ...pillar(5), ...pillar(8).slice(0, 2)];
    const [best] = detectFinish(grid(draw(blank(16, 12, 10), pts)), paint(pts));
    expect(best.pattern).toBe("pillars");
    expect(best.repeats).toBe(3);
    expect(cells(best.adds)).toEqual([[8, 9], ...pillar(11)]);
    expect(best.label).toMatch(/finish the pillar/);
  });

  it("extends a new pillar down to uneven ground", () => {
    // Ground drops one row after x = 10.
    const rows = blank(16, 12, 10).map((r, y) => (y === 10 ? r.slice(0, 11) + "....." : r));
    const pts = [...pillar(4), ...pillar(7)];
    const r = detectFinish(grid(draw(rows, pts)), paint(pts)).find((p) => p.pattern === "pillars")!;
    expect(cells(r.adds)).toEqual([...pillar(10), [13, 7], [13, 8], [13, 9], [13, 10]]);
  });

  it("continues a zig-zag tower (offsets alternating)", () => {
    const ledge = (x: number, y: number): [number, number][] => [[x, y], [x + 1, y]];
    const pts = [...ledge(4, 10), ...ledge(6, 8), ...ledge(4, 6), ...ledge(6, 4)];
    const [best] = detectFinish(grid(draw(blank(16, 13, 12), pts)), paint(pts, "grass_half"));
    expect(best.pattern).toBe("zigzag");
    expect(best.repeats).toBe(4);
    expect(cells(best.adds)).toEqual([...ledge(4, 2), ...ledge(6, 0)]);
    expect(best.adds[0].tile).toBe("grass_half");
  });

  it("repeats floating platforms", () => {
    const plat = (x: number, y: number): [number, number][] => [[x, y], [x + 1, y], [x + 2, y]];
    const pts = [...plat(1, 8), ...plat(6, 6)];
    const r = detectFinish(grid(draw(blank(20, 12, 11), pts)), paint(pts)).find((p) => p.pattern === "platforms")!;
    expect(r.repeats).toBe(2);
    expect(cells(r.adds)).toEqual([...plat(11, 4), ...plat(16, 2)]);
  });
});

describe("detectFinish: coins", () => {
  const coinPlace = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y, tile: "coin", tool: "paint" as const }));

  it("mirrors an arc past its apex", () => {
    const pts: [number, number][] = [[2, 8], [3, 6], [4, 5], [5, 5]];
    const [best] = detectFinish(grid(draw(blank(16, 12, 10), pts, "o")), coinPlace(pts));
    expect(best.pattern).toBe("arc");
    expect(best.entities.map((e) => [e.x, e.y])).toEqual([[6, 6], [7, 8]]);
    expect(best.adds).toEqual([]);
  });

  it("continues a rising arc as a parabola back to its starting height", () => {
    const pts: [number, number][] = [[2, 8], [3, 6], [4, 5]];
    const [best] = detectFinish(grid(draw(blank(16, 12, 10), pts, "o")), coinPlace(pts));
    expect(best.pattern).toBe("arc");
    expect(best.entities.map((e) => [e.x, e.y])).toEqual([[5, 5], [6, 6], [7, 8]]);
  });

  it("continues a coin line", () => {
    const pts: [number, number][] = [[2, 8], [3, 8], [4, 8]];
    const [best] = detectFinish(grid(draw(blank(16, 12, 10), pts, "o")), coinPlace(pts));
    expect(best.pattern).toBe("coin-line");
    expect(best.entities.map((e) => [e.x, e.y])).toEqual([[5, 8], [6, 8], [7, 8]]);
  });

  it("terrain proposals are stale when the last placement is a coin", () => {
    const stairs: [number, number][] = [[2, 9], [3, 8], [4, 7]];
    const rows = draw(draw(blank(16, 12, 10), stairs), [[10, 5]], "o");
    const out = detectFinish(grid(rows), [...paint(stairs), ...coinPlace([[10, 5]])]);
    expect(out[0].pattern).toBe("staircase");
    expect(out[0].touchesLast).toBe(false);
  });
});

describe("detectFinish: open structures", () => {
  it("gives a short platform its far end to match its siblings", () => {
    let rows = blank(20, 12, 11);
    rows = draw(rows, [[1, 4], [2, 4], [3, 4], [4, 4], [12, 6], [13, 6], [14, 6], [15, 6]]);
    const mine: [number, number][] = [[6, 8], [7, 8]];
    rows = draw(rows, mine);
    const [best] = detectFinish(grid(rows), paint(mine, "block"));
    expect(best.pattern).toBe("end-cap");
    expect(best.open).toBe(true);
    expect(best.adds).toEqual([
      { x: 8, y: 8, tile: "block" },
      { x: 9, y: 8, tile: "block" },
    ]);
  });

  it("closes a hanging pit with a floor", () => {
    let rows = blank(16, 12, 11);
    const left: [number, number][] = [[3, 4], [3, 5], [3, 6], [3, 7]];
    const right: [number, number][] = [[8, 4], [8, 5], [8, 6], [8, 7]];
    rows = draw(rows, [...left, ...right, [5, 7]]); // one floor tile drawn already
    const [best] = detectFinish(grid(rows), paint([...left, ...right]));
    expect(best.pattern).toBe("pit-floor");
    expect(cells(best.adds)).toEqual([[4, 7], [6, 7], [7, 7]]);
  });

  it("does not floor the gap between two ground ledges", () => {
    const rows = blank(16, 12, 8).map((r, y) => (y >= 8 ? "########....####" : r));
    const pts: [number, number][] = [[7, 8], [7, 9], [7, 10], [7, 11]];
    expect(detectFinish(grid(rows), paint(pts)).filter((p) => p.pattern === "pit-floor")).toEqual([]);
  });
});

describe("detectFinish: nothing to finish", () => {
  it("returns [] for scattered placements and for no placements", () => {
    const pts: [number, number][] = [[2, 3], [9, 7], [4, 1], [12, 5]];
    expect(detectFinish(grid(draw(blank(16, 12, 10), pts)), paint(pts))).toEqual([]);
    expect(detectFinish(grid(blank(16, 12, 10)), [])).toEqual([]);
  });
});
