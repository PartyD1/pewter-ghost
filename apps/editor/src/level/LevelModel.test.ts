import { describe, expect, it } from "vitest";
import { AUTHOR, LEVEL_H, LEVEL_W, TILE, type LevelChange, type PlacementEvent } from "../contracts";
import { DEFAULT_START, LevelModel, OUT_OF_BOUNDS, type LevelChangeEx } from "./LevelModel";

function model(opts: { w?: number; h?: number } = {}) {
  let now = 1000;
  const m = new LevelModel({ w: opts.w ?? 20, h: opts.h ?? 10, clock: () => now });
  const changes: LevelChangeEx[] = [];
  const placements: PlacementEvent[] = [];
  m.subscribe((c) => changes.push(c));
  m.onPlacement((p) => placements.push(p));
  return {
    m,
    changes,
    placements,
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const floor = (m: LevelModel, y: number, x0: number, x1: number, tile: number = TILE.GRASS) => {
  const cells = [];
  for (let x = x0; x <= x1; x++) cells.push({ x, y, tile: tile as 6 });
  m.paint(cells);
};

describe("LevelModel basics", () => {
  it("defaults to the contract level size and a start on the default ground", () => {
    const m = new LevelModel();
    expect(m.w).toBe(LEVEL_W);
    expect(m.h).toBe(LEVEL_H);
    expect(m.start).toEqual(DEFAULT_START);
    expect(m.goal).toBeUndefined();
    expect(m.canUndo).toBe(false);
    expect(m.canRedo).toBe(false);
  });

  it("paints tiles with author and reports them", () => {
    const { m, changes } = model();
    const n = m.paint([
      { x: 1, y: 2, tile: TILE.BLOCK },
      { x: 2, y: 2, tile: TILE.DIRT },
    ]);
    expect(n).toBe(2);
    expect(m.tileAt(1, 2)).toBe(TILE.BLOCK);
    expect(m.tileAt(2, 2)).toBe(TILE.DIRT);
    expect(m.authorAt(1, 2)).toBe(AUTHOR.PERSON);
    expect(m.isSolid(1, 2)).toBe(true);
    expect(m.isSolid(3, 2)).toBe(false);
    expect(changes).toHaveLength(1);
    expect(changes[0].source).toBe("person");
    expect(changes[0].cells).toEqual([
      { x: 1, y: 2, tile: TILE.BLOCK, author: AUTHOR.PERSON },
      { x: 2, y: 2, tile: TILE.DIRT, author: AUTHOR.PERSON },
    ]);
  });

  it("ignores out-of-bounds cells and treats outside as empty", () => {
    const { m, changes } = model();
    expect(m.paint([{ x: -1, y: 0, tile: TILE.BLOCK }, { x: 0, y: 99, tile: TILE.BLOCK }])).toBe(0);
    expect(changes).toHaveLength(0);
    expect(m.canUndo).toBe(false);
    expect(m.tileAt(-1, 0)).toBe(0);
    expect(m.isSolid(500, 500)).toBe(false);
  });

  it("rejects non-terrain tiles", () => {
    const { m } = model();
    expect(() => m.paint([{ x: 0, y: 0, tile: 2 as never }])).toThrow(RangeError);
    expect(() => m.paint([{ x: 0, y: 0, tile: 0 as never }])).toThrow(RangeError);
  });

  it("does not record no-op paints", () => {
    const { m, changes } = model();
    m.paintTile(3, 3, TILE.BLOCK);
    m.paintTile(3, 3, TILE.BLOCK);
    expect(changes).toHaveLength(1);
    expect(m.undoDepth).toBe(1);
  });

  it("erase clears tiles and entities and undo restores both", () => {
    const { m } = model();
    m.paintTile(4, 4, TILE.BLOCK);
    m.placeEntity("coin", 5, 4);
    const before = m.snapshot();
    expect(m.erase([{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 }])).toBe(2);
    expect(m.tileAt(4, 4)).toBe(0);
    expect(m.authorAt(4, 4)).toBe(AUTHOR.NONE);
    expect(m.entitiesAt(5, 4)).toEqual([]);
    m.undo();
    expect(m.snapshot()).toEqual(before);
  });

  it("erase can leave entities alone", () => {
    const { m } = model();
    m.placeEntity("coin", 5, 4);
    expect(m.erase([{ x: 5, y: 4 }], { entities: false })).toBe(0);
    expect(m.entitiesAt(5, 4)).toHaveLength(1);
  });

  it("window returns a relative view with OUT_OF_BOUNDS outside", () => {
    const { m } = model();
    m.paintTile(0, 0, TILE.BLOCK);
    m.placeEntity("coin", 1, 1);
    const win = m.window(-1, -1, 3, 3);
    expect(win.tileAt(0, 0)).toBe(OUT_OF_BOUNDS);
    expect(win.tileAt(1, 1)).toBe(TILE.BLOCK);
    expect(win.authorAt(1, 1)).toBe(AUTHOR.PERSON);
    expect(win.tileAt(2, 2)).toBe(0);
    expect(win.inLevel(0, 0)).toBe(false);
    expect(win.inLevel(1, 1)).toBe(true);
    expect(win.tileAt(5, 5)).toBe(OUT_OF_BOUNDS);
    expect(win.entities.map((e) => [e.kind, e.x, e.y])).toEqual([["coin", 1, 1]]);
    expect(win.cells).toHaveLength(9);
  });

  it("entitiesInRect filters by rectangle", () => {
    const { m } = model();
    m.placeEntity("coin", 1, 1);
    m.placeEntity("fruit", 5, 5);
    m.placeEntity("flag", 9, 9);
    expect(m.entitiesInRect(0, 0, 6, 6).map((e) => e.kind)).toEqual(["coin", "fruit"]);
    expect(m.entitiesInRect(6, 6, 10, 10).map((e) => e.kind)).toEqual(["flag"]);
  });

  it("returned entities are copies", () => {
    const { m } = model();
    const e = m.placeEntity("coin", 1, 1)!;
    e.x = 7;
    m.entities[0].x = 9;
    expect(m.getEntity(e.id)!.x).toBe(1);
  });
});

describe("entities", () => {
  it("one entity per cell: placing replaces", () => {
    const { m } = model();
    const a = m.placeEntity("coin", 2, 2)!;
    const b = m.placeEntity("fruit", 2, 2)!;
    expect(m.entitiesAt(2, 2).map((e) => e.id)).toEqual([b.id]);
    expect(m.getEntity(a.id)).toBeUndefined();
    m.undo();
    expect(m.entitiesAt(2, 2).map((e) => e.id)).toEqual([a.id]);
  });

  it("placing an entity clears the tile; painting removes the entity", () => {
    const { m } = model();
    m.paintTile(2, 2, TILE.BLOCK);
    m.placeEntity("coin", 2, 2);
    expect(m.tileAt(2, 2)).toBe(0);
    m.paintTile(2, 2, TILE.DIRT);
    expect(m.entitiesAt(2, 2)).toEqual([]);
    m.undo();
    expect(m.entitiesAt(2, 2)).toHaveLength(1);
    expect(m.tileAt(2, 2)).toBe(0);
    m.undo();
    expect(m.tileAt(2, 2)).toBe(TILE.BLOCK);
    expect(m.entityCount).toBe(0);
  });

  it("removeEntity is undoable and keeps list order", () => {
    const { m } = model();
    const ids = [m.placeEntity("coin", 1, 1)!.id, m.placeEntity("coin", 2, 1)!.id, m.placeEntity("coin", 3, 1)!.id];
    expect(m.removeEntity(ids[1])).toBe(true);
    expect(m.removeEntity("nope")).toBe(false);
    expect(m.entities.map((e) => e.id)).toEqual([ids[0], ids[2]]);
    m.undo();
    expect(m.entities.map((e) => e.id)).toEqual(ids);
  });

  it("rejects duplicate explicit ids and unknown kinds", () => {
    const { m } = model();
    m.placeEntity("sign", 1, 1, { id: "hello", text: "hi" });
    expect(m.getEntity("hello")!.text).toBe("hi");
    expect(() => m.placeEntity("coin", 2, 2, { id: "hello" })).toThrow();
    expect(() => m.placeEntity("dragon" as never, 2, 2)).toThrow(RangeError);
    expect(m.placeEntity("coin", -5, 2)).toBeUndefined();
  });

  it("enemies get a patrol span that follows floor edits", () => {
    const { m, changes } = model();
    floor(m, 8, 3, 9);
    const slime = m.placeEntity("slime", 5, 7)!;
    expect(slime.patrol).toEqual([3, 9]);
    changes.length = 0;
    m.paintTile(8, 7, TILE.BLOCK); // wall on the walking row
    expect(m.getEntity(slime.id)!.patrol).toEqual([3, 7]);
    expect(changes[0].entitiesUpdated?.map((e) => [e.id, e.patrol])).toEqual([[slime.id, [3, 7]]]);
    m.erase([{ x: 5, y: 8 }]); // floor under the slime
    expect(m.getEntity(slime.id)!.patrol).toBeUndefined();
    m.undo();
    m.undo();
    expect(m.getEntity(slime.id)!.patrol).toEqual([3, 9]);
    const coin = m.placeEntity("coin", 6, 7)!;
    expect(coin.patrol).toBeUndefined();
  });
});

describe("undo / redo", () => {
  it("undo and redo restore exact snapshots and emit undo/redo sources", () => {
    const { m, changes } = model();
    const s0 = m.snapshot();
    m.paintTile(1, 1, TILE.BLOCK);
    const s1 = m.snapshot();
    m.placeEntity("coin", 2, 1);
    const s2 = m.snapshot();
    expect(m.undo()!.kind).toBe("placeEntity");
    expect(m.snapshot()).toEqual(s1);
    expect(changes.at(-1)!.source).toBe("undo");
    expect(changes.at(-1)!.entitiesRemoved).toHaveLength(1);
    m.undo();
    expect(m.snapshot()).toEqual(s0);
    expect(m.undo()).toBeUndefined();
    m.redo();
    m.redo();
    expect(m.snapshot()).toEqual(s2);
    expect(changes.at(-1)!.source).toBe("redo");
    expect(changes.at(-1)!.entitiesAdded).toHaveLength(1);
    expect(m.redo()).toBeUndefined();
  });

  it("a new command clears redo", () => {
    const { m } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    m.undo();
    expect(m.canRedo).toBe(true);
    m.paintTile(2, 1, TILE.BLOCK);
    expect(m.canRedo).toBe(false);
  });

  it("history is capped", () => {
    const m = new LevelModel({ w: 20, h: 10, maxHistory: 3 });
    for (let x = 0; x < 6; x++) m.paintTile(x, 0, TILE.BLOCK);
    expect(m.undoDepth).toBe(3);
    while (m.undo());
    expect(m.tileAt(2, 0)).toBe(TILE.BLOCK);
    expect(m.tileAt(3, 0)).toBe(0);
  });

  it("revision increases on every change", () => {
    const { m } = model();
    const r0 = m.revision;
    m.paintTile(1, 1, TILE.BLOCK);
    m.undo();
    m.redo();
    expect(m.revision).toBe(r0 + 3);
  });

  it("peekUndo reports own / ghost / mixed", () => {
    const { m } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    expect(m.peekUndo()!.what).toBe("own");
    m.applySuggestion({ id: "sg1", adds: [{ x: 2, y: 1, tile: TILE.BLOCK }], removes: [], entities: [] });
    expect(m.peekUndo()).toEqual({ kind: "applySuggestion", what: "ghost", suggestionId: "sg1" });
    m.erase([{ x: 2, y: 1 }]);
    expect(m.peekUndo()!.what).toBe("mixed");
    expect(m.undo()!.what).toBe("mixed");
  });
});

describe("strokes", () => {
  it("merges paint calls in a stroke into one undo step with one stroke id", () => {
    const { m, placements } = model();
    const id = m.beginStroke();
    expect(m.currentStroke).toBe(id);
    m.paintTile(1, 1, TILE.BLOCK);
    m.paintTile(2, 1, TILE.BLOCK);
    m.erase([{ x: 1, y: 1 }]);
    m.paintTile(3, 1, TILE.DIRT);
    m.endStroke();
    expect(m.currentStroke).toBeUndefined();
    expect(m.undoDepth).toBe(1);
    expect(placements.map((p) => p.stroke)).toEqual([id, id, id, id]);
    expect(placements.map((p) => p.tool)).toEqual(["paint", "paint", "erase", "paint"]);
    expect(m.peekUndo()!.kind).toBe("stroke");
    m.undo();
    expect(m.authoredBy().cells).toEqual({ none: 0, person: 0, ghost: 0 });
    m.redo();
    expect(m.tileAt(1, 1)).toBe(0);
    expect(m.tileAt(2, 1)).toBe(TILE.BLOCK);
    expect(m.tileAt(3, 1)).toBe(TILE.DIRT);
  });

  it("repainting the same cell within a stroke still undoes to the pre-stroke state", () => {
    const { m } = model();
    m.beginStroke();
    m.paintTile(1, 1, TILE.BLOCK);
    m.placeEntity("coin", 1, 1);
    m.paintTile(1, 1, TILE.DIRT);
    m.paintTile(1, 1, TILE.GRASS);
    m.endStroke();
    expect(m.undoDepth).toBe(1);
    m.undo();
    expect(m.tileAt(1, 1)).toBe(0);
    expect(m.entityCount).toBe(0);
    m.redo();
    expect(m.tileAt(1, 1)).toBe(TILE.GRASS);
    expect(m.entityCount).toBe(0);
  });

  it("separate calls outside strokes get separate stroke ids and undo steps", () => {
    const { m, placements } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    m.paintTile(2, 1, TILE.BLOCK);
    expect(m.undoDepth).toBe(2);
    expect(placements[0].stroke).not.toBe(placements[1].stroke);
  });

  it("a ghost accept in the middle of a stroke ends the stroke", () => {
    const { m } = model();
    m.beginStroke();
    m.paintTile(1, 1, TILE.BLOCK);
    m.applySuggestion({ id: "g", adds: [{ x: 5, y: 5, tile: TILE.BLOCK }], removes: [], entities: [] });
    m.paintTile(2, 1, TILE.BLOCK);
    m.endStroke();
    expect(m.undoDepth).toBe(3);
  });

  it("undo during a stroke closes it", () => {
    const { m } = model();
    m.beginStroke();
    m.paintTile(1, 1, TILE.BLOCK);
    m.undo();
    expect(m.currentStroke).toBeUndefined();
    m.paintTile(2, 1, TILE.BLOCK);
    expect(m.undoDepth).toBe(1);
  });

  it("an empty stroke records nothing", () => {
    const { m } = model();
    m.beginStroke();
    m.endStroke();
    expect(m.canUndo).toBe(false);
  });
});

describe("placement events", () => {
  it("emits per changed cell for person edits, not for ghost or undo", () => {
    const { m, placements, tick } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    tick(50);
    m.placeEntity("coin", 3, 3);
    tick(50);
    m.erase([{ x: 1, y: 1 }]);
    m.applySuggestion({ id: "s", adds: [{ x: 5, y: 5, tile: TILE.BLOCK }], removes: [], entities: [{ kind: "coin", x: 6, y: 4 }] });
    m.undo();
    expect(placements.map((p) => [p.t, p.x, p.y, p.tile, p.tool, p.author])).toEqual([
      [1000, 1, 1, TILE.BLOCK, "paint", AUTHOR.PERSON],
      [1050, 3, 3, "entity:coin", "paint", AUTHOR.PERSON],
      [1100, 1, 1, 0, "erase", AUTHOR.PERSON],
    ]);
  });

  it("removeEntity emits an erase", () => {
    const { m, placements } = model();
    const e = m.placeEntity("fruit", 2, 2)!;
    m.removeEntity(e.id);
    expect(placements.at(-1)).toMatchObject({ x: 2, y: 2, tile: 0, tool: "erase" });
  });

  it("listener errors do not break the model", () => {
    const errors: unknown[] = [];
    const m = new LevelModel({ w: 5, h: 5, onListenerError: (e) => errors.push(e) });
    const seen: LevelChange[] = [];
    m.subscribe(() => {
      throw new Error("boom");
    });
    m.subscribe((c) => seen.push(c));
    m.paintTile(1, 1, TILE.BLOCK);
    expect(errors).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(m.tileAt(1, 1)).toBe(TILE.BLOCK);
  });

  it("unsubscribe stops delivery", () => {
    const m = new LevelModel({ w: 5, h: 5 });
    let n = 0;
    const off = m.subscribe(() => n++);
    m.paintTile(1, 1, TILE.BLOCK);
    off();
    m.paintTile(2, 1, TILE.BLOCK);
    expect(n).toBe(1);
  });
});

describe("applySuggestion", () => {
  it("applies adds, removes and entities as ONE undo step with ghost authorship", () => {
    const { m, changes } = model();
    m.paint([
      { x: 1, y: 5, tile: TILE.BLOCK },
      { x: 2, y: 5, tile: TILE.BLOCK },
    ]);
    const before = m.snapshot();
    const res = m.applySuggestion({
      id: "sug-1",
      adds: [
        { x: 3, y: 5, tile: TILE.GRASS },
        { x: 4, y: 5, tile: TILE.GRASS },
      ],
      removes: [{ x: 1, y: 5 }],
      entities: [{ kind: "coin", x: 4, y: 4 }],
    });
    expect(res.cellsChanged).toBe(4);
    expect(res.entityIds).toHaveLength(1);
    expect(m.tileAt(1, 5)).toBe(0);
    expect(m.authorAt(3, 5)).toBe(AUTHOR.GHOST);
    expect(m.provenanceAt(3, 5)).toBe("sug-1");
    expect(m.entityAuthor(res.entityIds[0])).toBe(AUTHOR.GHOST);
    expect(m.cellsFromSuggestion("sug-1")).toEqual([
      { x: 3, y: 5 },
      { x: 4, y: 5 },
    ]);
    expect(changes.at(-1)!.source).toBe("ghost");
    expect(m.authoredBy()).toEqual({
      cells: { none: 0, person: 1, ghost: 2 },
      entities: { none: 0, person: 0, ghost: 1 },
    });
    expect(m.undoDepth).toBe(2);
    m.undo();
    expect(m.snapshot()).toEqual(before);
    m.redo();
    expect(m.provenanceAt(4, 5)).toBe("sug-1");
  });

  it("person painting over a ghost tile takes authorship and clears provenance", () => {
    const { m } = model();
    m.applySuggestion({ id: "s", adds: [{ x: 3, y: 5, tile: TILE.GRASS }], removes: [], entities: [] });
    m.paintTile(3, 5, TILE.GRASS);
    expect(m.authorAt(3, 5)).toBe(AUTHOR.PERSON);
    expect(m.provenanceAt(3, 5)).toBeUndefined();
  });

  it("an empty or out-of-bounds suggestion records nothing", () => {
    const { m } = model();
    m.applySuggestion({ id: "s", adds: [{ x: 99, y: 99, tile: TILE.GRASS }], removes: [], entities: [] });
    expect(m.canUndo).toBe(false);
  });

  it("validates tiles and kinds before touching anything", () => {
    const { m } = model();
    expect(() =>
      m.applySuggestion({ id: "s", adds: [{ x: 1, y: 1, tile: 9 as never }], removes: [], entities: [] }),
    ).toThrow();
    expect(() =>
      m.applySuggestion({ id: "s", adds: [], removes: [], entities: [{ kind: "boss" as never, x: 1, y: 1 }] }),
    ).toThrow();
    expect(m.revision).toBe(0);
  });
});

describe("start and goal", () => {
  it("are undoable commands and appear in changes", () => {
    const { m, changes } = model();
    const start0 = m.start;
    expect(start0).toEqual({ x: DEFAULT_START.x, y: 9 }); // clamped into a 10-row level
    expect(m.setStart({ x: 1, y: 1 })).toBe(true);
    expect(m.setStart({ x: 1, y: 1 })).toBe(false);
    expect(changes.at(-1)!.start).toEqual({ x: 1, y: 1 });
    expect(m.setGoal({ x: 9, y: 2 })).toBe(true);
    expect(changes.at(-1)!.goal).toEqual({ x: 9, y: 2 });
    expect(m.setGoal(undefined)).toBe(true);
    expect(changes.at(-1)!.goal).toBeNull();
    expect(m.setGoal(undefined)).toBe(false);
    m.undo();
    expect(m.goal).toEqual({ x: 9, y: 2 });
    m.undo();
    m.undo();
    expect(m.start).toEqual(start0);
    expect(() => m.setStart({ x: -1, y: 0 })).toThrow(RangeError);
    expect(() => m.setGoal({ x: 0, y: 100 })).toThrow(RangeError);
  });
});

describe("placement times (fix grace)", () => {
  it("tracks last placement per cell and cells placed since t", () => {
    const { m, tick } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    tick(2000);
    m.paintTile(2, 1, TILE.BLOCK);
    tick(500);
    m.applySuggestion({ id: "s", adds: [{ x: 3, y: 1, tile: TILE.BLOCK }], removes: [], entities: [] });
    expect(m.lastPlacementAt(1, 1)).toEqual({ t: 1000, author: AUTHOR.PERSON });
    expect(m.lastPlacementAt(3, 1)).toEqual({ t: 3500, author: AUTHOR.GHOST });
    expect(m.lastPlacementAt(9, 9)).toBeUndefined();
    expect(m.cellsPlacedSince(2000)).toEqual([{ x: 2, y: 1 }]);
    expect(m.cellsPlacedSince(2000, null)).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    expect(m.cellsPlacedSince(0, AUTHOR.GHOST)).toEqual([{ x: 3, y: 1 }]);
  });
});

describe("snapshot / load", () => {
  it("fromSnapshot round-trips and continues entity ids", () => {
    const { m } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    m.placeEntity("coin", 2, 2);
    m.applySuggestion({ id: "x", adds: [{ x: 3, y: 3, tile: TILE.DIRT }], removes: [], entities: [] });
    m.setGoal({ x: 10, y: 3 });
    const snap = m.snapshot();
    const m2 = LevelModel.fromSnapshot(snap);
    expect(m2.snapshot()).toEqual(snap);
    expect(m2.canUndo).toBe(false);
    const e = m2.placeEntity("fruit", 5, 5)!;
    expect(snap.entities.some((x) => x.id === e.id)).toBe(false);
  });

  it("snapshot is a deep copy", () => {
    const { m } = model();
    const s = m.snapshot();
    s.cells[0] = TILE.BLOCK;
    s.start.x = 9;
    expect(m.tileAt(0, 0)).toBe(0);
    expect(m.start.x).toBe(DEFAULT_START.x);
    expect(m.start.y).toBe(9);
  });

  it("load replaces everything, clears history and emits a load change", () => {
    const { m, changes } = model();
    const other = new LevelModel({ w: 20, h: 10 });
    other.paintTile(4, 4, TILE.QUESTION);
    other.placeEntity("slime", 4, 3);
    m.placeEntity("coin", 1, 1);
    m.load(other.snapshot());
    expect(m.snapshot()).toEqual(other.snapshot());
    expect(m.canUndo).toBe(false);
    const c = changes.at(-1)!;
    expect(c.source).toBe("load");
    expect(c.cells).toHaveLength(200);
    expect(c.entitiesRemoved).toHaveLength(1);
    expect(c.entitiesAdded).toHaveLength(1);
  });

  it("load rejects a bad snapshot without touching the model", () => {
    const { m } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    const good = m.snapshot();
    const bad = { ...good, cells: good.cells.slice(1) };
    expect(() => m.load(bad)).toThrow();
    expect(() => m.load({ ...good, w: 10, h: 20 })).toThrow();
    expect(() => m.load({ ...good, cells: good.cells.map(() => 3) })).toThrow();
    expect(m.snapshot()).toEqual(good);
  });

  it("clear empties the level", () => {
    const { m } = model();
    m.paintTile(1, 1, TILE.BLOCK);
    m.clear();
    expect(m.tileAt(1, 1)).toBe(0);
    expect(m.canUndo).toBe(false);
  });
});
