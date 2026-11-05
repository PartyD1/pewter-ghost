import { describe, expect, it } from "vitest";
import { ConsoleTrace } from "./consoleTrace";

function setup(enabled = true) {
  const lines: string[] = [];
  const tr = new ConsoleTrace({ print: (l) => lines.push(l), enabled });
  return { tr, lines };
}

describe("ConsoleTrace", () => {
  it("prints keys, buttons, wheel and focus with a running clock", () => {
    const { tr, lines } = setup();
    tr.tap({ type: "key", t: 1000, code: "KeyZ", down: true });
    tr.tap({ type: "key", t: 1100, code: "KeyZ", down: false });
    tr.tap({ type: "pointer.btn", t: 2500, x: 640, y: 400, down: true, button: 0 });
    tr.tap({ type: "wheel", t: 3000, x: 0, y: 0, dx: 0, dy: -120, ctrl: true });
    tr.tap({ type: "focus", t: 4000, focused: false });
    expect(lines).toEqual([
      "[pewter +0.00s] key KeyZ down",
      "[pewter +0.10s] key KeyZ up",
      "[pewter +1.50s] mouse left down at px (640, 400)",
      "[pewter +2.00s] wheel up (-120) with ctrl",
      "[pewter +3.00s] window unfocused or tab hidden (away)",
    ]);
  });

  it("adds the tile under a click once it has seen a camera", () => {
    const { tr, lines } = setup();
    tr.tap({ type: "camera", t: 0, x: 8, y: 0, w: 35, h: 20, zoom: 2 }); // 32 px per tile
    tr.tap({ type: "pointer.btn", t: 10, x: 64, y: 96, down: true, button: 2 });
    expect(lines[0]).toBe("[pewter +0.01s] mouse right down at px (64, 96) tile (10, 3)");
  });

  it("prints a hover only when the tile changes", () => {
    const { tr, lines } = setup();
    tr.hover({ x: 3, y: 4 }, 1000);
    tr.hover({ x: 3, y: 4 }, 1100);
    tr.hover({ x: 4, y: 4 }, 1200);
    tr.hover(undefined, 1300);
    tr.hover(undefined, 1400);
    expect(lines).toEqual([
      "[pewter +0.00s] hover tile (3, 4)",
      "[pewter +0.20s] hover tile (4, 4)",
      "[pewter +0.30s] hover off the level",
    ]);
  });

  it("says nothing while off, and announces itself when switched on", () => {
    const { tr, lines } = setup(false);
    tr.tap({ type: "key", t: 1, code: "KeyA", down: true });
    tr.hover({ x: 1, y: 1 }, 5);
    expect(lines).toEqual([]);
    tr.set(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("trace on");
    tr.tap({ type: "key", t: 2, code: "KeyB", down: true });
    expect(lines).toHaveLength(2);
    tr.set(false);
    tr.tap({ type: "key", t: 3, code: "KeyC", down: true });
    expect(lines).toHaveLength(2);
  });

  it("remembers the camera even while off, so tiles are right when switched on later", () => {
    const { tr, lines } = setup(false);
    tr.tap({ type: "camera", t: 0, x: 0, y: 0, w: 35, h: 20, zoom: 2 });
    tr.set(true);
    tr.tap({ type: "pointer.btn", t: 1, x: 33, y: 0, down: true, button: 0 });
    expect(lines[1]).toContain("tile (1, 0)");
  });

  it("describes edits, undo and ghosts, and ignores bulky events", () => {
    const { tr, lines } = setup();
    tr.tap({ type: "delta", t: 0, source: "ghost", cells: [[1, 1, 6, 2], [2, 1, 6, 2]], entitiesAdded: [{ id: "e", kind: "coin", x: 1, y: 0 }] });
    tr.tap({ type: "undo", t: 1, what: "ghost" });
    tr.tap({ type: "ghost.show", t: 2, suggestionId: "g", kind: "extend", confidence: 0.8, shownBecause: "now", cells: 4, label: "ledge" });
    tr.tap({ type: "ghost.end", t: 3000, suggestionId: "g", outcome: "accepted", dwellMs: 1500 });
    tr.tap({ type: "pointer.path", t: 4, dt: [0], x: [1], y: [1] });
    tr.tap({ type: "snapshot", t: 5, reason: "checkpoint", level: { w: 1, h: 1, cells: [0, 1], authors: [0, 1], provenance: {}, entities: [], entityAuthors: {}, start: { x: 0, y: 0 }, packed: true } });
    expect(lines).toEqual([
      "[pewter +0.00s] edit by ghost: 2 cells, +1 entities",
      "[pewter +0.00s] undo (ghost)",
      "[pewter +0.00s] ghost shown: extend \"ledge\" (4 cells, confidence 0.80)",
      "[pewter +3.00s] ghost ended: accepted after 1.5 s",
    ]);
  });
});
