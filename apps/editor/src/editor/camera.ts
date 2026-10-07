/**
 * Editor camera: pan, zoom (anchored at the pointer), trackpad gestures, and
 * nudgeTo(), a gentle tween that brings a tile into view. A nudge never moves
 * the camera while a stroke is active: it waits for the stroke to end (the
 * latest request wins). Manual panning or zooming cancels a nudge.
 */
import Phaser from "phaser";
import type { Point } from "../contracts";
import type { CameraApi } from "./api";
import {
  clampCenter,
  easeOutCubic,
  fitZoom,
  nudgeTarget,
  screenToWorld,
  wheelIntent,
  zoomAround,
  zoomLimits,
  type Size,
  type Vec,
  type WheelLike,
} from "./cameraMath";
import { TILE_PX } from "./constants";

interface Tween {
  from: Vec;
  to: Vec;
  t: number;
  duration: number;
}

interface PendingNudge {
  x: number;
  y: number;
  w: number;
  h: number;
  durationMs: number;
}

const reducedMotion = (): boolean => {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

export class CameraController implements CameraApi {
  private center: Vec;
  private _zoom = 2;
  private tween: Tween | null = null;
  private pending: PendingNudge | null = null;
  private following = false;
  /** Edit-mode view to restore after Play. */
  private savedView: { center: Vec; zoom: number } | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly levelPx: Size,
    private readonly isStrokeActive: () => boolean,
  ) {
    this.center = { x: 0, y: levelPx.h / 2 };
  }

  private get cam(): Phaser.Cameras.Scene2D.Camera {
    return this.scene.cameras.main;
  }

  private get viewport(): Size {
    return { w: this.cam.width, h: this.cam.height };
  }

  get zoom(): number {
    return this._zoom;
  }

  get centerPx(): Vec {
    return { ...this.center };
  }

  get isNudging(): boolean {
    return this.tween !== null;
  }

  get hasPendingNudge(): boolean {
    return this.pending !== null;
  }

  /** Fit the level height and look at tile (x, y) near the left third of the screen. */
  home(focus: Point): void {
    this._zoom = Phaser.Math.Clamp(fitZoom(this.viewport, this.levelPx) * 1.6, 1, 4);
    const vw = this.viewport.w / this._zoom;
    this.center = { x: focus.x * TILE_PX + vw * 0.3, y: this.levelPx.h / 2 };
    this.apply();
  }

  /** Re-clamp after the canvas was resized. */
  onResize(): void {
    const lim = zoomLimits(this.viewport, this.levelPx);
    this._zoom = Phaser.Math.Clamp(this._zoom, lim.min, lim.max);
    this.apply();
  }

  panByScreen(dx: number, dy: number): void {
    if (this.following) return;
    this.tween = null;
    this.pending = null;
    this.center = { x: this.center.x + dx / this._zoom, y: this.center.y + dy / this._zoom };
    this.apply();
  }

  /** Multiply the zoom, keeping the world point under `anchor` (canvas px) still. */
  zoomBy(factor: number, anchor?: Vec): void {
    if (this.following) return;
    const lim = zoomLimits(this.viewport, this.levelPx);
    const next = Phaser.Math.Clamp(this._zoom * factor, lim.min, lim.max);
    if (next === this._zoom) return;
    this.tween = null;
    const a = anchor ?? { x: this.viewport.w / 2, y: this.viewport.h / 2 };
    const world = screenToWorld(a, this.center, this._zoom, this.viewport);
    this.center = zoomAround(this.center, this._zoom, next, world);
    this._zoom = next;
    this.apply();
  }

  zoomReset(): void {
    this.zoomBy(Phaser.Math.Clamp(fitZoom(this.viewport, this.levelPx) * 1.6, 1, 4) / this._zoom);
  }

  /** Native wheel event (trackpad two-finger pan, pinch zoom, mouse wheel). */
  onWheel(e: WheelLike & { offsetX?: number; offsetY?: number }): void {
    const fits = this.levelPx.h * this._zoom <= this.viewport.h;
    const intent = wheelIntent(e, fits);
    if (intent.kind === "zoom") this.zoomBy(intent.factor, e.offsetX !== undefined ? { x: e.offsetX, y: e.offsetY ?? 0 } : undefined);
    else this.panByScreen(intent.dx, intent.dy);
  }

  nudgeTo(x: number, y: number, opts: { w?: number; h?: number; durationMs?: number } = {}): void {
    const req: PendingNudge = { x, y, w: opts.w ?? 1, h: opts.h ?? 1, durationMs: opts.durationMs ?? 450 };
    if (this.following) return;
    if (this.isStrokeActive()) {
      this.pending = req;
      return;
    }
    this.startNudge(req);
  }

  private startNudge(req: PendingNudge): void {
    const rect = { x: req.x * TILE_PX, y: req.y * TILE_PX, w: req.w * TILE_PX, h: req.h * TILE_PX };
    const margin = Math.min(3 * TILE_PX, (this.viewport.w / this._zoom) * 0.15);
    const target = nudgeTarget(this.center, this._zoom, this.viewport, rect, margin);
    if (!target) return;
    const to = clampCenter(target, this._zoom, this.viewport, this.levelPx);
    const duration = reducedMotion() ? 0 : req.durationMs;
    if (duration <= 0) {
      this.center = to;
      this.tween = null;
      this.apply();
      return;
    }
    this.tween = { from: { ...this.center }, to, t: 0, duration };
  }

  /** Per-frame: advance a nudge; start a pending one once no stroke is active. */
  update(deltaMs: number): void {
    if (this.following) return;
    if (this.isStrokeActive()) return; // never move under the person's brush
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.startNudge(p);
    }
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(tw.duration, tw.t + deltaMs);
      const k = easeOutCubic(tw.t / tw.duration);
      this.center = { x: tw.from.x + (tw.to.x - tw.from.x) * k, y: tw.from.y + (tw.to.y - tw.from.y) * k };
      if (tw.t >= tw.duration) this.tween = null;
      this.apply();
    }
  }

  /** Play mode: follow a target. */
  follow(target: Phaser.GameObjects.GameObject & { x: number; y: number }): void {
    this.savedView = { center: { ...this.center }, zoom: this._zoom };
    this.tween = null;
    this.pending = null;
    this.following = true;
    const cam = this.cam;
    const playZoom = Phaser.Math.Clamp(this.viewport.h / (12 * TILE_PX), 1, 5);
    cam.setZoom(playZoom);
    cam.setBounds(0, -4 * TILE_PX, this.levelPx.w, this.levelPx.h + 4 * TILE_PX);
    cam.startFollow(target, true, 0.12, 0.12);
  }

  stopFollow(): void {
    if (!this.following) return;
    this.following = false;
    const cam = this.cam;
    cam.stopFollow();
    cam.removeBounds();
    if (this.savedView) {
      this.center = this.savedView.center;
      this._zoom = this.savedView.zoom;
      this.savedView = null;
    }
    this.apply();
  }

  private apply(): void {
    if (this.following) return;
    this.center = clampCenter(this.center, this._zoom, this.viewport, this.levelPx);
    const cam = this.cam;
    cam.setZoom(this._zoom);
    cam.centerOn(this.center.x, this.center.y);
  }

  // --- CameraApi ------------------------------------------------------------

  viewTiles(): { x: number; y: number; w: number; h: number } {
    const vw = this.viewport.w / this._zoom;
    const vh = this.viewport.h / this._zoom;
    return {
      x: (this.center.x - vw / 2) / TILE_PX,
      y: (this.center.y - vh / 2) / TILE_PX,
      w: vw / TILE_PX,
      h: vh / TILE_PX,
    };
  }

  screenToWorld(sx: number, sy: number): Vec {
    if (this.following) {
      const p = this.cam.getWorldPoint(sx, sy);
      return { x: p.x, y: p.y };
    }
    return screenToWorld({ x: sx, y: sy }, this.center, this._zoom, this.viewport);
  }

  screenToTile(sx: number, sy: number): Point {
    const w = this.screenToWorld(sx, sy);
    return { x: Math.floor(w.x / TILE_PX), y: Math.floor(w.y / TILE_PX) };
  }

  tileToScreen(x: number, y: number): Point {
    return {
      x: (x * TILE_PX - this.center.x) * this._zoom + this.viewport.w / 2,
      y: (y * TILE_PX - this.center.y) * this._zoom + this.viewport.h / 2,
    };
  }
}
