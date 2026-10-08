import { describe, expect, it, vi } from "vitest";
import { AUTHOR, TILE, type GhostOutcome } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { FakeClock } from "../suggest/fakeClock";
import { SuggestionManager } from "../suggest/SuggestionManager";
import { makeSuggestion, testConfig } from "../suggest/testUtils";
import { bindGhostInput, changedCells } from "./input";

type KeyInit = { key: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; repeat?: boolean };

class FakeTarget {
  private fns: ((e: unknown) => void)[] = [];
  addEventListener(_t: string, fn: (e: unknown) => void) {
    this.fns.push(fn);
  }
  removeEventListener(_t: string, fn: (e: unknown) => void) {
    this.fns = this.fns.filter((f) => f !== fn);
  }
  press(init: KeyInit) {
    const ev = { ...init, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const f of this.fns) f(ev);
    return ev;
  }
  get count() {
    return this.fns.length;
  }
}

function setup() {
  const clock = new FakeClock();
  clock.set(10_000);
  const model = new LevelModel({ clock: () => clock.now() });
  const ends: GhostOutcome[] = [];
  const manager = new SuggestionManager({
    clock,
    config: testConfig({ cooldownAfterDismissMs: 0 }),
    listeners: {
      onEnd: (_s, o) => ends.push(o),
      onAcceptApply: (s, info) => {
        const adds = info.remaining.flatMap((c) => (c.type === "add" ? [{ x: c.x, y: c.y, tile: c.tile as 6 }] : []));
        const removes = info.remaining.flatMap((c) => (c.type === "remove" ? [{ x: c.x, y: c.y }] : []));
        model.applySuggestion({ id: s.id, adds, removes, entities: [] });
      },
    },
  });
  const target = new FakeTarget();
  let playing = false;
  let stroke = false;
  const calls = { request: 0, route: 0, load: 0 };
  const unbind = bindGhostInput({
    model,
    manager,
    isPlaying: () => playing,
    isStrokeActive: () => stroke,
    dialogOpen: () => false,
    accept: () => manager.accept(),
    dismiss: () => manager.dismiss(),
    request: () => {
      calls.request++;
      manager.requestNow();
    },
    route: () => calls.route++,
    onLoad: () => calls.load++,
    clock: () => clock.now(),
    target,
  });
  const ghost = () =>
    makeSuggestion({
      adds: [
        { x: 10, y: 15, tile: TILE.GRASS },
        { x: 11, y: 15, tile: TILE.GRASS },
        { x: 12, y: 15, tile: TILE.GRASS },
      ],
      confidence: 0.99,
    });
  const show = (s = ghost()) => {
    clock.advance(10);
    const r = manager.offer(s, { requestedAt: clock.now() });
    expect(r.status).toBe("shown");
    return s;
  };
  return { clock, model, manager, target, ends, calls, unbind, show, setPlaying: (p: boolean) => (playing = p), setStroke: (s: boolean) => (stroke = s) };
}

describe("changedCells", () => {
  it("collects tile cells and entity positions, remembering removed entities", () => {
    const pos = new Map([["e1", { x: 4, y: 4 }]]);
    const cells = changedCells(
      {
        cells: [{ x: 1, y: 2, tile: 0, author: 0 }],
        entitiesAdded: [{ id: "e2", kind: "coin", x: 7, y: 3 }],
        entitiesRemoved: ["e1", "unknown"],
        source: "undo",
      },
      pos,
    );
    expect(cells).toEqual([
      { x: 1, y: 2 },
      { x: 4, y: 4 },
      { x: 7, y: 3 },
    ]);
    expect(pos.has("e1")).toBe(false);
    expect(pos.get("e2")).toEqual({ x: 7, y: 3 });
  });
});

