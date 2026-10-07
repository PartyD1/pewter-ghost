/**
 * A tiny drawing harness for seed fixtures: a LevelModel with a manual clock
 * and every PlacementEvent captured, plus helpers that draw the way a person
 * does (strokes of tiles a beat apart). The captured events become the
 * case's stream state, so the request can be rebuilt exactly.
 */
import {
  TILE,
  type EntityKind,
  type FillMode,
  type GhostHistoryItem,
  type PlacementEvent,
  type Point,
  type TileId,
  type VerdictStage,
} from "../../../apps/editor/src/contracts";
import { LevelModel } from "../../../apps/editor/src/level/LevelModel";
import type { CaseExpectation } from "../types";

/** Ground row of every fixture (the default start (2,14) stands on it). */
export const GROUND_Y = 15;

export interface SeedSpec {
  name: string;
  family: string;
  sessionId: string;
  tags: string[];
  model: LevelModel;
  events: PlacementEvent[];
  now: number;
  recentCount: number;
  mode: FillMode;
  lastGhosts?: GhostHistoryItem[];
  lastGuess?: string;
  previousFailure?: { reason: string; stage: VerdictStage };
  /** Patrol cases: compute the blocking point with the real Patrol (makeSeed). */
  patrol?: boolean;
  expect?: CaseExpectation;
}

export type Cell = readonly [number, number];

export class Sketch {
  t = 5_000;
  readonly model: LevelModel;
  readonly events: PlacementEvent[] = [];

  constructor(start: Point = { x: 2, y: GROUND_Y - 1 }) {
    this.model = new LevelModel({ clock: () => this.t, start });
    this.model.onPlacement((e) => this.events.push(e));
  }

  tick(ms: number): this {
    this.t += ms;
    return this;
  }

  /** Ground (grass on top, dirt below) from x0 to x1 inclusive, as one bulk command. */
  ground(x0: number, x1: number, y = GROUND_Y, depth = 2): this {
    const cells: { x: number; y: number; tile: TileId }[] = [];
    for (let x = x0; x <= x1; x++) {
      cells.push({ x, y, tile: TILE.GRASS });
      for (let d = 1; d < depth && y + d < this.model.h; d++) cells.push({ x, y: y + d, tile: TILE.DIRT });
    }
    this.model.paint(cells);
    return this;
  }

  /** Rectangle of one tile, bulk. */
  rect(x0: number, y0: number, x1: number, y1: number, tile: TileId = TILE.BLOCK): this {
    const cells: { x: number; y: number; tile: TileId }[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push({ x, y, tile });
    this.model.paint(cells);
    return this;
  }

  /** One stroke, one tile every `gap` ms. */
  stroke(cells: readonly Cell[], tile: TileId = TILE.BLOCK, gap = 140): this {
    this.model.beginStroke();
    for (const [x, y] of cells) {
      this.tick(gap);
      this.model.paintTile(x, y, tile);
    }
    this.model.endStroke();
    return this;
  }

  /** Several strokes with a pause between them. */
  strokes(list: readonly (readonly Cell[])[], tile: TileId = TILE.BLOCK, pause = 450, gap = 140): this {
    list.forEach((cells, i) => {
      if (i) this.tick(pause);
      this.stroke(cells, tile, gap);
    });
    return this;
  }

  /** Entities placed one at a time (each its own stroke). */
  place(kind: EntityKind, cells: readonly Cell[], gap = 260): this {
    for (const [x, y] of cells) {
      this.tick(gap);
      this.model.placeEntity(kind, x, y);
    }
    return this;
  }

  /** Erase cells as one stroke. */
  erase(cells: readonly Cell[], gap = 120): this {
    this.model.beginStroke();
    for (const [x, y] of cells) {
      this.tick(gap);
      this.model.erase([{ x, y }]);
    }
    this.model.endStroke();
    return this;
  }

  /** An accepted ghost (author GHOST cells). */
  ghost(id: string, adds: readonly Cell[], tile: TileId = TILE.GRASS, entities: { kind: EntityKind; x: number; y: number }[] = []): this {
    this.model.applySuggestion({
      id,
      adds: adds.map(([x, y]) => ({ x, y, tile })),
      removes: [],
      entities,
    });
    return this;
  }

  spec(s: Omit<SeedSpec, "model" | "events" | "now" | "recentCount"> & { idleMs?: number; recentCount?: number }): SeedSpec {
    this.tick(s.idleMs ?? 900);
    const { idleMs: _i, recentCount, ...rest } = s;
    return { ...rest, model: this.model, events: [...this.events], now: this.t, recentCount: recentCount ?? 12 };
  }
}

/** Cells of a horizontal run. */
export const run = (x0: number, x1: number, y: number): Cell[] => {
  const out: Cell[] = [];
  for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
};

/** Cells of a vertical run (top to bottom). */
export const col = (x: number, y0: number, y1: number): Cell[] => {
  const out: Cell[] = [];
  for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
};
