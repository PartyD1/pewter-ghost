import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TILE, type Entity, type EntityKind, type LevelSnapshot, type TileId } from "../contracts";
import { computePatrol, ENTITY_KINDS, isEnemyKind } from "./entities";
import { LevelModel, type LevelChangeEx } from "./LevelModel";
import { checkSnapshot } from "./snapshot";

const W = 7;
const H = 5;
const TILES: TileId[] = [TILE.BLOCK, TILE.GRASS_HALF, TILE.DIRT, TILE.GRASS, TILE.QUESTION];

// Coordinates slightly outside the level exercise the bounds handling.
const coord = fc.record({ x: fc.integer({ min: -1, max: W }), y: fc.integer({ min: -1, max: H }) });
const tile = fc.constantFrom(...TILES);
const kind = fc.constantFrom<EntityKind>(...ENTITY_KINDS);

type Op =
  | { t: "paint"; cells: { x: number; y: number; tile: TileId }[]; ghost: boolean }
  | { t: "erase"; cells: { x: number; y: number }[]; entities: boolean }
  | { t: "place"; kind: EntityKind; x: number; y: number; ghost: boolean }
  | { t: "remove"; pick: number }
  | { t: "suggest"; adds: { x: number; y: number; tile: TileId }[]; removes: { x: number; y: number }[]; entities: { kind: EntityKind; x: number; y: number }[] }
  | { t: "start"; x: number; y: number }
  | { t: "goal"; p: { x: number; y: number } | undefined }
  | { t: "begin" }
  | { t: "end" }
  | { t: "undo" }
  | { t: "redo" };

const inBounds = fc.record({ x: fc.integer({ min: 0, max: W - 1 }), y: fc.integer({ min: 0, max: H - 1 }) });

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("paint" as const), cells: fc.array(fc.record({ x: coord.map((c) => c.x), y: coord.map((c) => c.y), tile }), { maxLength: 6 }), ghost: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("erase" as const), cells: fc.array(coord, { maxLength: 6 }), entities: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("place" as const), kind, x: coord.map((c) => c.x), y: coord.map((c) => c.y), ghost: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("remove" as const), pick: fc.nat(20) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("suggest" as const),
      adds: fc.array(fc.record({ x: coord.map((c) => c.x), y: coord.map((c) => c.y), tile }), { maxLength: 6 }),
      removes: fc.array(coord, { maxLength: 3 }),
      entities: fc.array(fc.record({ kind, x: coord.map((c) => c.x), y: coord.map((c) => c.y) }), { maxLength: 3 }),
    }),
  },
  { weight: 1, arbitrary: inBounds.map((p) => ({ t: "start" as const, ...p })) },
  { weight: 1, arbitrary: fc.option(inBounds, { nil: undefined }).map((p) => ({ t: "goal" as const, p })) },
  { weight: 2, arbitrary: fc.constant({ t: "begin" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "end" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "undo" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "redo" as const }) },
);

let sugN = 0;
function apply(m: LevelModel, o: Op): void {
  switch (o.t) {
    case "paint":
      m.paint(o.cells, o.ghost ? 2 : 1);
      break;
    case "erase":
      m.erase(o.cells, { entities: o.entities });
      break;
    case "place":
      m.placeEntity(o.kind, o.x, o.y, { author: o.ghost ? 2 : 1, text: o.kind === "sign" ? "hi" : undefined });
      break;
    case "remove": {
      const es = m.entities;
      if (es.length) m.removeEntity(es[o.pick % es.length].id);
      break;
    }
    case "suggest":
      m.applySuggestion({ id: `sg${++sugN}`, adds: o.adds, removes: o.removes, entities: o.entities });
      break;
    case "start":
      m.setStart(o);
      break;
    case "goal":
      m.setGoal(o.p);
      break;
    case "begin":
      m.beginStroke();
      break;
    case "end":
      m.endStroke();
      break;
    case "undo":
      m.undo();
      break;
    case "redo":
      m.redo();
      break;
  }
}

/** Model invariants that every command must keep. */
function checkInvariants(m: LevelModel): void {
  const s = m.snapshot();
  const c = checkSnapshot(s);
  expect(c.ok).toBe(true);
  if (c.ok) expect(c.warnings).toEqual([]);
  const cells = new Set<number>();
  for (const e of s.entities) {
    const i = e.y * s.w + e.x;
    expect(cells.has(i)).toBe(false); // one entity per cell
    cells.add(i);
    expect(s.cells[i]).toBe(0); // never inside a solid tile
    expect(e.patrol).toEqual(isEnemyKind(e.kind) ? computePatrol(m, e.x, e.y) : undefined);
  }
  for (let i = 0; i < s.cells.length; i++) {
    if (s.cells[i] === 0) expect(s.authors[i]).toBe(0);
    if (s.provenance[i] !== undefined) expect(s.authors[i]).toBe(2);
  }
}

