/**
 * The six few-shot examples of prompt v1 (G-14), built from realistic editing
 * states with the real window builder, so the examples the model sees have
 * exactly the format of a live request.
 *
 * Each scenario builds a LevelModel and PlacementStream (manual clock),
 * then gives the answer in LEVEL coordinates. `buildFewShot` turns that into
 * the JSON stored in prompts/fewshot/*.json, with the request cut out by
 * buildFillRequest and the answer converted to window coordinates.
 *
 * Regenerate after editing:  npx tsx prompts/fewshot/make.ts
 * (a test fails when the JSON files are stale).
 */
import {
  TILE,
  type FillMode,
  type FillRequest,
  type GhostHistoryItem,
  type ModelAnswer,
  type Point,
  type TileId,
  type TileName,
  type EntityKind,
  type SuggestionKind,
  type VerdictStage,
} from "../../apps/editor/src/contracts";
import { LevelModel } from "../../apps/editor/src/level/LevelModel";
import { PlacementStream } from "../../apps/editor/src/fill/stream";
import { buildFillRequest, LEGEND, levelToWindow } from "../../apps/editor/src/fill/window";
import { knightLimits } from "@jump-tables";

/** The answer of a scenario, in LEVEL coordinates. */
export interface LevelAnswer {
  act: boolean;
  kind: SuggestionKind;
  adds: { x: number; y: number; tile: TileName }[];
  removes: Point[];
  entities: { kind: EntityKind; x: number; y: number }[];
  confidence: number;
  label: string;
  levelGuess?: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** One sentence on why this answer is right, shown after the example. */
  why: string;
  model: LevelModel;
  stream: PlacementStream;
  now: number;
  mode?: FillMode;
  blockedAt?: Point;
  previousFailure?: { reason: string; stage: VerdictStage };
  lastGhosts?: GhostHistoryItem[];
  answer: LevelAnswer;
}

/** Fields of the request a few-shot keeps (no brief, measured numbers or summary). */
export type FewShotRequest = Pick<
  FillRequest,
  "grid" | "origin" | "size" | "recent" | "frontier" | "mode" | "lastGhosts" | "knight"
> &
  Partial<Pick<FillRequest, "blockedAt" | "previousFailure">>;

export interface FewShot {
  id: string;
  title: string;
  why: string;
  request: FewShotRequest;
  answer: ModelAnswer;
}

/** Window size of the examples (the default live window). */
export const FEWSHOT_COLS = 24;
export const FEWSHOT_ROWS = 12;

function setup() {
  let t = 10_000;
  const clock = () => t;
  const model = new LevelModel({ clock });
  const stream = new PlacementStream({ clock, recentCount: 8, pauseMs: 800, longPauseMs: 2500, newStructureTiles: 6 });
  stream.attach(model);
  const tick = (ms: number) => {
    t += ms;
  };
  const row = (y: number, x0: number, x1: number, tile: TileId) => {
    const cells = [];
    for (let x = x0; x <= x1; x++) cells.push({ x, y, tile });
    return cells;
  };
  /** One stroke, one tile per `gap` ms. */
  const stroke = (cells: [number, number][], tile: TileId, gap = 120) => {
    model.beginStroke();
    for (const [x, y] of cells) {
      tick(gap);
      model.paintTile(x, y, tile);
    }
    model.endStroke();
  };
  return { model, stream, tick, row, stroke, now: () => t };
}

/** 1. finish, 0.9: a floating staircase mid-climb; the answer runs six steps ahead. */
export function finishStaircase(): Scenario {
  const { model, stream, tick, row, stroke, now } = setup();
  model.paint(row(17, 20, 44, TILE.GRASS));
  model.paint(row(18, 20, 44, TILE.DIRT));
  tick(3000);
  stroke([[33, 16], [34, 16]], TILE.BLOCK);
  tick(450);
  stroke([[35, 15], [36, 15]], TILE.BLOCK);
  tick(420);
  stroke([[37, 14], [38, 14]], TILE.BLOCK);
  tick(380);
  return {
    id: "finish-staircase",
    title: "Mid-pattern: steps of two blocks, one row up each",
    why: "Three identical steps were drawn in quick strokes, so the unit (2 wide, 1 up, block) is certain. The person is still drawing, so the answer runs six steps ahead: the steps they draw while it travels are trimmed off and the rest still shows.",
    model,
    stream,
    now: now(),
    mode: "auto",
    lastGhosts: [{ kind: "extend", label: "flat run with coins", outcome: "accepted", patterns: ["rest", "coin-arc"] }],
    answer: {
      act: true,
      kind: "finish",
      adds: [
        { x: 39, y: 13, tile: "block" },
        { x: 40, y: 13, tile: "block" },
        { x: 41, y: 12, tile: "block" },
        { x: 42, y: 12, tile: "block" },
        { x: 43, y: 11, tile: "block" },
        { x: 44, y: 11, tile: "block" },
        { x: 45, y: 10, tile: "block" },
        { x: 46, y: 10, tile: "block" },
        { x: 47, y: 9, tile: "block" },
        { x: 48, y: 9, tile: "block" },
        { x: 49, y: 8, tile: "block" },
        { x: 50, y: 8, tile: "block" },
      ],
      removes: [],
      entities: [],
      confidence: 0.9,
      label: "staircase, six more steps",
      levelGuess: "speedrun",
    },
  };
}

