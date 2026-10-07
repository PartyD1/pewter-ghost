/**
 * Ghost layer (G-11, G-24 rendering): draws the ONE active suggestion above
 * the tiles and below the cursor.
 *
 *  - adds: the real tile frame at 35% opacity, inside a dashed outline drawn
 *    around the union of the added cells (light dashes on a dark rim, so it
 *    reads on sky, grass and dirt, in bright and dim rooms);
 *  - entities: faint sprites, inside the same outline;
 *  - removes (Fix): the existing tile dimmed, crossed out, with a dashed red
 *    box: shape (cross vs dash), not colour alone, tells them apart;
 *  - a short caption near the anchor (DOM, crisp), fading after 2 s;
 *  - an edge arrow when the ghost reaches past the viewport.
 *
 * Fades in over 120 ms, never blinks or pulses; respects reduced motion.
 * The layer only draws: SuggestionManager decides what is shown.
 */
import Phaser from "phaser";
import type { Suggestion, SuggestionKind } from "../contracts";
import type { CameraApi } from "../editor/api";
import { ASSET, DEPTH, ENTITY_FRAME, TILE_PX } from "../editor/constants";
import type { Box, GhostCell } from "../suggest/geometry";
import { arrowRotation, edgeArrow, type EdgeArrow } from "./extend";
import type { StageOverlay } from "./overlay";
import { GHOST_STYLE, dashSegments, edgePx, fadeProgress, planGhost, planSize, type GhostPlan } from "./plan";
import { prefersReducedMotion } from "./styles";

export type LayerEnd = "accepted" | "dismissed";

export interface GhostLayerOptions {
  scene: Phaser.Scene;
  camera: CameraApi;
  overlay: StageOverlay;
  /** ms clock (default performance.now). */
  now?: () => number;
  reducedMotion?: () => boolean;
  /** The edge arrow was clicked: bring this box into view. */
  onArrow?: (box: Box) => void;
}

/** What the layer currently draws (for e2e tests and the dev overlay). */
export interface GhostLayerState {
  suggestionId: string | null;
  kind: SuggestionKind | null;
  adds: number;
  removes: number;
  entities: number;
  outlineRuns: number;
  /** Container alpha (fade progress); the per-tile alpha is GHOST_STYLE.alpha on top of this. */
  alpha: number;
  visible: boolean;
  caption: string | null;
  arrow: EdgeArrow | null;
  /** Ghost containers still fading out. */
  leaving: number;
}

interface Active {
  s: Suggestion;
  plan: GhostPlan;
  container: Phaser.GameObjects.Container;
  gfx: Phaser.GameObjects.Graphics;
  images: Phaser.GameObjects.Image[];
  shownAt: number;
  captionText: string;
  captionOut: boolean;
}

interface Leaving {
  container: Phaser.GameObjects.Container;
  t0: number;
  ms: number;
  from: number;
}

export class GhostLayer {
  private active: Active | null = null;
  private leaving: Leaving[] = [];
  private readonly caption: HTMLDivElement;
  private readonly arrowEl: HTMLButtonElement;
  private arrow: EdgeArrow | null = null;
  private suspended = false;
  private drawnZoom = 0;
  private readonly now: () => number;
  private readonly reduced: () => boolean;
  private destroyed = false;

  constructor(private readonly o: GhostLayerOptions) {
    this.now = o.now ?? (() => performance.now());
    this.reduced = o.reducedMotion ?? prefersReducedMotion;
    this.caption = document.createElement("div");
    this.caption.className = "pg-ghost-caption";
    this.caption.hidden = true;
    this.arrowEl = document.createElement("button");
    this.arrowEl.type = "button";
    this.arrowEl.className = "pg-ghost-arrow";
    this.arrowEl.hidden = true;
    this.arrowEl.tabIndex = -1; // Tab belongs to accept while a ghost is shown
    this.arrowEl.setAttribute("aria-label", "Scroll to the suggestion");
    this.arrowEl.title = "Scroll to the suggestion";
    this.arrowEl.append(document.createElement("span"), document.createElement("small"));
    (this.arrowEl.firstChild as HTMLElement).textContent = "➜";
    this.arrowEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.arrowEl.addEventListener("click", (e) => {
      e.preventDefault();
      if (this.active) this.o.onArrow?.(this.active.plan.box);
    });
    o.overlay.root.append(this.caption, this.arrowEl);
  }

  get current(): Suggestion | null {
    return this.active?.s ?? null;
  }