/** A renderer that knows the level only through LevelChange events. */
class Mirror {
  cells: number[];
  authors: number[];
  entities = new Map<string, Entity>();
  start: { x: number; y: number };
  goal: { x: number; y: number } | undefined;
  constructor(s: LevelSnapshot) {
    this.cells = s.cells.slice();
    this.authors = s.authors.slice();
    for (const e of s.entities) this.entities.set(e.id, structuredClone(e));
    this.start = { ...s.start };
    this.goal = s.goal ? { ...s.goal } : undefined;
  }
  apply(c: LevelChangeEx): void {
    for (const cell of c.cells) {
      this.cells[cell.y * W + cell.x] = cell.tile;
      this.authors[cell.y * W + cell.x] = cell.author;
    }
    for (const id of c.entitiesRemoved) this.entities.delete(id);
    for (const e of c.entitiesAdded) this.entities.set(e.id, structuredClone(e));
    for (const e of c.entitiesUpdated ?? []) this.entities.set(e.id, structuredClone(e));
    if (c.start) this.start = { ...c.start };
    if (c.goal !== undefined) this.goal = c.goal ?? undefined;
  }
  matches(m: LevelModel): void {
    const s = m.snapshot();
    expect(this.cells).toEqual(s.cells);
    expect(this.authors).toEqual(s.authors);
    const sorted = (es: Entity[]) => [...es].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted([...this.entities.values()])).toEqual(sorted(s.entities));
    expect(this.start).toEqual(s.start);
    expect(this.goal).toEqual(s.goal);
  }
}

function seeded(): LevelModel {
  const m = new LevelModel({ w: W, h: H, clock: () => 0 });
  // Some starting content with a floor so patrols are interesting.
  m.paint(Array.from({ length: W }, (_, x) => ({ x, y: H - 1, tile: TILE.GRASS })));
  m.placeEntity("slime", 3, H - 2);
  m.placeEntity("coin", 6, 2);
  m.setGoal({ x: W - 1, y: H - 2 });
  m.clearHistory();
  return m;
}

describe("LevelModel properties", () => {
  it("any command sequence then undo-all restores the original snapshot; redo-all restores the final one", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const m = seeded();
        const original = m.snapshot();
        for (const o of ops) {
          if (o.t === "undo" || o.t === "redo") continue; // pure forward sequence
          apply(m, o);
        }
        m.endStroke();
        const final = m.snapshot();
        let guard = 0;
        while (m.undo()) guard++;
        expect(m.snapshot()).toEqual(original);
        while (m.redo()) guard--;
        expect(guard).toBe(0);
        expect(m.snapshot()).toEqual(final);
      }),
      { numRuns: 300 },
    );
  });

  it("interleaved undo/redo keeps invariants and the event mirror in sync", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 50 }), (ops) => {
        const m = seeded();
        const mirror = new Mirror(m.snapshot());
        m.subscribe((c) => mirror.apply(c));
        for (const o of ops) {
          apply(m, o);
          checkInvariants(m);
          mirror.matches(m);
        }
        while (m.undo()) mirror.matches(m);
        checkInvariants(m);
      }),
      { numRuns: 200 },
    );
  });

  it("each undo exactly reverts the preceding command, wherever it sits in history", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        const m = seeded();
        const states: LevelSnapshot[] = [m.snapshot()];
        for (const o of ops) {
          if (o.t === "undo" || o.t === "redo" || o.t === "begin" || o.t === "end") continue;
          const depth = m.undoDepth;
          apply(m, o);
          if (m.undoDepth > depth) states.push(m.snapshot());
        }
        for (let k = states.length - 1; k > 0; k--) {
          expect(m.snapshot()).toEqual(states[k]);
          m.undo();
        }
        expect(m.snapshot()).toEqual(states[0]);
      }),
      { numRuns: 200 },
    );
  });

  it("applySuggestion is always a single undo step", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 15 }), op.filter((o) => o.t === "suggest"), (pre, s) => {
        const m = seeded();
        for (const o of pre) apply(m, o);
        const before = m.snapshot();
        const depth = m.undoDepth;
        apply(m, s);
        if (m.undoDepth === depth) {
          expect(m.snapshot()).toEqual(before); // nothing in bounds changed
          return;
        }
        expect(m.undoDepth).toBe(depth + 1);
        m.undo();
        expect(m.snapshot()).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  it("snapshot -> fromSnapshot -> snapshot is the identity", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        const m = seeded();
        for (const o of ops) apply(m, o);
        const s = m.snapshot();
        expect(LevelModel.fromSnapshot(s).snapshot()).toEqual(s);
      }),
      { numRuns: 150 },
    );
  });
});
