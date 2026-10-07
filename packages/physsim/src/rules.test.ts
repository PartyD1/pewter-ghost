/**
 * The rule check (reachpy.py port) on the fixtures, its agreement with the
 * agent, and its documented blind spots.
 */
import { describe, expect, it } from "vitest";
import { maxGap } from "@jump-tables";
import { FIXTURES, flatLevel, gapLevel, tunnelLevel, wallLevel } from "./fixtures";
import { gridFromRows } from "./grid";
import { checkRules, reachability, reachable, unreachableSurfaces } from "./rules";
import { search } from "./sim";

describe("rule check on the validation fixtures", () => {
  for (const f of FIXTURES) {
    it(`${f.name}: rules say ${f.rules ? "reachable" : "blocked"}`, () => {
      const v = checkRules(f.grid, f.from, f.to);
      expect(v.ok).toBe(f.rules);
      if (v.ok) {
        expect(v.path[0]).toEqual(f.from);
        expect(v.reached!.x).toBe(f.grid.w - 1);
        expect(v.reason).toBeUndefined();
      } else {
        expect(v.path).toEqual([]);
        expect(v.reason).toMatch(/^blocked at \(\d+,\d+\)/);
      }
    });
  }

  it("runs in milliseconds", () => {
    for (const f of FIXTURES) expect(checkRules(f.grid, f.from, f.to).ms).toBeLessThan(50);
  });
});

describe("rules vs agent", () => {
  it("every fixture where rules and agent disagree carries a note saying why", () => {
    for (const f of FIXTURES) if (f.rules !== f.beatable) expect(f.note, f.name).toBeTruthy();
  });

  it("agree on simple gap/rise levels: rules reachable => the agent finds a route", () => {
    // Takeoff run-ups 0..7, gaps 1..12, landings 4 lower to 6 higher.
    let checked = 0;
    for (const r of [0, 2, 4, 7])
      for (let gap = 1; gap <= 12; gap++)
        for (let rise = -4; rise <= 6; rise++) {
          const g = gapLevel(r, gap, rise);
          const to = { x0: g.w - 1 };
          if (!reachable(g, { x: 0, y: 7 }, to)) continue;
          checked++;
          const a = search(g, { x: 0, y: 7 }, to, { capMs: 5000 });
          expect(a.found, `runway ${r} gap ${gap} rise ${rise}`).toBe(true);
        }
    expect(checked).toBeGreaterThan(300);
  }, 120_000);

  it("is conservative on open ground: the agent's reach is at least the design tier's", () => {
    for (const r of [0, 7]) {
      const gap = maxGap(0, r);
      const g = gapLevel(r, gap);
      expect(reachable(g, { x: 0, y: 7 }, { x0: g.w - 1 })).toBe(true);
      expect(reachable(gapLevel(r, gap + 1), { x: 0, y: 7 }, { x0: g.w })).toBe(false);
      expect(search(gapLevel(r, gap + 1), { x: 0, y: 7 }, { x0: g.w }, { capMs: 5000 }).found).toBe(true);
    }
  });

  it("KNOWN FALSE POSITIVE: a pit under a low tunnel passes the rules but cannot be crossed", () => {
    // The audit's ceiling_test: the rules gave false "beatable" on 16 of 34
    // tunnel and wall cases. reachpy (and this port, arc "passable") only
    // rejects a jump when a column is solid across the whole band the arc
    // could use; it never traces the arc into the ceiling. The agent does.
    const g = tunnelLevel(7, 2);
    const to = { x0: g.w - 1 };
    expect(checkRules(g, { x: 0, y: 7 }, to).ok).toBe(true);
    expect(checkRules(g, { x: 0, y: 7 }, to, { arc: "none" }).ok).toBe(true);
    const a = search(g, { x: 0, y: 7 }, to, { capMs: 60_000 });
    expect(a.found).toBe(false);
    expect(a.exhausted).toBe(true);
  }, 60_000);

  it('arc "sweep" catches the tunnel but is too strict for a passable one', () => {
    const to = (g: { w: number }) => ({ x0: g.w - 1 });
    const blocked = tunnelLevel(7, 2);
    expect(checkRules(blocked, { x: 0, y: 7 }, to(blocked), { arc: "sweep" }).ok).toBe(false);
    // 3 tiles of clearance: the knight cuts its jump short and gets across,
    // but the full design arc would hit the ceiling.
    const ok = tunnelLevel(5, 3);
    expect(checkRules(ok, { x: 0, y: 7 }, to(ok), { arc: "sweep" }).ok).toBe(false);
    expect(search(ok, { x: 0, y: 7 }, to(ok)).found).toBe(true);
  });

  it("a solid column across the whole band blocks the jump (reachpy arc_min)", () => {
    // Gap of 3 with a 1-wide pillar from the ceiling to just above the pit floor... there is no floor:
    // the pillar fills the middle column from row 0 down to row 9.
    const g = gridFromRows([
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "....#....",
      "###.#.###",
      "###.#.###",
    ]);
    expect(checkRules(g, { x: 0, y: 7 }, { x0: 8 }, { arc: "none" }).ok).toBe(true);
    expect(checkRules(g, { x: 0, y: 7 }, { x0: 8 }).ok).toBe(false);
  });
});

