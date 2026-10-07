import { describe, expect, it } from "vitest";
import { knightLimits, maxGap } from "@jump-tables";
import { fullRect, parseAscii } from "./grid";
import { buildSurfaceGraph, findSurfaces, type Transition } from "./surfaces";

function graphOf(rows: string[]) {
  const { grid } = parseAscii(rows);
  return { grid, ...buildSurfaceGraph(grid, fullRect(grid)) };
}
const brief = (t: Transition) => `${t.kind} ${t.gap} ${t.dy}`;
const forward = (ts: Transition[]) => ts.filter((t) => t.kind !== "climb");

describe("findSurfaces", () => {
  it("finds maximal runs with true width and depth", () => {
    const { grid } = parseAscii([
      "..........",
      "......#...",
      "......#...",
      "###.######",
    ]);
    const s = findSurfaces(grid, fullRect(grid));
    expect(s.map((x) => [x.y, x.x0, x.x1, x.width, x.depth])).toEqual([
      [0, 6, 6, 1, 3],
      [2, 0, 2, 3, 1],
      [2, 4, 5, 2, 1],
      [2, 7, 9, 3, 1],
    ]);
  });
  it("keeps real width for surfaces cut by the rect", () => {
    const { grid } = parseAscii(["..........", "##########"]);
    const s = findSurfaces(grid, { x: 4, y: 0, w: 2, h: 2 });
    expect(s).toHaveLength(1);
    expect(s[0].width).toBe(10);
  });
});

describe("transitions", () => {
  it("reads a staircase as steps", () => {
    const g = graphOf([
      "...........",
      ".......####",
      "......#####",
      ".....######",
      "###########",
    ]);
    expect(forward(g.transitions).map(brief)).toEqual(["step 0 -1", "step 0 -1", "step 0 -1"]);
    expect(g.routes).toHaveLength(1);
    expect(g.routes[0]).toHaveLength(3);
  });

  it("reads gaps over a pit as lethal jumps with run-up from the ledge", () => {
    const g = graphOf([
      "............",
      "#####...####",
    ]);
    expect(g.transitions).toHaveLength(1);
    const t = g.transitions[0];
    expect(brief(t)).toBe("jump 3 0");
    expect(t.lethal).toBe(true);
    expect(t.reachable).toBe(true);
    expect(t.runway).toBe(4);
    expect(t.takeoff).toEqual({ x: 4, y: 0 });
    expect(t.landing).toEqual({ x: 8, y: 0 });
    expect(t.slack).toBeGreaterThan(0);
  });

  it("a gap with a floor below is not lethal", () => {
    const g = graphOf([
      "............",
      "#####...####",
      "#####...####",
      "############",
    ]);
    const jump = g.transitions.find((t) => t.kind === "jump")!;
    expect(jump.lethal).toBe(false);
  });

  it("marks a gap wider than the knight's reach unreachable", () => {
    const wide = knightLimits().maxGapRun + 3;
    const g = graphOf(["." .repeat(10 + wide), "#####" + ".".repeat(wide) + "#####"]);
    expect(g.transitions).toHaveLength(1);
    expect(g.transitions[0].gap).toBe(wide);
    expect(g.transitions[0].reachable).toBe(false);
    expect(g.transitions[0].possible).toBe(false);
    expect(g.transitions[0].slack).toBeLessThan(0);
  });

  it("uses the available run-up: a standing jump reaches less far", () => {
    const stand = maxGap(0, false);
    const run = maxGap(0, true);
    expect(run).toBeGreaterThan(stand);
    const gap = stand + 1;
    const short = graphOf(["." .repeat(gap + 4), "#" + ".".repeat(gap) + "###"]);
    const long = graphOf(["." .repeat(gap + 11), "########" + ".".repeat(gap) + "###"]);
    expect(short.transitions[0].reachable).toBe(false);
    expect(short.transitions[0].possible).toBe(true);
    expect(long.transitions[0].reachable).toBe(true);
  });

  it("walking off a floating platform drops onto the floor below", () => {
    const g = graphOf([
      "..........",
      "...###....",
      "..........",
      "..........",
      "##########",
    ]);
    const kinds = g.transitions.map(brief).sort();
    // floor -> platform is a climb (nothing else leads there); platform -> floor a drop.
    expect(kinds).toEqual(["climb 0 -3", "drop 0 3"]);
    const climb = g.transitions.find((t) => t.kind === "climb")!;
    expect(climb.takeoff).toEqual({ x: 2, y: 3 });
    expect(climb.reachable).toBe(true);
  });

  it("prefers the next descending platform over the floor underneath", () => {
    const g = graphOf([
      "..............",
      "###...........",
      ".....###......",
      "..........###.",
      "..............",
      "##############",
    ]);
    const fromTop = g.transitions.find((t) => t.from === g.surfaces.find((s) => s.y === 0)!.id)!;
    expect(brief(fromTop)).toBe("jump 2 1");
  });

  it("prefers a level landing over a high bonus platform above the gap", () => {
    const g = graphOf([
      ".............",
      ".....##......",
      ".............",
      ".............",
      ".............",
      ".............",
      "#####...#####",
    ]);
    const ground = g.surfaces.find((s) => s.y === 5 && s.x0 === 0)!;
    const t = g.transitions[g.next[ground.id]];
    expect(brief(t)).toBe("jump 3 0");
  });

  it("does not jump through a wall: it steps up and drops down", () => {
    const g = graphOf([
      "..........",
      ".....#....",
      ".....#....",
      ".....#....",
      "##########",
    ]);
    expect(forward(g.transitions).map(brief).sort()).toEqual(["drop 0 3", "step 0 -3"]);
  });

  it("a wall taller than the knight's rise is an unreachable step", () => {
    const tall = knightLimits().maxRise + 2;
    const rows = [".........."];
    for (let i = 0; i < tall; i++) rows.push(".....#....");
    rows.push("##########");
    const g = graphOf(rows);
    const step = g.transitions.find((t) => t.kind === "step")!;
    expect(step.dy).toBe(-tall);
    expect(step.reachable).toBe(false);
  });

  it("only keeps transitions inside the rect's columns", () => {
    const { grid } = parseAscii(["............", "#####...####"]);
    expect(buildSurfaceGraph(grid, { x: 0, y: 0, w: 6, h: 2 }).transitions).toHaveLength(0);
    expect(buildSurfaceGraph(grid, { x: 3, y: 0, w: 7, h: 2 }).transitions).toHaveLength(1);
  });
});