/** 2. extend, 0.5: a pit with a coin arc, in a level that arcs its coins. */
export function extendCoinArc(): Scenario {
  const { model, stream, tick, row, stroke, now } = setup();
  model.paint(row(16, 40, 49, TILE.GRASS));
  model.paint(row(17, 40, 49, TILE.DIRT));
  model.paint(row(16, 54, 57, TILE.GRASS));
  model.paint(row(17, 54, 57, TILE.DIRT));
  tick(2000);
  // The person's own coin arc over the 4-wide gap (jump-tables offsets from takeoff (49,15)).
  for (const [x, y] of [
    [50, 14],
    [51, 10],
    [52, 9],
    [53, 9],
  ]) {
    tick(300);
    model.placeEntity("coin", x, y);
  }
  tick(1500);
  const cols = [58, 59, 60, 61, 62];
  stroke(cols.map((x) => [x, 16] as [number, number]), TILE.GRASS, 110);
  stroke(cols.map((x) => [x, 17] as [number, number]), TILE.DIRT, 90);
  tick(1400);
  return {
    id: "extend-coin-arc",
    title: "Paused after a floor; earlier coins sit on a jump arc",
    why: "The person arcs their coins, so the next stretch repeats that idea with a new gap width (5, inside every limit). It lands on a 5-wide platform whose slime starts 3 tiles from the landing and has 5 tiles to patrol. The last accepted idea was a floor, so a pit is new.",
    model,
    stream,
    now: now(),
    mode: "auto",
    lastGhosts: [{ kind: "finish", label: "floor to the edge", outcome: "accepted", patterns: ["rest"] }],
    answer: {
      act: true,
      kind: "extend",
      adds: [
        ...[68, 69, 70, 71, 72].map((x) => ({ x, y: 16, tile: "grass" as TileName })),
        ...[68, 69, 70, 71, 72].map((x) => ({ x, y: 17, tile: "dirt" as TileName })),
      ],
      removes: [],
      // Gap 5 from takeoff (62,15): offsets (1,-1) (2,-4) (3,-6) (4,-6) (5,-5).
      entities: [
        { kind: "coin", x: 63, y: 14 },
        { kind: "coin", x: 64, y: 11 },
        { kind: "coin", x: 65, y: 9 },
        { kind: "coin", x: 66, y: 9 },
        { kind: "coin", x: 67, y: 10 },
        { kind: "slime", x: 71, y: 15 },
      ],
      confidence: 0.5,
      label: "pit with a coin arc",
      levelGuess: "collect-a-thon",
    },
  };
}

/** 3. act false: one block in mid-air, placed a moment ago. */
export function falseTooEarly(): Scenario {
  const { model, stream, tick, row, stroke, now } = setup();
  model.paint(row(16, 84, 96, TILE.GRASS));
  model.paint(row(17, 84, 96, TILE.DIRT));
  tick(4000);
  stroke([[102, 11]], TILE.QUESTION);
  tick(90);
  return {
    id: "false-too-early",
    title: "A single ?-block, placed 90 ms ago",
    why: "One tile could start a row of ?-blocks, a platform or a reveal. The person is still moving, so any guess would interrupt them.",
    model,
    stream,
    now: now(),
    mode: "auto",
    lastGhosts: [],
    answer: {
      act: false,
      kind: "finish",
      adds: [],
      removes: [],
      entities: [],
      confidence: 0,
      label: "one tile, too early to tell",
      levelGuess: "story",
    },
  };
}

/** 4. act false: the person is erasing. */
export function falseErasing(): Scenario {
  const { model, stream, tick, row, now } = setup();
  model.paint(row(15, 118, 136, TILE.GRASS));
  model.paint(row(16, 118, 136, TILE.DIRT));
  model.paint(row(11, 124, 129, TILE.BLOCK));
  model.placeEntity("slime", 132, 14);
  tick(5000);
  model.beginStroke();
  for (const x of [129, 128, 127]) {
    tick(140);
    model.erase([{ x, y: 11 }]);
  }
  model.endStroke();
  tick(200);
  return {
    id: "false-erasing",
    title: "Erasing the end of a platform",
    why: "The person is taking tiles away. A suggestion now would fight them, so wait until they draw again.",
    model,
    stream,
    now: now(),
    mode: "auto",
    lastGhosts: [{ kind: "extend", label: "floating block platform", outcome: "accepted", patterns: [] }],
    answer: {
      act: false,
      kind: "extend",
      adds: [],
      removes: [],
      entities: [],
      confidence: 0,
      label: "person is erasing",
      levelGuess: "mixed",
    },
  };
}

