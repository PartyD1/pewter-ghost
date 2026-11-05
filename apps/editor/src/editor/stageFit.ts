/**
 * Fit the editor to the window: the canvas shrinks so the title, canvas, panel
 * and toolbar are all on screen. The game stays 928x720 inside (only its CSS
 * size changes), so every window shows the same stretch of level and the
 * pointer, recorded input and ghost overlay keep their game coordinates.
 *
 * Pure (no Phaser import); `keepStageFitted` takes what it needs as arguments.
 */

/** The canvas is never scaled up, and below this it is too small to paint on (the page scrolls instead). */
export const MAX_STAGE_ZOOM = 1;
export const MIN_STAGE_ZOOM = 0.35;

export interface StageFitInput {
  /** Window size, CSS px. */
  view: { w: number; h: number };
  /** Game size (canvas at zoom 1), px. */
  stage: { w: number; h: number };
  /** Space the chrome needs beside and above / below the canvas, CSS px. */
  reserved: { w: number; h: number };
}

/** The zoom that fits the canvas and the chrome in the window. */
export function fitStageZoom({ view, stage, reserved }: StageFitInput): number {
  const zoom = Math.min((view.w - reserved.w) / stage.w, (view.h - reserved.h) / stage.h);
  if (!Number.isFinite(zoom)) return MAX_STAGE_ZOOM;
  return Math.min(MAX_STAGE_ZOOM, Math.max(MIN_STAGE_ZOOM, zoom));
}

/** Breathing room between the layout and the window edges, CSS px (total per axis). */
const WINDOW_MARGIN = 16;
/** The panel slot's width and the gap before it (style.css #pg-panel-slot, #pg-frame). */
const PANEL_W = 340 + 12;

export interface StageFitTarget {
  stage: { w: number; h: number };
  setZoom(zoom: number): void;
}

/** Fit now and again whenever the window or the toolbar's height changes. Returns a stop function. */
export function keepStageFitted(target: StageFitTarget): () => void {
  const root = document.documentElement;
  const title = document.querySelector<HTMLElement>(".emoji-container");
  const layout = document.getElementById("pg-layout");
  const toolbar = document.getElementById("pg-toolbar-slot");
  let last = NaN;

  const fit = () => {
    const gap = layout ? parseFloat(getComputedStyle(layout).rowGap) || 0 : 0;
    const chromeH = (title?.getBoundingClientRect().height ?? 0) + gap + (toolbar?.getBoundingClientRect().height ?? 0);
    const zoom = fitStageZoom({
      view: { w: window.innerWidth, h: window.innerHeight },
      stage: target.stage,
      reserved: { w: PANEL_W + WINDOW_MARGIN, h: chromeH + WINDOW_MARGIN },
    });
    if (zoom === last) return;
    last = zoom;
    const h = Math.floor(target.stage.h * zoom);
    root.style.setProperty("--pg-stage-h", `${h}px`);
    root.style.setProperty("--pg-layout-w", `${Math.floor(target.stage.w * zoom) + PANEL_W}px`);
    target.setZoom(zoom);
  };

  fit();
  window.addEventListener("resize", fit);
  const seen = typeof ResizeObserver === "undefined" || !toolbar ? null : new ResizeObserver(fit);
  if (toolbar) seen?.observe(toolbar);
  return () => {
    window.removeEventListener("resize", fit);
    seen?.disconnect();
  };
}