  /** Draw a suggestion (replacing any other, which fades out). */
  show(s: Suggestion, captionText: string): void {
    if (this.destroyed) return;
    if (this.active) this.end("dismissed");
    const scene = this.o.scene;
    const plan = planGhost(s);
    const container = scene.add.container(0, 0).setDepth(DEPTH.ghost);
    const gfx = scene.add.graphics();
    const images: Phaser.GameObjects.Image[] = [];
    container.add(gfx);
    this.active = { s, plan, container, gfx, images, shownAt: this.now(), captionText, captionOut: false };
    this.rebuild();
    container.setAlpha(this.reduced() ? 1 : 0);
    container.setVisible(!this.suspended);

    this.caption.textContent = captionText;
    this.caption.classList.toggle("pg-fix", s.kind === "fix");
    this.caption.classList.remove("pg-in", "pg-out");
    this.caption.hidden = this.suspended || !captionText;
    // Next frame: start the CSS fade-in from opacity 0 (no flash at full opacity).
    void this.caption.offsetWidth;
    if (!this.caption.hidden) this.caption.classList.add("pg-in");
    this.update();
  }

  /** Only these cells are still proposed (the person painted the others by hand). */
  setRemaining(cells: readonly GhostCell[]): void {
    const a = this.active;
    if (!a) return;
    a.plan = { ...planGhost(a.s, cells), box: a.plan.box };
    this.rebuild();
  }

