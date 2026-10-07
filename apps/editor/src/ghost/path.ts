/**
 * Route overlay (G-19): the playtest agent's route (Suggestion.path, body
 * centre cells) drawn as a dark-rimmed yellow line with dots, for 2 s after a
 * ghost is accepted, and on demand in Play mode (R) for the current section.
 *
 * The route is the explanation people watch: "this is how the knight gets
 * through what you just kept".
 */
import Phaser from "phaser";
import type { Point } from "../contracts";
import { DEPTH, TILE_PX } from "../editor/constants";
import { GHOST_STYLE, fadeProgress } from "./plan";
import { simplifyRoute } from "./routes";
import { prefersReducedMotion } from "./styles";

/** Fade-out at the end of a timed route (ms). */
const ROUTE_FADE_MS = 300;

/** World px of the centre of a route cell. */
export const routePointPx = (p: Point): Point => ({ x: (p.x + 0.5) * TILE_PX, y: (p.y + 0.5) * TILE_PX });

export interface PathOverlayOptions {
  now?: () => number;
  reducedMotion?: () => boolean;
}

export class PathOverlay {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private shownAt = 0;
  private until = 0;
  private points: Point[] = [];
  private readonly now: () => number;
  private readonly reduced: () => boolean;

  constructor(scene: Phaser.Scene, o: PathOverlayOptions = {}) {
    this.now = o.now ?? (() => performance.now());
    this.reduced = o.reducedMotion ?? prefersReducedMotion;
    // Above the ghost and the tiles, under the player during Play.
    this.gfx = scene.add.graphics().setDepth(DEPTH.ghost + 1).setVisible(false);
  }

  get visible(): boolean {
    return this.gfx.visible && this.points.length >= 2;
  }

  /** The route currently drawn (cells), empty when none. */
  get route(): readonly Point[] {
    return this.visible ? this.points : [];
  }

  /** Draw a route for `ms` (default 2 s). Returns false when there is no route to draw. */
  show(path: readonly Point[] | undefined, ms: number = GHOST_STYLE.routeMs): boolean {
    const pts = simplifyRoute(path ?? []);
    if (pts.length < 2) return false;
    this.points = pts;
    this.shownAt = this.now();
    this.until = this.shownAt + Math.max(0, ms);
    this.draw();
    this.gfx.setAlpha(1).setVisible(true);
    return true;
  }

  hide(): void {
    this.gfx.clear().setVisible(false);
    this.points = [];
    this.until = 0;
  }

  /** Per frame: fade out at the end, then hide. */
  update(now = this.now()): void {
    if (!this.gfx.visible) return;
    if (now >= this.until) {
      this.hide();
      return;
    }
    const fadeStart = this.until - ROUTE_FADE_MS;
    if (!this.reduced() && now > fadeStart) this.gfx.setAlpha(1 - fadeProgress(now, fadeStart, ROUTE_FADE_MS));
  }

  destroy(): void {
    this.gfx.destroy();
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();
    const px = this.points.map(routePointPx);
    const stroke = (width: number, color: number, alpha: number) => {
      g.lineStyle(width, color, alpha);
      g.beginPath();
      g.moveTo(px[0].x, px[0].y);
      for (let i = 1; i < px.length; i++) g.lineTo(px[i].x, px[i].y);
      g.strokePath();
    };
    stroke(4, GHOST_STYLE.routeRim, 0.5);
    stroke(2, GHOST_STYLE.routeColor, 0.95);
    // Dots at turns, a ring at the end.
    g.fillStyle(GHOST_STYLE.routeColor, 1);
    for (let i = 1; i < px.length - 1; i++) g.fillCircle(px[i].x, px[i].y, 1.5);
    const end = px[px.length - 1];
    g.lineStyle(3, GHOST_STYLE.routeRim, 0.5);
    g.strokeCircle(end.x, end.y, 4);
    g.lineStyle(1.5, GHOST_STYLE.routeColor, 1);
    g.strokeCircle(end.x, end.y, 4);
  }
}
