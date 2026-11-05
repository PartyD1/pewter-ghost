/**
 * End-to-end check of the structure hint: strokes are drawn into a real
 * LevelModel (the way the editor records them), the request is cut with the
 * real window builder, and the detector's reading is checked in LEVEL
 * coordinates. The complaint these guard: an up-and-right staircase must be
 * continued up and to the right, never "filled in underneath".
 */
import { describe, expect, it } from "vitest";
import { TILE, type FillRequest, type TileId } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { describeStructure, detectStructure } from "./structure";
import { PlacementStream } from "./stream";
import { buildFillRequest } from "./window";
import { knightLimits } from "@jump-tables";

const FLOOR = 15; // top row of the floor

function setup() {
  let t = 1000;
  const clock = () => t;
  const model = new LevelModel({ clock });
  const stream = new PlacementStream({ clock, recentCount: 12, pauseMs: 800, longPauseMs: 2500, newStructureTiles: 6 });
  stream.attach(model);
  for (let x = 0; x < 60; x++) model.paintTile(x, FLOOR, TILE.DIRT);
  t += 3000;
  return { model, stream, tick: (ms: number) => (t += ms), now: () => t };
}

interface Cell {
  x: number;
  y: number;
  tile: TileId;
}

function draw(s: ReturnType<typeof setup>, strokes: Cell[][]) {
  for (const stroke of strokes) {
    s.model.beginStroke();
    for (const c of stroke) {
      s.tick(110);
      s.model.paintTile(c.x, c.y, c.tile);
    }
    s.model.endStroke();
    s.tick(250);
  }
}

function request(s: ReturnType<typeof setup>): FillRequest {
  return buildFillRequest(s.model, s.stream, { now: s.now(), knight: knightLimits(), summary: false });
}

/** Continuation cells in level coordinates. */
function levelAdds(req: FillRequest) {
  const p = detectStructure(req);
  return p ? p.adds.map((a) => ({ x: a.x + req.origin.x, y: a.y + req.origin.y, tile: a.tile })) : [];
}

const hollowStep = (i: number, w: number, x0 = 10): Cell[] =>
  Array.from({ length: w }, (_, k) => ({ x: x0 + i * w + k, y: FLOOR - 1 - i, tile: TILE.GRASS }));

describe("describeStructure", () => {
  it("says nothing before anything is drawn", () => {
    const s = setup();
    const req = request(s);
    expect(describeStructure({ ...req, recent: [] })).toBeUndefined();
  });

  it("hollow 2-wide steps rising to the right: continues them, nothing underneath", () => {
    const s = setup();
    draw(s, [hollowStep(0, 2), hollowStep(1, 2), hollowStep(2, 2)]);
    const req = request(s);
    const adds = levelAdds(req);
    expect(adds.length).toBeGreaterThan(0);
    // The next step: columns 16-17, row FLOOR-4. Every added cell is on a step row (never under one).
    expect(adds).toContainEqual({ x: 16, y: FLOOR - 4, tile: "grass" });
    expect(adds).toContainEqual({ x: 17, y: FLOOR - 4, tile: "grass" });
    for (const a of adds) expect(a.y, `${a.x},${a.y} is under a step`).toBeLessThan(FLOOR - 3);
    const text = describeStructure(req)!;
    expect(text).toMatch(/going up and to the right/);
    // The text speaks window coordinates, like the grid the model reads.
    expect(text).toContain(`grass(${16 - req.origin.x},${FLOOR - 4 - req.origin.y})`);
  });

  it("filled steps (grass cap over dirt) keep growing to the right and are filled to the floor", () => {
    const s = setup();
    const step = (i: number): Cell[] => {
      const cells: Cell[] = [];
      for (let k = 0; k < 2; k++) {
        const x = 10 + i * 2 + k;
        const top = FLOOR - 1 - i;
        cells.push({ x, y: top, tile: TILE.GRASS });
        for (let y = top + 1; y < FLOOR; y++) cells.push({ x, y, tile: TILE.DIRT });
      }
      return cells;
    };
    draw(s, [step(0), step(1), step(2)]);
    const req = request(s);
    const adds = levelAdds(req);
    // Step 3 (columns 16-17): a grass cap at FLOOR-4 over dirt down to the floor.
    for (const x of [16, 17]) {
      expect(adds).toContainEqual({ x, y: FLOOR - 4, tile: "grass" });
      for (let y = FLOOR - 3; y < FLOOR; y++) expect(adds).toContainEqual({ x, y, tile: "dirt" });
    }
    // The old failure: more blocks stacked on top of the last column instead of a new column.
    expect(adds.some((a) => a.x === 15 && a.y < FLOOR - 3)).toBe(false);
    expect(describeStructure(req)).toMatch(/staircase/);
  });
});