/** 5. fix with removals: a wall taller than the knight can climb. */
export function fixWallRemoval(): Scenario {
  const { model, stream, tick, row, stroke, now } = setup();
  model.paint(row(16, 134, 149, TILE.GRASS));
  model.paint(row(17, 134, 149, TILE.DIRT));
  // The wall, drawn earlier: 7 tiles tall on the floor at x 144.
  model.beginStroke();
  for (let y = 15; y >= 9; y--) {
    tick(100);
    model.paintTile(144, y, TILE.BLOCK);
  }
  model.endStroke();
  tick(20_000);
  stroke(
    [
      [150, 16],
      [151, 16],
      [152, 16],
      [153, 16],
    ],
    TILE.GRASS,
  );
  tick(1200);
  return {
    id: "fix-wall-removal",
    title: "A 7-tall wall drawn 20 s ago across the only route",
    why: "From the floor the knight rises 6 at most, and there is no way around the 7-tall wall. Removing its top 2 tiles leaves a 5-tall wall the knight can climb, with slack. The tiles are old, and the label gives the measurement.",
    model,
    stream,
    now: now(),
    mode: "auto",
    lastGhosts: [{ kind: "finish", label: "floor, four more tiles", outcome: "accepted" }],
    answer: {
      act: true,
      kind: "fix",
      adds: [],
      removes: [
        { x: 144, y: 9 },
        { x: 144, y: 10 },
      ],
      entities: [],
      confidence: 0.75,
      label: "wall 7 high · knight rises 6",
      levelGuess: "mixed",
    },
  };
}

/** 6. patrol fix: the agent cannot cross a 13-wide pit. */
export function patrolPitStone(): Scenario {
  const { model, stream, tick, row, now } = setup();
  model.paint(row(15, 166, 177, TILE.GRASS));
  model.paint(row(16, 166, 177, TILE.DIRT));
  model.paint(row(15, 191, 199, TILE.GRASS));
  model.paint(row(16, 191, 199, TILE.DIRT));
  model.placeEntity("flag", 197, 14);
  model.setGoal({ x: 197, y: 14 });
  tick(6000);
  return {
    id: "patrol-pit-stone",
    title: "Patrol: the knight is stuck before a 13-wide pit",
    why: "Two grass tiles in the middle split the pit into gaps of 6 and 5, both clearable from standing. That is the fewest-tile repair, and the person's pit stays a pit.",
    model,
    stream,
    now: now(),
    mode: "patrol",
    blockedAt: { x: 177, y: 14 },
    lastGhosts: [],
    answer: {
      act: true,
      kind: "fix",
      adds: [
        { x: 184, y: 15, tile: "grass" },
        { x: 185, y: 15, tile: "grass" },
      ],
      removes: [],
      entities: [],
      confidence: 0.8,
      label: "pit 13 wide · knight clears 11",
      levelGuess: "parkour",
    },
  };
}

export const SCENARIOS = [
  finishStaircase,
  extendCoinArc,
  falseTooEarly,
  falseErasing,
  fixWallRemoval,
  patrolPitStone,
] as const;

/** Drop the legend line: the system prompt explains the glyphs once. */
export function gridWithoutLegend(grid: string): string {
  return grid
    .split("\n")
    .filter((l) => l !== LEGEND)
    .join("\n");
}

/** The FillRequest the live window builder makes for a scenario. */
export function scenarioRequest(s: Scenario): FillRequest {
  return buildFillRequest(s.model, s.stream, {
    mode: s.mode,
    blockedAt: s.blockedAt,
    previousFailure: s.previousFailure,
    lastGhosts: s.lastGhosts,
    now: s.now,
    cols: FEWSHOT_COLS,
    rows: FEWSHOT_ROWS,
    recentCount: 8,
    historyCount: 5,
    knight: knightLimits(),
    summary: false,
  });
}

/** Scenario -> stored few-shot (window-relative answer). Throws if an answer cell falls outside the window. */
export function buildFewShot(s: Scenario): FewShot {
  const req = scenarioRequest(s);
  const toWin = (p: Point) => {
    const w = levelToWindow(p, req.origin);
    if (w.x < 0 || w.y < 0 || w.x >= req.size.w || w.y >= req.size.h)
      throw new Error(`few-shot ${s.id}: answer cell (${p.x},${p.y}) is outside the window at ${req.origin.x},${req.origin.y}`);
    return w;
  };
  const a = s.answer;
  const answer: ModelAnswer = {
    act: a.act,
    kind: a.kind,
    adds: a.adds.map((c) => ({ ...toWin(c), tile: c.tile })),
    removes: a.removes.map(toWin),
    entities: a.entities.map((e) => ({ kind: e.kind, ...toWin(e) })),
    confidence: a.confidence,
    label: a.label,
  };
  if (a.levelGuess) answer.levelGuess = a.levelGuess;
  const request: FewShotRequest = {
    grid: gridWithoutLegend(req.grid),
    origin: req.origin,
    size: req.size,
    recent: req.recent,
    frontier: req.frontier,
    mode: req.mode,
    lastGhosts: req.lastGhosts,
    knight: req.knight,
  };
  if (req.blockedAt) request.blockedAt = req.blockedAt;
  if (req.previousFailure) request.previousFailure = req.previousFailure;
  return { id: s.id, title: s.title, why: s.why, request, answer };
}
