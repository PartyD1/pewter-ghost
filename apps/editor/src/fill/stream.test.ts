import { afterEach, describe, expect, it } from "vitest";
import { AUTHOR, TILE, type PlacementEvent } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { applyOverrides, resetConfig } from "../suggest/config";
import { PlacementStream, placementEntityKind, placementTileName, type PauseState } from "./stream";

let strokeN = 0;
function ev(t: number, x: number, y: number, over: Partial<PlacementEvent> = {}): PlacementEvent {
  return { t, x, y, tile: TILE.GRASS, author: AUTHOR.PERSON, stroke: over.stroke ?? `s${++strokeN}`, tool: "paint", ...over };
}

function clocked(opts: ConstructorParameters<typeof PlacementStream>[0] = {}) {
  let now = 0;
  const s = new PlacementStream({ clock: () => now, pauseMs: 800, longPauseMs: 2500, recentCount: 4, newStructureTiles: 6, ...opts });
  return { s, set: (t: number) => (now = t), now: () => now };
}

afterEach(() => resetConfig());

describe("rolling window", () => {
  it("keeps the last recentCount placements with dt to the previous one", () => {
    const { s } = clocked();
    const ts = [100, 250, 260, 1000, 1500, 1520];
    ts.forEach((t, i) => s.push(ev(t, 10 + i, 5)));
    expect(s.size).toBe(4);
    expect(s.recent().map((r) => r.dt)).toEqual([10, 740, 500, 20]);
    expect(s.recent().map((r) => r.x)).toEqual([12, 13, 14, 15]);
    expect(s.recent(2).map((r) => r.x)).toEqual([14, 15]);
    expect(s.recent(0)).toEqual([]);
  });

  it("first dt is 0 and out-of-order times never give negative dt", () => {
    const { s } = clocked();
    expect(s.push(ev(500, 1, 1)).dt).toBe(0);
    expect(s.push(ev(400, 2, 1)).dt).toBe(0);
  });

  it("makes recent placements window-relative and names tiles", () => {
    const { s } = clocked({ recentCount: 12 });
    s.push(ev(0, 40, 10, { tile: TILE.DIRT }));
    s.push(ev(10, 41, 10, { tile: "entity:coin" }));
    s.push(ev(20, 42, 10, { tile: 0, tool: "erase" }));
    s.push(ev(30, 43, 10, { tile: TILE.QUESTION }));
    expect(s.recent(12, { x: 30, y: 5 })).toEqual([
      { dt: 0, x: 10, y: 5, tile: "dirt", tool: "paint" },
      { dt: 10, x: 11, y: 5, tile: "coin", tool: "paint" },
      { dt: 10, x: 12, y: 5, tile: "erase", tool: "erase" },
      { dt: 10, x: 13, y: 5, tile: "question", tool: "paint" },
    ]);
  });

  it("reads recentCount from config when not given", () => {
    applyOverrides({ recentCount: 3 });
    const s = new PlacementStream({ clock: () => 0 });
    for (let i = 0; i < 10; i++) s.push(ev(i, i, 0));
    expect(s.size).toBe(3);
  });

  it("reset forgets everything", () => {
    const { s } = clocked();
    s.push(ev(1, 1, 1));
    s.reset();
    expect(s.size).toBe(0);
    expect(s.last).toBeUndefined();
    expect(s.idleMs(100)).toBe(0);
    expect(s.structure).toBe(0);
  });
});

describe("helpers", () => {
  it("placementTileName / placementEntityKind", () => {
    expect(placementTileName({ tile: TILE.GRASS_HALF, tool: "paint" })).toBe("grass_half");
    expect(placementTileName({ tile: 99, tool: "paint" })).toBe("tile99");
    expect(placementTileName({ tile: "entity:slime", tool: "paint" })).toBe("slime");
    expect(placementTileName({ tile: 0, tool: "erase" })).toBe("erase");
    expect(placementEntityKind({ tile: "entity:fruit" })).toBe("fruit");
    expect(placementEntityKind({ tile: TILE.BLOCK })).toBeUndefined();
  });
});

