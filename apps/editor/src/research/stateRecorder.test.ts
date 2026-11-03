import { describe, expect, it } from "vitest";
import type { LevelSnapshot, LogEvent } from "../contracts";
import { unpackSnapshot } from "./rle";
import { validateEvent } from "./schema";
import { StateRecorder, type ChangeInfo, type StateSource } from "./stateRecorder";

function setup() {
  const events: LogEvent[] = [];
  let now = 0;
  let cells = [0, 0, 1, 0];
  let view = { x: 0, y: 0, w: 40, h: 20 };
  let zoom = 1;
  const change: ((c: ChangeInfo) => void)[] = [];
  const loaded: (() => void)[] = [];
  const tools: ((t: { mode: string; brush: string }) => void)[] = [];
  const ticks: { fn: () => void; ms: number }[] = [];
  const source: StateSource = {
    snapshot: (): LevelSnapshot => ({
      w: 2,
      h: 2,
      cells: [...cells],
      authors: cells.map((c) => (c ? 1 : 0)),
      provenance: {},
      entities: [],
      entityAuthors: {},
      start: { x: 0, y: 0 },
    }),
    onChange: (fn) => (change.push(fn), () => change.splice(change.indexOf(fn), 1)),
    onLoaded: (fn) => (loaded.push(fn), () => loaded.splice(loaded.indexOf(fn), 1)),
    onTool: (fn) => (tools.push(fn), () => tools.splice(tools.indexOf(fn), 1)),
    viewTiles: () => view,
    zoom: () => zoom,
    tool: () => ({ mode: "paint", brush: "grass" }),
  };
  const rec = new StateRecorder({
    log: (e) => events.push(e),
    clock: () => now,
    source,
    setInterval: (fn, ms) => (ticks.push({ fn, ms }), ticks.length),
    clearInterval: () => {},
  });
  const tick = (ms: number) => ticks.filter((t) => t.ms === ms).forEach((t) => t.fn());
  return {
    rec,
    events,
    setNow: (t: number) => (now = t),
    edit: (c: Partial<ChangeInfo> = {}) => {
      cells = [0, 0, 1, 2];
      const info: ChangeInfo = {
        source: "person",
        cells: [{ x: 1, y: 1, tile: 2, author: 1 }],
        entitiesAdded: [],
        entitiesRemoved: [],
        ...c,
      };
      change.forEach((f) => f(info));
    },
    load: () => loaded.forEach((f) => f()),
    setView: (v: typeof view, z = 1) => ((view = v), (zoom = z)),
    tool: (t: { mode: string; brush: string }) => tools.forEach((f) => f(t)),
    tick,
    listeners: () => change.length + loaded.length + tools.length,
  };
}

describe("StateRecorder", () => {
  it("writes the start snapshot, camera and tool first", () => {
    const s = setup();
    s.rec.start();
    expect(s.events.map((e) => e.type)).toEqual(["snapshot", "camera", "tool"]);
    expect(s.events[0]).toMatchObject({ reason: "start" });
    const snap = s.events[0] as Extract<LogEvent, { type: "snapshot" }>;
    expect(unpackSnapshot(snap.level).cells).toEqual([0, 0, 1, 0]);
  });

  it("checkpoints only when the level changed", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.tick(30_000);
    expect(s.events).toHaveLength(0);
    s.setNow(30_500);
    s.edit();
    s.setNow(31_000);
    s.tick(30_000);
    expect(s.events.map((e) => e.type)).toEqual(["delta", "snapshot"]);
    expect(s.events[1]).toMatchObject({ type: "snapshot", reason: "checkpoint", t: 31_000 });
    s.tick(30_000);
    expect(s.events).toHaveLength(2);
  });

  it("logs a delta for every kind of change except a load", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.setNow(5);
    s.edit({ source: "ghost", cells: [{ x: 0, y: 0, tile: 3, author: 2 }], start: { x: 1, y: 1 }, goal: null });
    s.edit({ source: "undo", entitiesRemoved: ["e1"] });
    s.edit({ source: "load" });
    expect(s.events).toEqual([
      { type: "delta", t: 5, source: "ghost", cells: [[0, 0, 3, 2]], start: { x: 1, y: 1 }, goal: null },
      { type: "delta", t: 5, source: "undo", cells: [[1, 1, 2, 1]], entitiesRemoved: ["e1"] },
    ]);
  });

  it("snapshots after a load and logs the camera again", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.setView({ x: 10, y: 0, w: 40, h: 20 });
    s.load();
    expect(s.events.map((e) => e.type)).toEqual(["snapshot", "camera"]);
    expect(s.events[0]).toMatchObject({ reason: "load" });
  });

  it("logs camera only when it moved", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.tick(250);
    expect(s.events).toHaveLength(0);
    s.setView({ x: 3.004, y: 0, w: 40, h: 20 });
    s.tick(250);
    expect(s.events).toEqual([{ type: "camera", t: 0, x: 3, y: 0, w: 40, h: 20, zoom: 1 }]);
    s.setView({ x: 3.004, y: 0, w: 40, h: 20 }, 1.5);
    s.tick(250);
    expect(s.events).toHaveLength(2);
  });

  it("logs tool changes", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.tool({ mode: "erase", brush: "grass" });
    expect(s.events).toEqual([{ type: "tool", t: 0, mode: "erase", brush: "grass" }]);
  });

  it("stop() writes a final checkpoint when dirty and detaches", () => {
    const s = setup();
    s.rec.start();
    s.edit();
    s.events.length = 0;
    s.rec.stop();
    expect(s.events.map((e) => e.type)).toEqual(["snapshot"]);
    expect(s.listeners()).toBe(0);
    s.events.length = 0;
    s.edit();
    expect(s.events).toHaveLength(0);
  });

  it("emits only schema-valid events", () => {
    const s = setup();
    s.rec.start();
    s.edit();
    s.rec.stop();
    for (const e of s.events) expect(validateEvent(e, { strict: true }), e.type).toMatchObject({ ok: true });
  });
});
