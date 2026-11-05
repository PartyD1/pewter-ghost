import { describe, expect, it } from "vitest";
import { TILE_PX, type Entity, type LevelSnapshot, type LogEvent } from "../../contracts";
import { packSnapshot } from "../rle";
import { scriptedSession } from "../__fixtures__/scriptedSession";
import { Replay } from "./replay";
import { navPoints, stepPoint } from "./tracks";

const W = 6;
const H = 3;
const empty = (): LevelSnapshot => ({
  w: W,
  h: H,
  cells: new Array(W * H).fill(0),
  authors: new Array(W * H).fill(0),
  provenance: {},
  entities: [],
  entityAuthors: {},
  start: { x: 0, y: 0 },
});
const idx = (x: number, y: number) => y * W + x;

/** A small hand-made session: paint, ghost, accept, undo, a checkpoint, play. */
function session(): LogEvent[] {
  const coin: Entity = { id: "e1", kind: "coin", x: 4, y: 1 };
  const withTile = empty();
  withTile.cells[idx(0, 2)] = 1;
  withTile.authors[idx(0, 2)] = 1;
  return [
    { type: "session", t: 0, sessionId: "p07", commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "llm", config: {}, replay: 1 },
    { type: "snapshot", t: 0, reason: "start", level: packSnapshot(empty()) },
    { type: "camera", t: 0, x: 0, y: 0, w: 10, h: 5, zoom: 2 },
    { type: "focus", t: 0, focused: true },
    { type: "pointer.edge", t: 100, inside: true },
    { type: "pointer.path", t: 1000, dt: [0, 100, 200], x: [10, 30, 50], y: [10, 10, 10] },
    { type: "pointer.btn", t: 1050, x: 30, y: 10, down: true, button: 0 },
    { type: "place", t: 1100, x: 1, y: 2, tile: 1, author: 1, stroke: "s1", tool: "paint" },
    { type: "delta", t: 1100, source: "person", cells: [[1, 2, 1, 1]] },
    { type: "place", t: 1200, x: 2, y: 2, tile: 1, author: 1, stroke: "s1", tool: "paint" },
    { type: "delta", t: 1200, source: "person", cells: [[2, 2, 1, 1]] },
    { type: "pointer.btn", t: 1250, x: 50, y: 10, down: false, button: 0 },
    { type: "key", t: 1300, code: "KeyZ", down: true },
    { type: "delta", t: 1310, source: "undo", cells: [[2, 2, 0, 0]] },
    { type: "undo", t: 1310, what: "own" },
    { type: "key", t: 1320, code: "KeyZ", down: false },
    { type: "fill.call", t: 1900, requestHash: "a", mode: "auto", superseded: false, latencyMs: 500, act: true, kind: "extend", confidence: 0.8, tiles: 2 },
    { type: "ghost.show", t: 2000, suggestionId: "g1", kind: "extend", confidence: 0.8, shownBecause: "now", cells: 2, label: "ledge", adds: [[3, 2, 1], [4, 2, 1]] },
    { type: "pointer.path", t: 2300, dt: [0, 100], x: [50, 400], y: [10, 200] },
    { type: "focus", t: 2400, focused: false },
    { type: "focus", t: 2800, focused: true },
    { type: "delta", t: 3000, source: "ghost", cells: [[3, 2, 1, 2], [4, 2, 1, 2]], entitiesAdded: [coin] },
    { type: "ghost.end", t: 3000, suggestionId: "g1", outcome: "accepted", dwellMs: 1000, acceptedCells: 2 },
    { type: "delta", t: 3500, source: "undo", cells: [[3, 2, 0, 0], [4, 2, 0, 0]], entitiesRemoved: ["e1"] },
    { type: "undo", t: 3500, what: "ghost" },
    { type: "snapshot", t: 4000, reason: "checkpoint", level: packSnapshot(withTile) },
    { type: "play.start", t: 5000 },
    { type: "play.end", t: 7000, reachedGoal: true, deaths: 1 },
  ];
}

