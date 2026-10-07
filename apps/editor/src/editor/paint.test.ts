import { describe, expect, it } from "vitest";
import { AUTHOR, TILE, type PlacementEvent } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { lineCells, StrokePainter, type StrokeInfo } from "./paint";
import type { Brush } from "./modes";

const grass: Brush = { kind: "tile", tile: TILE.GRASS };
const coin: Brush = { kind: "entity", entity: "coin" };

function setup() {
  const m = new LevelModel({ w: 30, h: 12, clock: () => 0 });
  const placements: PlacementEvent[] = [];
  let changes = 0;
  m.onPlacement((p) => placements.push(p));
  m.subscribe(() => changes++);
  const begun: StrokeInfo[] = [];
  const ended: StrokeInfo[] = [];
  const p = new StrokePainter(m, { onBegin: (s) => begun.push(s), onEnd: (s) => ended.push(s) });
  return { m, p, placements, begun, ended, changes: () => changes };
}

describe("lineCells", () => {
  it("returns every cell between two points, inclusive and connected", () => {
    const cells = lineCells({ x: 0, y: 0 }, { x: 5, y: 2 });
    expect(cells[0]).toEqual({ x: 0, y: 0 });
    expect(cells[cells.length - 1]).toEqual({ x: 5, y: 2 });
    for (let i = 1; i < cells.length; i++) {
      expect(Math.abs(cells[i].x - cells[i - 1].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(cells[i].y - cells[i - 1].y)).toBeLessThanOrEqual(1);
    }
    expect(lineCells({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([{ x: 3, y: 3 }]);
    expect(lineCells({ x: 4, y: 0 }, { x: 0, y: 0 }).map((c) => c.x)).toEqual([4, 3, 2, 1, 0]);
  });
});

describe("StrokePainter", () => {
  it("does nothing in Select or Pan mode", () => {
    const { m, p } = setup();
    expect(p.begin({ x: 1, y: 1 }, "select", grass)).toBe(false);
    expect(p.begin({ x: 1, y: 1 }, "pan", grass)).toBe(false);
    expect(p.isActive).toBe(false);
    expect(m.tileAt(1, 1)).toBe(0);
    expect(m.canUndo).toBe(false);
  });

  it("paints a continuous stroke as one undo step, filling gaps of a fast drag", () => {
    const { m, p, placements, begun, ended } = setup();
    expect(p.begin({ x: 2, y: 5 }, "paint", grass)).toBe(true);
    expect(m.currentStroke).toBeDefined();
    p.move({ x: 9, y: 5 }); // one fast pointer sample far away
    p.move({ x: 9, y: 5 }); // same cell: no-op
    p.end();
    for (let x = 2; x <= 9; x++) expect(m.tileAt(x, 5)).toBe(TILE.GRASS);
    expect(m.authorAt(5, 5)).toBe(AUTHOR.PERSON);
    expect(m.currentStroke).toBeUndefined();
    expect(begun).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(ended[0].cells).toHaveLength(8);
    expect(new Set(placements.map((e) => e.stroke)).size).toBe(1);
    expect(m.undoDepth).toBe(1);
    m.undo();
    for (let x = 2; x <= 9; x++) expect(m.tileAt(x, 5)).toBe(0);
  });

  it("makes one model call per pointer move and never repaints a visited cell", () => {
    const { p, changes } = setup();
    p.begin({ x: 0, y: 0 }, "paint", grass);
    expect(changes()).toBe(1);
    p.move({ x: 5, y: 0 });
    expect(changes()).toBe(2);
    p.move({ x: 0, y: 0 }); // back over painted cells
    expect(changes()).toBe(2);
    p.end();
  });

  it("separate strokes are separate undo steps", () => {
    const { m, p } = setup();
    p.begin({ x: 1, y: 1 }, "paint", grass);
    p.end();
    p.begin({ x: 2, y: 1 }, "paint", grass);
    p.end();
    expect(m.undoDepth).toBe(2);
  });

  it("erases tiles and entities in Erase mode, whatever the brush", () => {
    const { m, p } = setup();
    m.paint([{ x: 1, y: 3, tile: TILE.DIRT }, { x: 2, y: 3, tile: TILE.DIRT }]);
    m.placeEntity("coin", 3, 3);
    p.begin({ x: 1, y: 3 }, "erase", grass);
    p.move({ x: 4, y: 3 });
    p.end();
    expect(m.tileAt(1, 3)).toBe(0);
    expect(m.tileAt(2, 3)).toBe(0);
    expect(m.entitiesAt(3, 3)).toHaveLength(0);
    expect(m.undoDepth).toBe(3);
  });

  it("an erase stroke over empty cells changes nothing and adds no undo step", () => {
    const { m, p } = setup();
    p.begin({ x: 1, y: 1 }, "erase", grass);
    p.move({ x: 6, y: 1 });
    p.end();
    expect(m.undoDepth).toBe(0);
  });

  it("drags collectables along the stroke but places enemies once per click", () => {
    const { m, p } = setup();
    p.begin({ x: 1, y: 2 }, "paint", coin);
    p.move({ x: 4, y: 2 });
    p.end();
    expect(m.entities.filter((e) => e.kind === "coin")).toHaveLength(4);
    p.begin({ x: 10, y: 2 }, "paint", { kind: "entity", entity: "slime" });
    p.move({ x: 14, y: 2 });
    p.end();
    expect(m.entities.filter((e) => e.kind === "slime")).toHaveLength(1);
  });

  it("keeps a single goal flag: placing it again moves it in one undo step", () => {
    const { m, p } = setup();
    p.begin({ x: 5, y: 5 }, "paint", { kind: "entity", entity: "flag" });
    p.end();
    p.begin({ x: 20, y: 5 }, "paint", { kind: "entity", entity: "flag" });
    p.end();
    const flags = m.entities.filter((e) => e.kind === "flag");
    expect(flags).toHaveLength(1);
    expect(flags[0].x).toBe(20);
    m.undo();
    expect(m.entities.filter((e) => e.kind === "flag").map((e) => e.x)).toEqual([5]);
  });

  it("places signs with their text", () => {
    const { m, p } = setup();
    p.begin({ x: 3, y: 3 }, "paint", { kind: "entity", entity: "sign", text: "Jump!" });
    p.end();
    expect(m.entitiesAt(3, 3)[0]).toMatchObject({ kind: "sign", text: "Jump!" });
  });

  it("moves the start with the start brush", () => {
    const { m, p } = setup();
    p.begin({ x: 7, y: 4 }, "paint", { kind: "start" });
    p.move({ x: 9, y: 4 }); // ignored: single shot
    p.end();
    expect(m.start).toEqual({ x: 7, y: 4 });
  });

  it("ignores out-of-bounds starts and skips out-of-bounds cells on a drag", () => {
    const { m, p } = setup();
    expect(p.begin({ x: -1, y: 0 }, "paint", grass)).toBe(false);
    p.begin({ x: 28, y: 0 }, "paint", grass);
    p.move({ x: 35, y: 0 });
    p.end();
    expect(m.tileAt(28, 0)).toBe(TILE.GRASS);
    expect(m.tileAt(29, 0)).toBe(TILE.GRASS);
  });

  it("beginning a new stroke ends the open one; cancel keeps edits made so far", () => {
    const { m, p, ended } = setup();
    p.begin({ x: 1, y: 1 }, "paint", grass);
    p.begin({ x: 5, y: 1 }, "paint", grass);
    expect(ended).toHaveLength(1);
    p.move({ x: 6, y: 1 });
    p.cancel();
    expect(p.isActive).toBe(false);
    expect(m.tileAt(6, 1)).toBe(TILE.GRASS);
    expect(m.undoDepth).toBe(2);
    p.end(); // idempotent
    expect(ended).toHaveLength(2);
  });
});