describe("moves", () => {
  it("walks, steps up one, falls off ledges and climbs", () => {
    const g = gridFromRows([
      "..........",
      "..........",
      "......##..",
      "..........",
      ".....#....",
      "...#.#....",
      "##########",
    ]);
    const r = reachability(g, { x: 0, y: 5 });
    expect(r.has({ x: 2, y: 5 })).toBe(true); // walk
    expect(r.has({ x: 3, y: 4 })).toBe(true); // step up onto the 1-high block
    expect(r.via.get(4 * g.w + 3)!.kind).toBe("step");
    expect(r.has({ x: 4, y: 5 })).toBe(true); // fall/walk down
    expect(r.has({ x: 5, y: 3 })).toBe(true); // up onto the 2-high column
    expect(r.has({ x: 6, y: 1 })).toBe(true); // onto the floating slab
    const path = r.pathTo({ x: 6, y: 1 });
    expect(path[0]).toEqual({ x: 0, y: 5 });
    expect(path[path.length - 1]).toEqual({ x: 6, y: 1 });
    expect(r.pathTo({ x: 0, y: 0 })).toEqual([]);
  });

  it("needs headroom above the takeoff for a rising jump", () => {
    const open = gapLevel(2, 2, 3);
    expect(reachable(open, { x: 0, y: 7 }, { x0: open.w - 1 })).toBe(true);
    const rows = [
      "........",
      "........",
      "........",
      "........",
      "##......", // a lid 2 rows over the whole takeoff
      "........",
      ".....###",
      "....####",
      "########",
    ];
    // Without the lid the 3-rise step is easy; with it the rules refuse.
    expect(reachable(gridFromRows(rows.map((r, i) => (i === 4 ? "........" : r))), { x: 0, y: 7 }, { x0: 7 })).toBe(
      true,
    );
    expect(reachable(gridFromRows(rows), { x: 0, y: 7 }, { x0: 7 })).toBe(true); // can walk out from under it
    const boxed = gridFromRows(rows.map((r, i) => (i === 4 ? "####...." : r)));
    expect(reachable(boxed, { x: 0, y: 7 }, { x0: 7 })).toBe(false);
  });

  it("uses the run-up behind the takeoff", () => {
    const short = gapLevel(0, 10);
    const long = gapLevel(7, 10);
    expect(reachable(short, { x: 0, y: 7 }, { x0: short.w - 1 })).toBe(false);
    expect(reachable(long, { x: 0, y: 7 }, { x0: long.w - 1 })).toBe(true);
    const v = checkRules(long, { x: 0, y: 7 }, { x0: long.w - 1 });
    const jump = reachability(long, { x: 0, y: 7 }).via.get(v.reached!.y * long.w + 18);
    expect(jump?.kind).toBe("jump");
    expect(jump?.runUp).toBe(7);
    expect(jump?.gap).toBe(10);
  });

  it("respects the tier", () => {
    const g = gapLevel(7, 12);
    expect(reachable(g, { x: 0, y: 7 }, { x0: g.w - 1 })).toBe(false);
    expect(reachable(g, { x: 0, y: 7 }, { x0: g.w - 1 }, { tier: "ULTRA" })).toBe(true);
  });
});

describe("verdicts and reasons", () => {
  it("explains a gap that is too wide", () => {
    const g = gapLevel(7, 13);
    const v = checkRules(g, { x: 0, y: 7 }, { x0: g.w - 1 });
    expect(v.ok).toBe(false);
    expect(v.blockedAt).toEqual({ x: 7, y: 7 });
    expect(v.reason).toContain("13 empty tiles away");
    expect(v.reason).toContain("at the same height");
    expect(v.reason).toContain("clears 11 with a 7-tile run-up");
  });

  it("mentions the full run-up when the takeoff has a short one", () => {
    const g = gapLevel(0, 9);
    const v = checkRules(g, { x: 0, y: 7 }, { x0: g.w - 1 });
    expect(v.reason).toContain("clears 8 with a 0-tile run-up (11 with a full run-up)");
  });

  it("explains a wall that is too tall", () => {
    const g = wallLevel(7);
    const v = checkRules(g, { x: 0, y: 7 }, { x0: g.w - 1 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("climbs at most 6");
  });

  it("explains a ceiling over the takeoff and a missing landing", () => {
    const g = gridFromRows(["######", "......", "##....", "##...."]);
    expect(checkRules(g, { x: 0, y: 1 }, { x0: 5 }).reason).toContain("nothing to land on right of column 1");
  });

  it("fails cleanly when the start has no ground", () => {
    const g = gapLevel(0, 4);
    const v = checkRules(g, { x: 2, y: 0 }, { x0: g.w - 1 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("no ground");
  });

  it("lists the surfaces it cannot reach", () => {
    const g = gapLevel(7, 13);
    expect(unreachableSurfaces(g, { x: 0, y: 7 })).toEqual([{ y: 7, x0: 21, x1: 23 }]);
    expect(checkRules(g, { x: 0, y: 7 }, { x0: g.w - 1 }).unreachable).toEqual([{ y: 7, x0: 21, x1: 23 }]);
    expect(unreachableSurfaces(flatLevel(10), { x: 0, y: 7 })).toEqual([]);
  });

  it("a column window limits the cells considered", () => {
    const g = flatLevel(30);
    expect(reachable(g, { x: 2, y: 7 }, { x: 20, y: 7 }, { xRange: [0, 15] })).toBe(false);
    expect(reachable(g, { x: 2, y: 7 }, { x: 20, y: 7 }, { xRange: [0, 25] })).toBe(true);
    expect(unreachableSurfaces(g, { x: 2, y: 7 }, { xRange: [0, 15] })).toEqual([]);
  });

  it("prefers the shortest route among goal cells", () => {
    const g = flatLevel(12);
    const v = checkRules(g, { x: 0, y: 7 }, { x0: 8 });
    expect(v.reached).toEqual({ x: 8, y: 7 });
    expect(v.path).toHaveLength(9);
  });
});