describe("Replay level reconstruction", () => {
  const r = new Replay(session());

  it("starts from the snapshot", () => {
    expect(r.stateAt(0).level!.cells.every((c) => c === 0)).toBe(true);
  });

  it("applies person strokes in order", () => {
    const l = r.stateAt(1150).level!;
    expect(l.cells[idx(1, 2)]).toBe(1);
    expect(l.cells[idx(2, 2)]).toBe(0);
    expect(l.authors[idx(1, 2)]).toBe(1);
    expect(r.stateAt(1250).level!.cells[idx(2, 2)]).toBe(1);
  });

  it("applies undo", () => {
    expect(r.stateAt(1400).level!.cells[idx(2, 2)]).toBe(0);
    expect(r.stateAt(1400).level!.cells[idx(1, 2)]).toBe(1);
  });

  it("applies a ghost accept, with entities, and its undo", () => {
    const accepted = r.stateAt(3100).level!;
    expect(accepted.cells[idx(3, 2)]).toBe(1);
    expect(accepted.authors[idx(3, 2)]).toBe(2);
    expect(accepted.entities.map((e) => e.id)).toEqual(["e1"]);
    const undone = r.stateAt(3600).level!;
    expect(undone.cells[idx(3, 2)]).toBe(0);
    expect(undone.entities).toEqual([]);
  });

  it("jumps to a checkpoint when seeking past it, and gets the same level going backwards", () => {
    const after = r.stateAt(4500).level!;
    expect(after.cells[idx(0, 2)]).toBe(1);
    expect(after.cells[idx(1, 2)]).toBe(0); // the checkpoint is the truth
    const back = r.stateAt(1250).level!;
    expect(back.cells[idx(2, 2)]).toBe(1);
    expect(back.cells[idx(0, 2)]).toBe(0);
  });

  it("gives the same level for sequential playback and for a direct seek", () => {
    const seq = new Replay(session());
    for (let t = 0; t <= 3600; t += 50) seq.stateAt(t);
    const direct = new Replay(session());
    expect(seq.stateAt(3600).level).toEqual(direct.stateAt(3600).level);
  });

  it("has no level without a snapshot", () => {
    const noSnap = new Replay(session().filter((e) => e.type !== "snapshot"));
    expect(noSnap.hasLevel).toBe(false);
    expect(noSnap.stateAt(1000).level).toBeNull();
  });
});

describe("Replay ghost, pointer and state", () => {
  const r = new Replay(session());

  it("shows the ghost from show to end", () => {
    expect(r.stateAt(1999).ghost).toBeNull();
    const g = r.stateAt(2500).ghost!;
    expect(g).toMatchObject({ id: "g1", kind: "extend", label: "ledge", outcome: "accepted" });
    expect(g.adds).toEqual([[3, 2, 1], [4, 2, 1]]);
    expect(r.stateAt(3000).ghost).toBeNull();
  });

  it("finds the pointer, its trail and the tile under it", () => {
    const f = r.stateAt(1150);
    expect(f.pointer).toMatchObject({ x: 30, y: 10, down: true, inside: true });
    expect(f.trail.map((p) => p.x)).toEqual([10, 30]);
    // camera x=0,y=0,zoom=2: tile = floor(px / (TILE_PX*2))
    expect(f.pointer!.tile).toEqual({ x: Math.floor(30 / (TILE_PX * 2)), y: 0 });
    expect(r.stateAt(1300).pointer!.down).toBe(false);
  });

  it("has no pointer before the first sample", () => {
    expect(r.stateAt(500).pointer).toBeNull();
  });

  it("tracks keys, focus, play, camera and tool", () => {
    expect(r.stateAt(1310).keys).toEqual(["KeyZ"]);
    expect(r.stateAt(1330).keys).toEqual([]);
    expect(r.stateAt(2500).focused).toBe(false);
    expect(r.stateAt(2900).focused).toBe(true);
    expect(r.stateAt(5500).playing).toBe(true);
    expect(r.stateAt(7000).playing).toBe(false);
    expect(r.stateAt(10).camera).toMatchObject({ zoom: 2, w: 10 });
    expect(r.stateAt(10).tool).toBeNull();
  });

  it("clamps t into the session", () => {
    expect(r.stateAt(-5).t).toBe(0);
    expect(r.stateAt(1e9).t).toBe(r.duration);
  });

  it("maps pixels and tiles both ways", () => {
    const cam = { x: 3, y: 1, w: 10, h: 5, zoom: 2 };
    const s = TILE_PX * 2;
    expect(Replay.pixelToTile(cam, 0, 0)).toEqual({ x: 3, y: 1 });
    expect(Replay.pixelToTile(cam, 2.5 * s, 1.5 * s)).toEqual({ x: 5, y: 2 });
    expect(Replay.tileToPixel(cam, 5, 2)).toEqual({ x: 2 * s, y: 1 * s });
  });
});

describe("Replay response timing", () => {
  const r = new Replay(session());

  it("measures how long the person took to react to a ghost", () => {
    const [g] = r.ghostSummaries();
    expect(g.id).toBe("g1");
    // ghost shown at 2000; pointer at (50,10) until the sample at 2400 moves to (400,200)
    expect(g.firstMoveMs).toBe(400);
    expect(g.decisionMs).toBe(1000);
    expect(g.awayMs).toBe(400);
  });

  it("returns null when the pointer never moved", () => {
    const ev = session().filter((e) => !(e.type === "pointer.path" && e.t === 2300));
    expect(new Replay(ev).ghostSummaries()[0].firstMoveMs).toBeNull();
  });

  it("counts away time inside any window", () => {
    expect(r.awayMs(0, 10_000)).toBe(400);
    expect(r.awayMs(2500, 2600)).toBe(100);
    expect(r.awayMs(0, 2000)).toBe(0);
  });
});