describe("bindGhostInput", () => {
  it("Tab accepts the whole ghost as one undo step authored GHOST; undo restores", () => {
    const t = setup();
    const s = t.show();
    const ev = t.target.press({ key: "Tab" });
    expect(ev.defaultPrevented).toBe(true);
    expect(t.ends).toEqual(["accepted"]);
    for (const x of [10, 11, 12]) {
      expect(t.model.tileAt(x, 15)).toBe(TILE.GRASS);
      expect(t.model.authorAt(x, 15)).toBe(AUTHOR.GHOST);
      expect(t.model.provenanceAt(x, 15)).toBe(s.id);
    }
    expect(t.model.undoDepth).toBe(1);
    t.model.undo();
    for (const x of [10, 11, 12]) expect(t.model.tileAt(x, 15)).toBe(0);
  });

  it("Tab without a ghost is not swallowed (focus moves normally)", () => {
    const t = setup();
    expect(t.target.press({ key: "Tab" }).defaultPrevented).toBe(false);
  });

  it("Tab during a stroke is swallowed but does not apply", () => {
    const t = setup();
    t.show();
    t.setStroke(true);
    expect(t.target.press({ key: "Tab" }).defaultPrevented).toBe(true);
    expect(t.manager.shown).not.toBeNull();
    expect(t.model.tileAt(10, 15)).toBe(0);
  });

  it("Esc dismisses", () => {
    const t = setup();
    t.show();
    t.target.press({ key: "Escape" });
    expect(t.ends).toEqual(["esc"]);
  });

  it("Ctrl+Space requests; R does nothing (the route overlay was removed)", () => {
    const t = setup();
    t.target.press({ key: " ", code: "Space", ctrlKey: true });
    expect(t.calls.request).toBe(1);
    expect(t.manager.requestPending).toBe(true);
    t.target.press({ key: "r" });
    expect(t.calls.route).toBe(0);
    t.setPlaying(true);
    t.target.press({ key: "r" });
    expect(t.calls.route).toBe(0);
  });

  it("painting the proposed tile on a ghost cell accepts that cell; painting elsewhere ends it partial", () => {
    const t = setup();
    t.show();
    t.clock.advance(50);
    t.model.beginStroke();
    t.model.paintTile(11, 15, TILE.GRASS);
    t.model.endStroke();
    expect(t.manager.shown).not.toBeNull();
    expect(t.manager.remainingCells.map((c) => c.x)).toEqual([10, 12]);
    expect(t.model.authorAt(11, 15)).toBe(AUTHOR.PERSON);
    t.clock.advance(50);
    t.model.beginStroke();
    t.model.paintTile(30, 10, TILE.DIRT);
    t.model.endStroke();
    expect(t.ends).toEqual(["partial"]);
  });

  it("painting a different tile on a ghost cell draws over it", () => {
    const t = setup();
    t.show();
    t.model.beginStroke();
    t.model.paintTile(10, 15, TILE.DIRT);
    t.model.endStroke();
    expect(t.ends).toEqual(["drawn-over"]);
  });

  it("Tab after a partial applies only the rest, still one undo step", () => {
    const t = setup();
    t.show();
    t.model.beginStroke();
    t.model.paintTile(10, 15, TILE.GRASS);
    t.model.endStroke();
    t.target.press({ key: "Tab" });
    expect(t.ends).toEqual(["accepted"]);
    expect(t.model.authorAt(10, 15)).toBe(AUTHOR.PERSON);
    expect(t.model.authorAt(11, 15)).toBe(AUTHOR.GHOST);
    t.model.undo();
    expect(t.model.tileAt(11, 15)).toBe(0);
    expect(t.model.tileAt(10, 15)).toBe(TILE.GRASS);
  });

  it("a Fix: removals and additions apply together and undo restores exactly", () => {
    const t = setup();
    t.model.beginStroke();
    for (const x of [20, 21, 22]) t.model.paintTile(x, 15, TILE.DIRT);
    t.model.endStroke();
    const before = t.model.snapshot();
    t.clock.advance(10_000); // past fix grace
    const fix = makeSuggestion({
      kind: "fix",
      adds: [{ x: 21, y: 13, tile: TILE.GRASS }],
      removes: [{ x: 22, y: 15 }],
      confidence: 0.99,
      label: "gap 9 · knight clears 6",
    });
    expect(t.manager.offer(fix, { requestedAt: t.clock.now() }).status).toBe("shown");
    t.target.press({ key: "Tab" });
    expect(t.model.tileAt(22, 15)).toBe(0);
    expect(t.model.tileAt(21, 13)).toBe(TILE.GRASS);
    t.model.undo();
    expect(t.model.snapshot()).toEqual(before);
  });

  it("undo touching a shown ghost's cells draws it over; accepting a ghost is not reported as a change", () => {
    const t = setup();
    t.model.beginStroke();
    t.model.paintTile(11, 15, TILE.DIRT);
    t.model.endStroke();
    t.clock.advance(100);
    const spy = vi.spyOn(t.manager, "onCellsChanged");
    t.show();
    t.target.press({ key: "Tab" }); // the ghost overwrites (11,15) dirt with grass: source "ghost"
    expect(spy).not.toHaveBeenCalled();
    t.show(
      makeSuggestion({ adds: [{ x: 11, y: 14, tile: TILE.GRASS }], confidence: 0.99 }),
    );
    t.model.undo(); // undoes the accept: cells (10..12,15) — not the shown ghost's cell
    expect(spy).toHaveBeenCalledTimes(1);
    expect(t.manager.shown).not.toBeNull(); // dismissOnDrawElsewhere applies to placements only
    t.model.undo(); // undoes the dirt stroke at (11,15): still not a ghost cell
    t.model.redo();
    expect(t.manager.shown).not.toBeNull();
    t.model.beginStroke();
    t.model.paintTile(11, 14, TILE.GRASS);
    t.model.endStroke();
    expect(t.ends.at(-1)).toBe("partial");
    t.model.undo(); // undoing that placement: the ghost already ended
    expect(t.manager.shown).toBeNull();
  });

  it("undo of a cell under a shown ghost ends it drawn-over", () => {
    const t = setup();
    t.model.beginStroke();
    t.model.paintTile(10, 15, TILE.DIRT);
    t.model.endStroke();
    t.clock.advance(100);
    t.show(makeSuggestion({ adds: [{ x: 10, y: 14, tile: TILE.GRASS }, { x: 10, y: 15, tile: TILE.GRASS }], confidence: 0.99 }));
    t.model.undo();
    expect(t.ends).toEqual(["drawn-over"]);
  });

  it("a load resets the manager (shown ghost ends pending) and unbind removes listeners", () => {
    const t = setup();
    t.show();
    t.model.load(t.model.snapshot());
    expect(t.ends).toEqual(["pending"]);
    expect(t.calls.load).toBe(1);
    expect(t.target.count).toBe(1);
    t.unbind();
    expect(t.target.count).toBe(0);
    t.show();
    t.model.beginStroke();
    t.model.paintTile(40, 10, TILE.DIRT);
    t.model.endStroke();
    expect(t.manager.shown).not.toBeNull();
  });
});
