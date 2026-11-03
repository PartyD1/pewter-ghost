/**
 * Raw input recorder for session replay.
 *
 * Turns browser events into compact LogEvents:
 *   pointer moves  -> `pointer.path` batches (at most `hz` samples/s, only when the pointer moved)
 *   buttons        -> `pointer.btn`   (down / up, canvas pixels)
 *   enter / leave  -> `pointer.edge`
 *   wheel          -> `wheel`
 *   keys           -> `key`           (physical key `code`; never typed text; ignored inside text fields)
 *   focus / tab    -> `focus`         (window blur or tab hidden = not focused)
 *
 * Pointer positions are canvas pixels (CSS pixels scaled to the canvas's own
 * size), rounded to integers. The replay maps them to tiles with the nearest
 * `camera` event. Order is preserved: pending path samples are flushed before
 * any other input event is logged.
 *
 * No Phaser. The DOM pieces are injected (`InputRecorderEnv`) so tests run in Node.
 */
import type { LogEvent } from "../contracts";

/** The slice of an EventTarget the recorder uses. */
export interface ListenTarget {
  addEventListener(type: string, fn: (e: never) => void, opts?: boolean | { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, fn: (e: never) => void, opts?: boolean | { capture?: boolean }): void;
}

export interface CanvasLike extends ListenTarget {
  width: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

export interface InputRecorderOptions {
  log: (e: LogEvent) => void;
  clock: () => number;
  canvas: CanvasLike;
  /** window (pointer, key, blur / focus). */
  win: ListenTarget;
  /** document (visibilitychange), with its visibility state. */
  doc?: ListenTarget & { visibilityState?: string; hasFocus?: () => boolean };
  /** Max pointer samples per second (default 30). */
  hz?: number;
  /** Flush a path batch after this many samples (default 40) or this many ms (default 500). */
  maxBatch?: number;
  maxBatchMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

interface PointerLike {
  clientX: number;
  clientY: number;
  button?: number;
  buttons?: number;
}
interface WheelLike extends PointerLike {
  deltaX: number;
  deltaY: number;
  ctrlKey?: boolean;
}
interface KeyLike {
  code: string;
  repeat?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export class InputRecorder {
  private readonly o: InputRecorderOptions;
  private readonly minGapMs: number;
  private readonly maxBatch: number;
  private readonly maxBatchMs: number;
  private readonly offs: (() => void)[] = [];
  private pathT0 = 0;
  private dt: number[] = [];
  private xs: number[] = [];
  private ys: number[] = [];
  private lastSampleT = -Infinity;
  private lastX = NaN;
  private lastY = NaN;
  private timer: unknown = null;
  private focused = true;
  private started = false;

  constructor(o: InputRecorderOptions) {
    this.o = o;
    this.minGapMs = 1000 / Math.max(1, o.hz ?? 30);
    this.maxBatch = Math.max(1, o.maxBatch ?? 40);
    this.maxBatchMs = Math.max(50, o.maxBatchMs ?? 500);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { win, canvas, doc } = this.o;
    const on = <T extends ListenTarget>(t: T, type: string, fn: (e: never) => void, opts?: { capture?: boolean; passive?: boolean }) => {
      t.addEventListener(type, fn, opts);
      this.offs.push(() => t.removeEventListener(type, fn, opts));
    };
    // Capture phase on window: the editor stops propagation on some canvas events.
    on(win, "pointermove", ((e: PointerLike) => this.move(e)) as (e: never) => void, { capture: true });
    on(win, "pointerdown", ((e: PointerLike) => this.button(e, true)) as (e: never) => void, { capture: true });
    on(win, "pointerup", ((e: PointerLike) => this.button(e, false)) as (e: never) => void, { capture: true });
    on(canvas, "pointerenter", (() => this.edge(true)) as (e: never) => void);
    on(canvas, "pointerleave", (() => this.edge(false)) as (e: never) => void);
    on(win, "wheel", ((e: WheelLike) => this.wheel(e)) as (e: never) => void, { capture: true, passive: true });
    on(win, "keydown", ((e: KeyLike) => this.key(e, true)) as (e: never) => void, { capture: true });
    on(win, "keyup", ((e: KeyLike) => this.key(e, false)) as (e: never) => void, { capture: true });
    on(win, "blur", (() => this.setFocus(false)) as (e: never) => void);
    on(win, "focus", (() => this.setFocus(this.docVisible())) as (e: never) => void);
    if (doc) on(doc, "visibilitychange", (() => this.setFocus(this.docVisible())) as (e: never) => void);
    // Initial state, so a replay knows whether the first stretch was attended.
    this.focused = this.docVisible() && (doc?.hasFocus?.() ?? true);
    this.emit({ type: "focus", t: this.o.clock(), focused: this.focused });
  }

  /** Flush pending samples and stop listening. */
  stop(): void {
    if (!this.started) return;
    this.flushPath();
    for (const off of this.offs.splice(0)) off();
    this.started = false;
  }

  /** Write any pending pointer samples now. */
  flush(): void {
    this.flushPath();
  }

  // ----------------------------------------------------------------- handlers

  private move(e: PointerLike): void {
    const t = this.o.clock();
    if (t - this.lastSampleT < this.minGapMs) return;
    const { x, y } = this.toCanvas(e);
    if (x === this.lastX && y === this.lastY) return;
    this.lastSampleT = t;
    this.lastX = x;
    this.lastY = y;
    if (this.xs.length === 0) {
      this.pathT0 = Math.round(t);
      this.armTimer();
    }
    this.dt.push(Math.round(t - this.pathT0));
    this.xs.push(x);
    this.ys.push(y);
    if (this.xs.length >= this.maxBatch) this.flushPath();
  }

  private button(e: PointerLike, down: boolean): void {
    const { x, y } = this.toCanvas(e);
    this.emit({ type: "pointer.btn", t: this.o.clock(), x, y, down, button: e.button ?? 0 });
  }

  private edge(inside: boolean): void {
    this.emit({ type: "pointer.edge", t: this.o.clock(), inside });
  }

  private wheel(e: WheelLike): void {
    const { x, y } = this.toCanvas(e);
    this.emit({
      type: "wheel",
      t: this.o.clock(),
      x,
      y,
      dx: Math.round(e.deltaX),
      dy: Math.round(e.deltaY),
      ctrl: !!e.ctrlKey,
    });
  }

  private key(e: KeyLike, down: boolean): void {
    if (e.repeat) return;
    const tg = e.target;
    if (tg && ((tg.tagName && TEXT_TAGS.has(tg.tagName.toUpperCase())) || tg.isContentEditable)) return;
    this.emit({ type: "key", t: this.o.clock(), code: String(e.code).slice(0, 32), down });
  }

  private setFocus(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.emit({ type: "focus", t: this.o.clock(), focused });
  }

  // ----------------------------------------------------------------- internals

  private docVisible(): boolean {
    const v = this.o.doc?.visibilityState;
    return v === undefined || v === "visible";
  }

  private toCanvas(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.o.canvas.getBoundingClientRect();
    // The canvas scales uniformly, so one factor serves both axes.
    const s = r.width > 0 ? this.o.canvas.width / r.width : 1;
    return { x: Math.round((e.clientX - r.left) * s), y: Math.round((e.clientY - r.top) * s) };
  }

  /** Any non-path event: pending samples go first so order is kept. */
  private emit(e: LogEvent): void {
    this.flushPath();
    this.o.log(e);
  }

  private armTimer(): void {
    if (this.timer !== null) return;
    const set = this.o.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      this.flushPath();
    }, this.maxBatchMs);
  }

  private flushPath(): void {
    if (this.timer !== null) {
      const clear = this.o.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
      clear(this.timer);
      this.timer = null;
    }
    if (this.xs.length === 0) return;
    const ev: LogEvent = { type: "pointer.path", t: this.pathT0, dt: this.dt, x: this.xs, y: this.ys };
    this.dt = [];
    this.xs = [];
    this.ys = [];
    this.o.log(ev);
  }
}