describe("pauses", () => {
  it("classifies idle time with the injected clock", () => {
    const { s, set } = clocked();
    expect(s.pauseState()).toBe("drawing"); // nothing yet
    s.push(ev(1000, 1, 1));
    set(1500);
    expect(s.pauseState()).toBe("drawing");
    expect(s.idleMs()).toBe(500);
    set(1800);
    expect(s.pauseState()).toBe("pause");
    expect(s.isPaused()).toBe(true);
    expect(s.isLongPaused()).toBe(false);
    set(3500);
    expect(s.pauseState()).toBe("longPause");
    expect(s.isLongPaused()).toBe(true);
  });

  it("poll reports each transition once per idle spell", () => {
    const { s, set } = clocked();
    const seen: [PauseState, number][] = [];
    const off = s.onPause((st, idle) => seen.push([st, idle]));
    s.push(ev(0, 1, 1));
    for (const t of [100, 799, 800, 900, 2000, 2500, 3000]) {
      set(t);
      s.poll();
    }
    expect(seen).toEqual([
      ["pause", 800],
      ["longPause", 2500],
    ]);
    // New placement restarts the spell.
    s.push(ev(3000, 2, 1));
    set(6000);
    s.poll(); // straight to long pause: reported once
    expect(seen.slice(2)).toEqual([["longPause", 3000]]);
    off();
    s.push(ev(6000, 3, 1));
    set(7000);
    s.poll();
    expect(seen).toHaveLength(3);
  });

  it("follows config overrides for pause thresholds", () => {
    applyOverrides({ pauseMs: 100, longPauseMs: 200 });
    let now = 0;
    const s = new PlacementStream({ clock: () => now });
    s.push(ev(0, 0, 0));
    now = 150;
    expect(s.pauseState()).toBe("pause");
    now = 250;
    expect(s.pauseState()).toBe("longPause");
  });
});

describe("new structures", () => {
  it("flags the first placement and ones far from every recent placement", () => {
    const { s } = clocked({ recentCount: 12 });
    expect(s.push(ev(0, 10, 10)).newStructure).toBe(true);
    expect(s.push(ev(1, 16, 10)).newStructure).toBe(false); // 6 away: same
    expect(s.push(ev(2, 23, 10)).newStructure).toBe(true); // 7 from nearest (16)
    expect(s.structure).toBe(2);
    expect(s.push(ev(3, 23, 3)).newStructure).toBe(true); // 7 rows up
    expect(s.isNewStructure({ x: 20, y: 5 })).toBe(false);
    expect(s.currentStructure().map((e) => [e.x, e.y])).toEqual([[23, 3]]);
  });

  it("only compares against placements still in the window", () => {
    const { s } = clocked({ recentCount: 2 });
    s.push(ev(0, 0, 0));
    s.push(ev(1, 20, 0));
    s.push(ev(2, 21, 0));
    // (0,0) has dropped out, so (3,0) is a new structure.
    expect(s.push(ev(3, 3, 0)).newStructure).toBe(true);
  });
});

describe("strokes and direction", () => {
  it("lastStroke returns the trailing run with the same stroke id", () => {
    const { s } = clocked({ recentCount: 12 });
    s.push(ev(0, 1, 1, { stroke: "a" }));
    s.push(ev(1, 2, 1, { stroke: "b" }));
    s.push(ev(2, 3, 1, { stroke: "b" }));
    expect(s.lastStroke().map((e) => e.x)).toEqual([2, 3]);
  });

  it("vertical when the current structure spans more rows than columns", () => {
    const { s } = clocked({ recentCount: 12 });
    s.push(ev(0, 10, 15));
    s.push(ev(1, 11, 13));
    expect(s.direction()).toBe("horizontal");
    s.push(ev(2, 10, 11));
    s.push(ev(3, 11, 9));
    expect(s.direction()).toBe("vertical");
    s.push(ev(4, 15, 9));
    s.push(ev(5, 18, 9));
    expect(s.direction()).toBe("horizontal");
  });
});