  /**
   * The ghost is gone. "accepted": the real tiles are already drawn by the
   * renderer underneath, so the faint tiles go at once and only the outline
   * fades (150 ms). "dismissed": everything fades out (120 ms).
   */
  end(how: LayerEnd = "dismissed"): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const reduced = this.reduced();
    if (how === "accepted") {
      for (const im of a.images) im.destroy();
      a.images.length = 0;
    }
    const ms = reduced ? 0 : how === "accepted" ? GHOST_STYLE.acceptMs : GHOST_STYLE.fadeOutMs;
    if (ms <= 0) a.container.destroy(true);
    else this.leaving.push({ container: a.container, t0: this.now(), ms, from: a.container.alpha });
    this.caption.classList.remove("pg-in");
    this.caption.classList.add("pg-out");
    this.caption.hidden = true;
    this.hideArrow();
  }

  /** Hide everything while Play runs (the manager keeps its state). */
  setSuspended(on: boolean): void {
    this.suspended = on;
    if (this.active) this.active.container.setVisible(!on);
    for (const l of this.leaving) l.container.setVisible(!on);
    if (on) {
      this.caption.hidden = true;
      this.hideArrow();
    } else if (this.active && !this.active.captionOut && this.active.captionText) {
      this.caption.hidden = false;
      this.caption.classList.add("pg-in");
    }
  }

  /** Per frame: fades, caption timing and position, edge arrow, zoom-dependent line widths. */
  update(now = this.now()): void {
    if (this.destroyed) return;
    for (const l of [...this.leaving]) {
      const k = fadeProgress(now, l.t0, l.ms);
      l.container.setAlpha(l.from * (1 - k));
      if (k >= 1) {
        l.container.destroy(true);
        this.leaving.splice(this.leaving.indexOf(l), 1);
      }
    }
    const a = this.active;
    if (!a) return;
    if (!this.reduced()) a.container.setAlpha(fadeProgress(now, a.shownAt, GHOST_STYLE.fadeInMs));
    else a.container.setAlpha(1);
    if (this.o.camera.zoom !== this.drawnZoom) this.drawLines();
    if (this.suspended) return;

    // Caption: above the ghost, level with the anchor; fades after captionMs.
    if (!a.captionOut && now - a.shownAt >= GHOST_STYLE.captionMs) {
      a.captionOut = true;
      this.caption.classList.remove("pg-in");
      this.caption.classList.add("pg-out");
    }
    if (!this.caption.hidden) {
      const p = this.o.overlay.tileToStage(a.s.anchor.x + 0.5, a.plan.box.y0);
      this.caption.style.left = `${Math.round(p.x)}px`;
      this.caption.style.top = `${Math.round(p.y - 4)}px`;
    }

    // Edge arrow when the ghost reaches past the viewport.
    const arrow = edgeArrow(this.o.camera.viewTiles(), a.plan.box, 1.2);
    this.arrow = arrow;
    if (!arrow) {
      this.hideArrow();
      return;
    }
    const p = this.o.overlay.tileToStage(arrow.at.x, arrow.at.y);
    this.arrowEl.hidden = false;
    this.arrowEl.classList.add("pg-in");
    this.arrowEl.style.left = `${Math.round(p.x)}px`;
    this.arrowEl.style.top = `${Math.round(p.y)}px`;
    (this.arrowEl.firstChild as HTMLElement).style.transform = `rotate(${arrowRotation(arrow.side)}deg)`;
    (this.arrowEl.lastChild as HTMLElement).textContent = `${arrow.beyond} tiles`;
  }

  state(): GhostLayerState {
    const a = this.active;
    return {
      suggestionId: a?.s.id ?? null,
      kind: a?.s.kind ?? null,
      adds: a?.plan.adds.length ?? 0,
      removes: a?.plan.removes.length ?? 0,
      entities: a?.plan.entities.length ?? 0,
      outlineRuns: a?.plan.outline.length ?? 0,
      alpha: a ? a.container.alpha : 0,
      visible: !!a && a.container.visible && planSize(a.plan) > 0,
      caption: a && !this.caption.hidden ? this.caption.textContent : null,
      arrow: a ? this.arrow : null,
      leaving: this.leaving.length,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.active?.container.destroy(true);
    this.active = null;
    for (const l of this.leaving) l.container.destroy(true);
    this.leaving = [];
    this.caption.remove();
    this.arrowEl.remove();
    this.destroyed = true;
  }

  // ---------------------------------------------------------------- drawing

  private hideArrow(): void {
    this.arrowEl.hidden = true;
    this.arrowEl.classList.remove("pg-in");
    this.arrow = null;
  }

  private rebuild(): void {
    const a = this.active;
    if (!a) return;
    for (const im of a.images) im.destroy();
    a.images.length = 0;
    const scene = this.o.scene;
    for (const add of a.plan.adds) {
      const im = scene.add.image(add.x * TILE_PX, add.y * TILE_PX, ASSET.tiles, add.tile).setOrigin(0, 0).setAlpha(GHOST_STYLE.alpha);
      a.images.push(im);
    }
    for (const en of a.plan.entities) {
      const im = scene.add
        .image(en.x * TILE_PX, en.y * TILE_PX, ASSET.tiles, ENTITY_FRAME[en.kind])
        .setOrigin(0, 0)
        .setAlpha(GHOST_STYLE.alpha + 0.1);
      a.images.push(im);
    }
    // Images under the line graphics.
    a.container.addAt(a.images, 0);
    this.drawLines();
  }

  /** Outline, removal marks. Line widths are in screen px, so redraw when the zoom changes. */
  private drawLines(): void {
    const a = this.active;
    if (!a) return;
    const zoom = this.o.camera.zoom || 1;
    this.drawnZoom = this.o.camera.zoom;
    const px = 1 / zoom;
    const g = a.gfx;
    g.clear();
    const dash = GHOST_STYLE.dashPx * px;
    const gap = GHOST_STYLE.gapPx * px;

    // Removals: dim the tile, dark-rimmed red cross, dashed red box.
    for (const r of a.plan.removes) {
      const x = r.x * TILE_PX;
      const y = r.y * TILE_PX;
      g.fillStyle(GHOST_STYLE.removeDim, GHOST_STYLE.removeDimAlpha);
      g.fillRect(x, y, TILE_PX, TILE_PX);
      const m = 3;
      g.lineStyle(3.5 * px, GHOST_STYLE.rimColor, GHOST_STYLE.rimAlpha);
      g.lineBetween(x + m, y + m, x + TILE_PX - m, y + TILE_PX - m);
      g.lineBetween(x + TILE_PX - m, y + m, x + m, y + TILE_PX - m);
      g.lineStyle(1.5 * px, GHOST_STYLE.removeColor, 1);
      g.lineBetween(x + m, y + m, x + TILE_PX - m, y + TILE_PX - m);
      g.lineBetween(x + TILE_PX - m, y + m, x + m, y + TILE_PX - m);
      const box: [number, number, number, number][] = [
        [x, y, x + TILE_PX, y],
        [x + TILE_PX, y, x + TILE_PX, y + TILE_PX],
        [x + TILE_PX, y + TILE_PX, x, y + TILE_PX],
        [x, y + TILE_PX, x, y],
      ];
      g.lineStyle(px, GHOST_STYLE.removeColor, 0.95);
      for (const [x0, y0, x1, y1] of box) for (const s of dashSegments(x0, y0, x1, y1, dash, gap)) g.lineBetween(...s);
    }

    // Outline of adds + entities: a soft dark rim, then light dashes on top.
    const edges = a.plan.outline.map(edgePx);
    g.lineStyle(2.5 * px, GHOST_STYLE.rimColor, GHOST_STYLE.rimAlpha);
    for (const [x0, y0, x1, y1] of edges) g.lineBetween(x0, y0, x1, y1);
    g.lineStyle(px, GHOST_STYLE.dashColor, 1);
    for (const [x0, y0, x1, y1] of edges) for (const s of dashSegments(x0, y0, x1, y1, dash, gap)) g.lineBetween(...s);
  }
}
