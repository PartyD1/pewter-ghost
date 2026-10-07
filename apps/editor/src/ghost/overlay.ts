/**
 * A DOM layer over the canvas for crisp text and the edge arrow (Phaser text
 * would be pixelated by the editor's pixelArt setting). It never takes
 * pointer events except on elements that ask for them, so painting through
 * the caption works (the pointer binding hit-tests with elementFromPoint,
 * which skips pointer-events: none).
 */
import type { CameraApi } from "../editor/api";
import { injectGhostStyles } from "./styles";

export class StageOverlay {
  readonly root: HTMLDivElement;

  constructor(
    private readonly stage: HTMLElement,
    private readonly camera: CameraApi,
    private readonly canvas: () => HTMLCanvasElement | null,
    private readonly gameSize: () => { w: number; h: number },
  ) {
    injectGhostStyles();
    this.root = document.createElement("div");
    this.root.className = "pg-ghost-overlay";
    this.root.setAttribute("aria-hidden", "true");
    stage.appendChild(this.root);
  }

  /** Stage-relative CSS px of a tile coordinate (fractional tiles allowed). */
  tileToStage(x: number, y: number): { x: number; y: number } {
    const p = this.camera.tileToScreen(x, y);
    const c = this.canvas();
    if (!c) return p;
    const cr = c.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const g = this.gameSize();
    const sx = g.w > 0 && cr.width > 0 ? cr.width / g.w : 1;
    const sy = g.h > 0 && cr.height > 0 ? cr.height / g.h : 1;
    return { x: cr.left - sr.left + p.x * sx, y: cr.top - sr.top + p.y * sy };
  }

  /** Stage size in CSS px. */
  size(): { w: number; h: number } {
    return { w: this.stage.clientWidth, h: this.stage.clientHeight };
  }

  destroy(): void {
    this.root.remove();
  }
}
