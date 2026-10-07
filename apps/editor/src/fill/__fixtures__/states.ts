/**
 * Four fixture editing states for the window builder's golden tests. Each
 * builds a LevelModel and a PlacementStream fed from the model's own
 * PlacementEvents, with a manual clock so idle times are deterministic.
 */
import { TILE, type FillMode, type GhostHistoryItem, type Point, type TileId, type VerdictStage } from "../../contracts";
import { LevelModel } from "../../level/LevelModel";
import { PlacementStream } from "../stream";

export interface FixtureState {
  name: string;
  model: LevelModel;
  stream: PlacementStream;
  now: number;
  mode?: FillMode;
  blockedAt?: Point;
  previousFailure?: { reason: string; stage: VerdictStage };
  lastGhosts?: GhostHistoryItem[];
}

function setup() {
  let t = 1000;
  const clock = () => t;
  const model = new LevelModel({ clock });
  const stream = new PlacementStream({
    clock,
    recentCount: 12,
    pauseMs: 800,
    longPauseMs: 2500,
    newStructureTiles: 6,
  });
  stream.attach(model);
  const tick = (ms: number) => {
    t += ms;
  };
  const row = (y: number, x0: number, x1: number, tile: TileId = TILE.GRASS) => {
    const cells = [];
    for (let x = x0; x <= x1; x++) cells.push({ x, y, tile });
    return cells;
  };
  return { model, stream, tick, row, now: () => t };
}

/** 1. A fresh level: a floor near the start, then a three-block platform above it. */
export function freshStart(): FixtureState {
  const { model, stream, tick, row, now } = setup();
  model.paint(row(15, 0, 19, TILE.GRASS));
  tick(1500);
  for (const x of [12, 13, 14]) {
    tick(140);
    model.paintTile(x, 12, TILE.BLOCK);
  }
  tick(900);
  return { name: "fresh-start", model, stream, now: now() };
}

/** 2. Mid-level: dirt floor, an accepted ghost staircase, coins, a slime, and a person's stroke going up-right. */
export function midStaircase(): FixtureState {
  const { model, stream, tick, row, now } = setup();
  model.paint(row(17, 36, 70, TILE.DIRT));
  model.applySuggestion({
    id: "stub-1-abcdef01",
    adds: [
      { x: 50, y: 16, tile: TILE.GRASS },
      { x: 51, y: 15, tile: TILE.GRASS },
      { x: 52, y: 14, tile: TILE.GRASS },
    ],
    removes: [],
    entities: [{ kind: "coin", x: 52, y: 13 }],
  });
  model.placeEntity("coin", 45, 14);
  model.placeEntity("coin", 46, 13);
  model.placeEntity("slime", 62, 16);
  tick(2000);
  model.beginStroke();
  for (const [x, y] of [
    [54, 13],
    [55, 13],
    [56, 12],
  ]) {
    tick(120);
    model.paintTile(x, y, TILE.GRASS);
  }
  model.endStroke();
  tick(300);
  return {
    name: "mid-staircase",
    model,
    stream,
    now: now(),
    lastGhosts: [
      { kind: "extend", label: "flat run", outcome: "esc" },
      { kind: "finish", label: "staircase, three steps", outcome: "accepted" },
    ],
  };
}

/** 3. A vertical section: a zig-zag tower climbing from a floor. */
export function verticalTower(): FixtureState {
  const { model, stream, tick, row, now } = setup();
  model.paint(row(18, 92, 112, TILE.DIRT));
  tick(1200);
  const steps: [number, number][] = [
    [100, 16],
    [102, 14],
    [100, 12],
    [102, 10],
    [100, 8],
    [102, 6],
  ];
  for (const [x, y] of steps) {
    tick(400);
    model.paint([
      { x, y, tile: TILE.GRASS_HALF },
      { x: x + 1, y, tile: TILE.GRASS_HALF },
    ]);
  }
  model.placeEntity("fruit", 103, 5);
  tick(3000);
  return { name: "vertical-tower", model, stream, now: now(), mode: "requested" };
}

/** 4. Patrol near the right edge: a pit the agent could not cross, a flag beyond it. */
export function patrolRightEdge(): FixtureState {
  const { model, stream, tick, row, now } = setup();
  model.paint(row(16, 176, 185, TILE.GRASS));
  model.paint(row(16, 196, 199, TILE.GRASS));
  model.paint(row(17, 176, 185, TILE.DIRT));
  model.paint(row(17, 196, 199, TILE.DIRT));
  model.paintTile(190, 12, TILE.QUESTION);
  model.placeEntity("flag", 198, 15);
  model.placeEntity("sign", 178, 15, { text: "Jump!" });
  model.placeEntity("ultraslime", 181, 15);
  model.setGoal({ x: 198, y: 15 });
  tick(4000);
  return {
    name: "patrol-right-edge",
    model,
    stream,
    now: now(),
    mode: "patrol",
    blockedAt: { x: 185, y: 15 },
    previousFailure: { reason: "gap at x=186 is 10 wide; knight clears 8 standing", stage: "agent" },
    lastGhosts: [{ kind: "fix", label: "bridge the pit", outcome: "drawn-over" }],
  };
}

export const FIXTURES = [freshStart, midStaircase, verticalTower, patrolRightEdge] as const;
