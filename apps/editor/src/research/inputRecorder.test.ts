import { describe, expect, it } from "vitest";
import type { LogEvent } from "../contracts";
import { InputRecorder, type CanvasLike, type ListenTarget } from "./inputRecorder";
import { validateEvent } from "./schema";

class FakeTarget implements ListenTarget {
  handlers = new Map<string, ((e: never) => void)[]>();
  addEventListener(type: string, fn: (e: never) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: never) => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((f) => f !== fn));
  }
  fire(type: string, e: object = {}): void {
    for (const f of this.handlers.get(type) ?? []) f(e as never);
  }
  count(): number {
    let n = 0;
    for (const v of this.handlers.values()) n += v.length;
    return n;
  }
}

function setup(opts: { hz?: number; visible?: string } = {}) {
  const events: LogEvent[] = [];
  let now = 0;
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let nextId = 1;
  const win = new FakeTarget();
  const doc = Object.assign(new FakeTarget(), { visibilityState: opts.visible ?? "visible" });
  const canvas = Object.assign(new FakeTarget(), {
    width: 1280,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 640, height: 360 }),
  }) as unknown as CanvasLike & FakeTarget;
  const rec = new InputRecorder({
    log: (e) => events.push(e),
    clock: () => now,
    canvas,
    win,
    doc,
    hz: opts.hz,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { rec, win, doc, canvas, events, advance, setNow: (t: number) => (now = t), timers };
}

describe("InputRecorder", () => {
  it("logs the initial focus state", () => {
    const s = setup();
    s.rec.start();
    expect(s.events).toEqual([{ type: "focus", t: 0, focused: true }]);
  });

  it("scales pointer positions to canvas pixels", () => {
    const s = setup();
    s.rec.start();
    s.win.fire("pointerdown", { clientX: 420, clientY: 250, button: 0 });
    // (420-100)*2 = 640, (250-50)*2 = 400
    expect(s.events.at(-1)).toMatchObject({ type: "pointer.btn", x: 640, y: 400, down: true, button: 0 });
  });

  it("batches pointer moves, throttles to hz and skips repeats", () => {
    const s = setup({ hz: 10 }); // 100 ms gap
    s.rec.start();
    s.events.length = 0;
    const move = (t: number, x: number) => {
      s.setNow(t);
      s.win.fire("pointermove", { clientX: x, clientY: 50 });
    };
    move(0, 100);
    move(50, 110); // too soon
    move(100, 120);
    move(200, 120); // same place
    move(300, 140);
    s.rec.flush();
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toEqual({ type: "pointer.path", t: 0, dt: [0, 100, 300], x: [0, 40, 80], y: [0, 0, 0] });
  });

  it("flushes a path before the next event, keeping order", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.setNow(10);
    s.win.fire("pointermove", { clientX: 100, clientY: 50 });
    s.setNow(20);
    s.win.fire("pointerdown", { clientX: 100, clientY: 50 });
    expect(s.events.map((e) => e.type)).toEqual(["pointer.path", "pointer.btn"]);
  });

  it("flushes by timer when the pointer goes quiet", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.setNow(10);
    s.win.fire("pointermove", { clientX: 100, clientY: 50 });
    expect(s.events).toHaveLength(0);
    s.advance(600);
    expect(s.events.map((e) => e.type)).toEqual(["pointer.path"]);
  });

  it("flushes when a batch is full", () => {
    const s = setup({ hz: 1000 });
    s.rec.start();
    s.events.length = 0;
    for (let i = 0; i < 40; i++) {
      s.setNow(i * 2);
      s.win.fire("pointermove", { clientX: 100 + i, clientY: 50 });
    }
    expect(s.events).toHaveLength(1);
    expect((s.events[0] as { x: number[] }).x).toHaveLength(40);
  });

  it("records keys by code, skips repeats and text fields", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.win.fire("keydown", { code: "KeyZ" });
    s.win.fire("keydown", { code: "KeyZ", repeat: true });
    s.win.fire("keydown", { code: "KeyA", target: { tagName: "INPUT" } });
    s.win.fire("keyup", { code: "KeyZ" });
    expect(s.events).toEqual([
      { type: "key", t: 0, code: "KeyZ", down: true },
      { type: "key", t: 0, code: "KeyZ", down: false },
    ]);
  });

  it("records wheel and canvas enter / leave", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.win.fire("wheel", { clientX: 100, clientY: 50, deltaX: 0.4, deltaY: -120.6, ctrlKey: true });
    s.canvas.fire("pointerleave");
    s.canvas.fire("pointerenter");
    expect(s.events).toEqual([
      { type: "wheel", t: 0, x: 0, y: 0, dx: 0, dy: -121, ctrl: true },
      { type: "pointer.edge", t: 0, inside: false },
      { type: "pointer.edge", t: 0, inside: true },
    ]);
  });

  it("logs focus changes once, from blur and tab visibility", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.win.fire("blur");
    s.win.fire("blur"); // duplicate
    s.doc.visibilityState = "hidden";
    s.doc.fire("visibilitychange");
    s.win.fire("focus"); // still hidden: stays unfocused
    s.doc.visibilityState = "visible";
    s.doc.fire("visibilitychange");
    expect(s.events.map((e) => (e as { focused: boolean }).focused)).toEqual([false, true]);
  });

  it("starts unfocused when the tab is hidden", () => {
    const s = setup({ visible: "hidden" });
    s.rec.start();
    expect(s.events[0]).toMatchObject({ type: "focus", focused: false });
  });

  it("stop() flushes, detaches every listener and is idempotent", () => {
    const s = setup();
    s.rec.start();
    s.events.length = 0;
    s.setNow(5);
    s.win.fire("pointermove", { clientX: 100, clientY: 50 });
    s.rec.stop();
    expect(s.events.map((e) => e.type)).toEqual(["pointer.path"]);
    expect(s.win.count() + s.canvas.count() + s.doc.count()).toBe(0);
    s.rec.stop();
    s.win.fire("keydown", { code: "KeyA" });
    expect(s.events).toHaveLength(1);
  });

  it("emits only schema-valid events", () => {
    const s = setup();
    s.rec.start();
    s.setNow(3);
    s.win.fire("pointermove", { clientX: 130, clientY: 80 });
    s.win.fire("pointerdown", { clientX: 130, clientY: 80, button: 0 });
    s.win.fire("wheel", { clientX: 130, clientY: 80, deltaX: 0, deltaY: 10 });
    s.win.fire("keydown", { code: "Space" });
    s.rec.stop();
    for (const e of s.events) expect(validateEvent(e, { strict: true }), e.type).toMatchObject({ ok: true });
  });
});