describe("Replay tracks", () => {
  const t = new Replay(session()).tracks();
  const on = (track: string) => t.segments.filter((s) => s.track === track);

  it("lists ghosts by outcome", () => {
    expect(on("suggestions")).toMatchObject([{ start: 2000, end: 3000, kind: "accepted" }]);
  });

  it("derives the API track from fill.call", () => {
    expect(on("api")).toMatchObject([{ start: 1400, end: 1900, kind: "suggested" }]);
  });

  it("groups placements into strokes and marks undo / ghost accept", () => {
    expect(on("edits")).toMatchObject([{ start: 1100, end: 1200, label: "paint ×2" }]);
    expect(t.markers.filter((m) => m.track === "edits").map((m) => m.kind)).toEqual(["undo", "ghost-accept", "undo"]);
  });

  it("merges input into bursts split by idle gaps", () => {
    // 1320 -> 2300 is under the 1.5 s idle gap, so it is one burst.
    expect(on("input").map((s) => [s.start, s.end])).toEqual([[1000, 2400]]);
    const gap = new Replay([
      { type: "key", t: 1000, code: "A", down: true },
      { type: "key", t: 1100, code: "A", down: false },
      { type: "key", t: 5000, code: "B", down: true },
    ]).tracks();
    // (replay time starts at the first event, here the key at 1000 ms)
    expect(gap.segments.filter((s) => s.track === "input").map((s) => [s.start, s.end])).toEqual([
      [0, 100],
      [4000, 4000],
    ]);
  });

  it("covers play and away", () => {
    expect(on("play")).toMatchObject([{ start: 5000, end: 7000, kind: "goal" }]);
    expect(on("away")).toMatchObject([{ start: 2400, end: 2800 }]);
  });

  it("steps between points", () => {
    const pts = navPoints(t, ["suggestions"]);
    expect(pts).toEqual([2000]);
    const all = navPoints(t);
    expect(stepPoint(all, 0, 1)).toBe(1000);
    expect(stepPoint(all, 2000, 1)).toBe(2400);
    expect(stepPoint(all, 1000, -1)).toBeNull();
    expect(stepPoint(all, 1e9, 1)).toBeNull();
  });
});

describe("Replay loading", () => {
  it("parses JSONL, skipping bad lines", () => {
    const text = scriptedSession().map((e) => JSON.stringify(e)).join("\n") + '\nnot json\n{"type":"place"}\n';
    const r = Replay.fromJsonl(text);
    expect(r.skipped.map((s) => s.error)).toEqual(["not JSON", expect.stringContaining("place")]);
    expect(r.sessionId).toBe("p01");
    expect(r.hasLevel).toBe(true);
    expect(r.duration).toBe(21000);
  });

  it("orders events by time, keeping log order for ties", () => {
    const r = new Replay([
      { type: "key", t: 5, code: "B", down: true },
      { type: "key", t: 1, code: "A", down: true },
      { type: "key", t: 5, code: "C", down: true },
    ]);
    expect(r.events.map((e) => (e as { code: string }).code)).toEqual(["A", "B", "C"]);
  });

  it("starts replay time at the first event and keeps the log's own clock available", () => {
    // The editor's clock counts from page load, so a real log starts well after 0.
    const r = new Replay([
      { type: "session", t: 40_000, sessionId: "s", commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "none", config: {} },
      { type: "snapshot", t: 40_500, reason: "start", level: packSnapshot(empty()) },
      { type: "key", t: 41_000, code: "A", down: true },
    ]);
    expect(r.originMs).toBe(40_000);
    expect(r.duration).toBe(1000);
    expect(r.events.map((e) => e.t)).toEqual([0, 500, 1000]);
  });

  it("shows the starting level before the first snapshot is logged", () => {
    const r = new Replay([
      { type: "session", t: 0, sessionId: "s", commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "none", config: {} },
      { type: "snapshot", t: 500, reason: "start", level: packSnapshot(empty()) },
      { type: "delta", t: 800, source: "person", cells: [[1, 1, 1, 1]] },
    ]);
    expect(r.stateAt(0).level).not.toBeNull();
    expect(r.stateAt(0).level!.cells[idx(1, 1)]).toBe(0);
    expect(r.stateAt(100).level!.cells[idx(1, 1)]).toBe(0);
    expect(r.stateAt(800).level!.cells[idx(1, 1)]).toBe(1);
    expect(r.stateAt(0).level!.cells[idx(1, 1)]).toBe(0); // and back again
  });

  it("copes with an empty log", () => {
    const r = new Replay([]);
    expect(r.duration).toBe(0);
    expect(r.stateAt(0)).toMatchObject({ level: null, ghost: null, pointer: null });
  });
});
