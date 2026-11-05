/**
 * Editor-state recorder for session replay: the whole level as RLE snapshots,
 * the camera, and the active tool.
 *
 *   snapshot   at start, after every load (file, share code, autosave, new),
 *              and a checkpoint every `checkpointMs` (30 s) while the level has
 *              changed. A replay seeks by loading the nearest snapshot and
 *              applying place / erase events after it; a checkpoint also
 *              repairs anything the place events do not describe (marker moves).
 *   camera     whenever the visible tile rect or zoom changed, polled at `cameraMs`.
 *   tool       whenever the editor mode or brush changes.
 *
 * No Phaser: everything comes in through `StateSource`.
 */
import type { Entity, LevelSnapshot, LogEvent, Point } from "../contracts";
import { packSnapshot } from "./rle";

/** What the model reports after a change (a subset of LevelChangeEx). */
export interface ChangeInfo {
  source: "person" | "ghost" | "undo" | "redo" | "load";
  cells: { x: number; y: number; tile: number; author: number }[];
  entitiesAdded: Entity[];
  entitiesRemoved: string[];
  start?: Point;
  goal?: Point | null;
}

export interface StateSource {
  snapshot(): LevelSnapshot;
  /** Called after every level change (do, undo, redo, load); returns unsubscribe. */
  onChange(fn: (c: ChangeInfo) => void): () => void;
  /** Called when a whole level was loaded; returns unsubscribe. */
  onLoaded(fn: () => void): () => void;
  /** Called when mode / brush changes; returns unsubscribe. */
  onTool(fn: (t: { mode: string; brush: string }) => void): () => void;
  viewTiles(): { x: number; y: number; w: number; h: number };
  zoom(): number;
  tool(): { mode: string; brush: string };
}

export interface StateRecorderOptions {
  log: (e: LogEvent) => void;
  clock: () => number;
  source: StateSource;
  checkpointMs?: number;
  cameraMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

export class StateRecorder {
  private readonly o: StateRecorderOptions;
  private readonly offs: (() => void)[] = [];
  private timers: unknown[] = [];
  private dirty = false;
  private lastCam: { x: number; y: number; w: number; h: number; zoom: number } | null = null;
  private started = false;

  constructor(o: StateRecorderOptions) {
    this.o = o;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { source } = this.o;
    this.snap("start");
    this.camera();
    const tool = source.tool();
    this.o.log({ type: "tool", t: this.o.clock(), ...tool });
    this.offs.push(
      source.onChange((c) => this.change(c)),
      source.onLoaded(() => {
        this.snap("load");
        this.camera();
      }),
      source.onTool((t) => this.o.log({ type: "tool", t: this.o.clock(), mode: t.mode, brush: t.brush })),
    );
    const set = this.o.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.timers.push(
      set(() => this.camera(), this.o.cameraMs ?? 250),
      set(() => {
        if (this.dirty) this.snap("checkpoint");
      }, this.o.checkpointMs ?? 30_000),
    );
  }

  stop(): void {
    if (!this.started) return;
    const clear = this.o.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
    for (const t of this.timers.splice(0)) clear(t);
    for (const off of this.offs.splice(0)) off();
    // Last word on the level, so the end of the replay is exact.
    if (this.dirty) this.snap("checkpoint");
    this.started = false;
  }

  private change(c: ChangeInfo): void {
    this.dirty = true;
    // A load is covered by its own snapshot (onLoaded).
    if (c.source === "load") return;
    const d: Extract<LogEvent, { type: "delta" }> = {
      type: "delta",
      t: this.o.clock(),
      source: c.source,
      cells: c.cells.map((k) => [k.x, k.y, k.tile, k.author]),
    };
    if (c.entitiesAdded.length) d.entitiesAdded = c.entitiesAdded.map((e) => ({ ...e }));
    if (c.entitiesRemoved.length) d.entitiesRemoved = [...c.entitiesRemoved];
    if (c.start) d.start = { ...c.start };
    if (c.goal !== undefined) d.goal = c.goal ? { ...c.goal } : null;
    this.o.log(d);
  }

  private snap(reason: "start" | "load" | "checkpoint"): void {
    this.dirty = false;
    this.o.log({ type: "snapshot", t: this.o.clock(), reason, level: packSnapshot(this.o.source.snapshot()) });
  }

  private camera(): void {
    const v = this.o.source.viewTiles();
    const zoom = this.o.source.zoom();
    const c = { x: round(v.x), y: round(v.y), w: round(v.w), h: round(v.h), zoom: Math.round(zoom * 1000) / 1000 };
    const p = this.lastCam;
    if (p && near(p.x, c.x, 0.05) && near(p.y, c.y, 0.05) && near(p.w, c.w, 0.05) && near(p.h, c.h, 0.05) && near(p.zoom, c.zoom, 0.0005)) return;
    this.lastCam = c;
    this.o.log({ type: "camera", t: this.o.clock(), ...c });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
