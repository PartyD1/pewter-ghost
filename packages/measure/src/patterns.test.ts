import { describe, expect, it } from "vitest";
import { arcCoins } from "@jump-tables";
import { ALL_FIXTURES } from "./__fixtures__/levels";
import { PATTERN_TAGS } from "./constants";
import { fullRect, parseAscii, type EntityLike } from "./grid";
import { analyzeWindow } from "./measures";

function analyse(rows: string[], extra: EntityLike[] = []) {
  const p = parseAscii(rows);
  const ents = [...p.entities, ...extra];
  return analyzeWindow(p.grid, ents, fullRect(p.grid));
}

describe("hand-labelled fixtures", () => {
  for (const f of ALL_FIXTURES) {
    it(`${f.name}: finds ${f.expect.join(", ")}`, () => {
      const a = analyse(f.rows);
      for (const t of f.expect) expect(a.patterns, `missing ${t}`).toContain(t);
      for (const t of f.reject ?? []) expect(a.patterns, `unexpected ${t}`).not.toContain(t);
    });
  }

  it("agrees with the hand labels on at least 80% of (fixture, tag) decisions", () => {
    let agree = 0,
      total = 0;
    for (const f of ALL_FIXTURES) {
      const got = new Set(analyse(f.rows).patterns);
      for (const t of f.expect) {
        total++;
        if (got.has(t as never)) agree++;
      }
      for (const t of f.reject ?? []) {
        total++;
        if (!got.has(t as never)) agree++;
      }
    }
    expect(agree / total).toBeGreaterThanOrEqual(0.8);
  });

  it("returns tags in catalogue order without duplicates", () => {
    for (const f of ALL_FIXTURES) {
      const tags = analyse(f.rows).patterns;
      const idx = tags.map((t) => PATTERN_TAGS.indexOf(t));
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      expect(new Set(tags).size).toBe(tags.length);
    }
  });
});

/** A 4-wide pit between two ledges on row 9 (standing row 8), takeoff at (5, 8). */
const PIT4 = [
  ".............",
  ".............",
  ".............",
  ".............",
  ".............",
  ".............",
  ".............",
  ".............",
  ".............",
  "######....###",
];
const TAKEOFF = { x: 5, y: 8 };

describe("coins on arcs (G-26)", () => {
  const arc = arcCoins(4, 0).map((o) => ({ kind: "coin" as const, x: TAKEOFF.x + o.x, y: TAKEOFF.y + o.y }));

  it("jump-tables gives a coin per gap column", () => {
    expect(arc).toHaveLength(4);
    expect(arc.map((c) => c.x)).toEqual([6, 7, 8, 9]);
  });

  it("coins placed with arcCoins over a pit are all on the arc", () => {
    const a = analyse(PIT4, arc);
    expect(a.coinsOnArcShare).toBe(1);
    expect(a.coinsOnFloorShare).toBe(0);
    expect(a.patterns).toContain("coin-arc");
    expect(a.patterns).toContain("risky-coin");
    expect(a.patterns).toContain("pit");
  });

  it("the same coins dropped to the floor are floor coins, not arc coins", () => {
    const floor = [0, 1, 2, 3].map((i) => ({ kind: "coin" as const, x: 1 + i, y: 8 }));
    const a = analyse(PIT4, floor);
    expect(a.coinsOnFloorShare).toBe(1);
    expect(a.coinsOnArcShare).toBe(0);
    expect(a.patterns).toContain("coin-row-on-floor");
    expect(a.patterns).not.toContain("coin-arc");
  });

  it("mixes: share counts each coin once", () => {
    const mixed = [...arc.slice(0, 2), { kind: "coin" as const, x: 1, y: 8 }, { kind: "coin" as const, x: 2, y: 2 }];
    const a = analyse(PIT4, mixed);
    expect(a.counts.coins).toBe(4);
    expect(a.coinsOnArcShare).toBe(0.5);
    expect(a.coinsOnFloorShare).toBe(0.25);
  });

  it("coins far above the jump are not on the arc", () => {
    const high = [6, 7, 8].map((x) => ({ kind: "coin" as const, x, y: 0 }));
    const a = analyse(PIT4, high);
    expect(a.coinsOnArcShare).toBe(0);
    expect(a.patterns).not.toContain("coin-arc");
  });

  it("fruit is a collectable but not a coin", () => {
    const a = analyse(PIT4, [{ kind: "fruit", x: 7, y: 5 }]);
    expect(a.counts.coins).toBe(0);
    expect(a.counts.collectables).toBe(1);
    expect(a.coinsOnArcShare).toBe(0);
  });
});

describe("pattern details", () => {
  it("an enemy on a wide open floor is not a gate", () => {
    const a = analyse([
      "........................",
      "..........s.............",
      "########################",
    ]);
    expect(a.patterns).not.toContain("enemy-gate");
  });

  it("an enemy in a tunnel is a gate", () => {
    const a = analyse([
      "........................",
      "....############........",
      "..........s.............",
      "########################",
    ]);
    expect(a.patterns).toContain("enemy-gate");
    expect(a.patterns).toContain("tunnel");
  });

  it("a level that simply ends is not a pit", () => {
    const a = analyse([
      "........................",
      "##########..............",
    ]);
    expect(a.patterns).not.toContain("pit");
  });

  it("a descending staircase is a staircase too", () => {
    const a = analyse([
      "..........",
      "####......",
      "#####.....",
      "######....",
      "#######...",
      "##########",
    ]);
    expect(a.patterns).toContain("staircase");
  });

  it("a short wall (2 tiles) is not a wall", () => {
    const a = analyse([
      "..........",
      "..........",
      ".....#....",
      ".....#....",
      "##########",
    ]);
    expect(a.patterns).not.toContain("wall");
  });

  it("hits carry their extent", () => {
    const a = analyse([
      "............",
      "#####...####",
    ]);
    const pit = a.hits.find((h) => h.tag === "pit")!;
    expect(pit).toMatchObject({ x0: 5, x1: 7 });
  });
});