describe("frontier", () => {
  function level() {
    let now = 0;
    const m = new LevelModel({ w: 60, h: 20, clock: () => now });
    const s = new PlacementStream({ clock: () => now, recentCount: 12, newStructureTiles: 6 });
    const off = s.attach(m);
    return { m, s, off, set: (t: number) => (now = t) };
  }

  it("is undefined before any placement", () => {
    const { s } = level();
    expect(s.frontier()).toBeUndefined();
  });

  it("walks right over authored columns, across small gaps, near the stroke", () => {
    const { m, s, set } = level();
    const floor = [];
    for (let x = 0; x <= 12; x++) floor.push({ x, y: 15, tile: TILE.GRASS as 6 });
    for (let x = 16; x <= 20; x++) floor.push({ x, y: 15, tile: TILE.GRASS as 6 }); // gap of 3
    for (let x = 30; x <= 35; x++) floor.push({ x, y: 15, tile: TILE.GRASS as 6 }); // gap of 9: different structure
    m.paint(floor);
    set(100);
    m.paintTile(5, 12, TILE.BLOCK);
    set(400);
    expect(s.frontier()).toEqual({ x: 20, y: 15, idleMs: 300, direction: "horizontal" });
  });

  it("uses the topmost authored cell of the frontier column", () => {
    const { m, s } = level();
    m.paint([
      { x: 3, y: 15, tile: TILE.GRASS },
      { x: 4, y: 15, tile: TILE.GRASS },
      { x: 4, y: 13, tile: TILE.BLOCK },
    ]);
    m.paintTile(2, 15, TILE.GRASS);
    expect(s.frontier()).toMatchObject({ x: 4, y: 13 });
  });

  it("ignores authored cells in rows far from the stroke", () => {
    const { m, s } = level();
    m.paint([{ x: 40, y: 2, tile: TILE.GRASS }]); // far above the stroke band
    m.paint([
      { x: 30, y: 15, tile: TILE.GRASS },
      { x: 31, y: 15, tile: TILE.GRASS },
    ]);
    // Rows 10..19 near the stroke; (40,2) is outside the band.
    expect(s.frontier()).toMatchObject({ x: 31, y: 15 });
  });

  it("falls back to the stroke itself without a grid", () => {
    const s = new PlacementStream({ clock: () => 50, recentCount: 12 });
    s.push(ev(0, 7, 9, { stroke: "z" }));
    s.push(ev(10, 9, 8, { stroke: "z" }));
    s.push(ev(20, 8, 7, { stroke: "z" }));
    expect(s.frontier(undefined)).toEqual({ x: 9, y: 8, idleMs: 30, direction: "horizontal" });
  });

  it("vertical: topmost authored row near the climbing stroke", () => {
    const { m, s } = level();
    for (const [x, y] of [
      [20, 16],
      [22, 14],
      [20, 12],
      [22, 10],
    ])
      m.paint([
        { x, y, tile: TILE.GRASS_HALF },
        { x: x + 1, y, tile: TILE.GRASS_HALF },
      ]);
    // A pre-placed ledge above, 1 empty row over the last step, counts.
    m.paint([{ x: 21, y: 8, tile: TILE.BLOCK }], AUTHOR.GHOST);
    // The ghost paint is not a person placement, so the stream's last stroke is still (22..23,10).
    expect(s.direction()).toBe("vertical");
    expect(s.frontier()).toMatchObject({ x: 21, y: 8, direction: "vertical" });
  });

  it("stroke made only of erases still yields a frontier", () => {
    const { m, s } = level();
    m.paint([{ x: 5, y: 15, tile: TILE.GRASS }, { x: 6, y: 15, tile: TILE.GRASS }]);
    m.erase([{ x: 6, y: 15 }]);
    expect(s.last?.tool).toBe("erase");
    expect(s.frontier()).toMatchObject({ x: 6, y: 15 });
  });

  it("detach stops feeding the stream", () => {
    const { m, s, off } = level();
    m.paintTile(1, 1, TILE.GRASS);
    off();
    m.paintTile(2, 1, TILE.GRASS);
    expect(s.size).toBe(1);
  });
});
