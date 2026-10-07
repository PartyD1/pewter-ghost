/**
 * Pointer binding (G-04): one pointerdown handler, canvas events only.
 *
 * - Left button only. Right-click does nothing (no eyedropper, no eraser,
 *   no context menu); middle-drag pans as a convenience.
 * - A stroke stops when the pointer leaves the canvas, when it moves over DOM
 *   UI laid on top of the canvas (hit-tested with elementFromPoint), when the
 *   button is released anywhere, and when the window loses focus.
 * - Pan mode, or Space held, turns a left drag into a camera pan.
 */
import Phaser from "phaser";
import type { Point } from "../contracts";
import type { CameraController } from "./camera";
import type { ModeState } from "./modes";
import type { StrokePainter } from "./paint";

export interface PointerDeps {
  scene: Phaser.Scene;
  camera: CameraController;
  modes: ModeState;
  painter: StrokePainter;
  isPlaying: () => boolean;
  onHover: (cell: Point | undefined) => void;
  /** Select-mode click (inspection only; never edits). */
  onSelect?: (cell: Point) => void;
  inBounds: (x: number, y: number) => boolean;
}

type NativePointer = MouseEvent | PointerEvent | TouchEvent;

export class PointerBinding {
  private panning: { lastX: number; lastY: number; button: number } | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly deps: PointerDeps) {
    const { scene } = deps;
    this.canvas = scene.game.canvas;
    const input = scene.input;
    input.mouse?.disableContextMenu();
    input.on(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
    input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    input.on(Phaser.Input.Events.GAME_OUT, this.onLeave, this);

    const leave = () => this.onLeave();
    const blur = () => this.stopAll();
    const wheel = (e: WheelEvent) => {
      if (deps.isPlaying()) return;
      e.preventDefault(); // keep the page from zooming on pinch
      deps.camera.onWheel(e);
    };
    this.canvas.addEventListener("pointerleave", leave);
    this.canvas.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", blur);
    this.cleanups.push(
      () => this.canvas.removeEventListener("pointerleave", leave),
      () => this.canvas.removeEventListener("wheel", wheel),
      () => window.removeEventListener("blur", blur),
    );
  }

  destroy(): void {
    const input = this.deps.scene.input;
    input.off(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
    input.off(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    input.off(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);
    input.off(Phaser.Input.Events.GAME_OUT, this.onLeave, this);
    for (const c of this.cleanups.splice(0)) c();
  }

  get isPanning(): boolean {
    return this.panning !== null;
  }

  /** End any stroke or pan in progress (mode change, Play, dialogs). */
  stopAll(): void {
    this.deps.painter.end();
    this.panning = null;
  }

  /** True when the native event is over the canvas itself, not DOM UI laid on top. */
  private overCanvas(p: Phaser.Input.Pointer): boolean {
    const ev = p.event as NativePointer | undefined;
    if (!ev || !("clientX" in ev)) return true; // touch: Phaser only reports canvas touches
    if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return true;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    return el === this.canvas;
  }

  private cellOf(p: Phaser.Input.Pointer): Point {
    return this.deps.camera.screenToTile(p.x, p.y);
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.deps.isPlaying()) return;
    if (!this.overCanvas(p)) return;
    const { modes, painter } = this.deps;
    if (p.rightButtonDown() && !p.leftButtonDown()) return; // right-click: nothing
    if (p.middleButtonDown()) {
      this.panning = { lastX: p.x, lastY: p.y, button: 1 };
      return;
    }
    if (!p.leftButtonDown() && p.wasTouch !== true) return;
    const mode = modes.effective;
    if (mode === "pan") {
      this.panning = { lastX: p.x, lastY: p.y, button: 0 };
      return;
    }
    const cell = this.cellOf(p);
    if (mode === "select") {
      if (this.deps.inBounds(cell.x, cell.y)) this.deps.onSelect?.(cell);
      return;
    }
    painter.begin(cell, mode, modes.brush);
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (this.deps.isPlaying()) return;
    if (!this.overCanvas(p)) {
      // Over DOM UI or outside: stop painting under the toolbar/palette.
      this.deps.painter.end();
      this.deps.onHover(undefined);
      return;
    }
    if (this.panning) {
      const stillDown = this.panning.button === 1 ? p.middleButtonDown() : p.isDown;
      if (!stillDown) {
        this.panning = null;
      } else {
        this.deps.camera.panByScreen(this.panning.lastX - p.x, this.panning.lastY - p.y);
        this.panning.lastX = p.x;
        this.panning.lastY = p.y;
      }
    }
    const cell = this.cellOf(p);
    const painter = this.deps.painter;
    if (painter.isActive) {
      if (!p.isDown) painter.end();
      else painter.move(cell);
    }
    this.deps.onHover(this.deps.inBounds(cell.x, cell.y) ? cell : undefined);
  }

  private onUp(): void {
    this.stopAll();
  }

  private onLeave(): void {
    this.stopAll();
    this.deps.onHover(undefined);
  }
}
