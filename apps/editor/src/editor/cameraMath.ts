/**
 * Camera math, pure (camera.ts applies it to Phaser). Everything here works
 * in world pixels on the camera CENTRE, which keeps zoom maths simple.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export const MIN_ZOOM_FACTOR = 0.5; // relative to the fit-height zoom
export const MAX_ZOOM = 8;
/** Extra room (world px) the camera may show beyond the level edge. */
export const EDGE_PAD_PX = 48;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Zoom at which the level's full height fills the viewport. */
export function fitZoom(viewport: Size, levelPx: Size): number {
  if (viewport.h <= 0 || levelPx.h <= 0) return 1;
  return viewport.h / (levelPx.h + EDGE_PAD_PX);
}

export function zoomLimits(viewport: Size, levelPx: Size): { min: number; max: number } {
  const fit = fitZoom(viewport, levelPx);
  return { min: Math.max(0.1, fit * MIN_ZOOM_FACTOR), max: Math.max(MAX_ZOOM, fit) };
}

/**
 * Keep the camera over the level. When the view is wider/taller than the
 * level (plus padding) on an axis, it centres on that axis.
 */
export function clampCenter(center: Vec, zoom: number, viewport: Size, levelPx: Size, pad = EDGE_PAD_PX): Vec {
  const vw = viewport.w / zoom;
  const vh = viewport.h / zoom;
  const axis = (c: number, view: number, size: number) => {
    const lo = view / 2 - pad;
    const hi = size - view / 2 + pad;
    return lo > hi ? size / 2 : clamp(c, lo, hi);
  };
  return { x: axis(center.x, vw, levelPx.w), y: axis(center.y, vh, levelPx.h) };
}

/** New centre so that `anchor` (world px) stays under the same screen point after zooming. */
export function zoomAround(center: Vec, zoom: number, newZoom: number, anchor: Vec): Vec {
  const offX = (anchor.x - center.x) * zoom;
  const offY = (anchor.y - center.y) * zoom;
  return { x: anchor.x - offX / newZoom, y: anchor.y - offY / newZoom };
}

/** Screen pixel -> world pixel, for a camera centred at `center`. */
export function screenToWorld(screen: Vec, center: Vec, zoom: number, viewport: Size): Vec {
  return {
    x: center.x + (screen.x - viewport.w / 2) / zoom,
    y: center.y + (screen.y - viewport.h / 2) / zoom,
  };
}

/**
 * The smallest centre move that brings the world rect `target` inside the
 * view with `margin` world px to spare; null when it is already visible.
 * When the target is bigger than the view, it centres on the target.
 */
export function nudgeTarget(
  center: Vec,
  zoom: number,
  viewport: Size,
  target: { x: number; y: number; w: number; h: number },
  margin: number,
): Vec | null {
  const vw = viewport.w / zoom;
  const vh = viewport.h / zoom;
  const axis = (c: number, view: number, t0: number, t1: number) => {
    const lo = c - view / 2 + margin;
    const hi = c + view / 2 - margin;
    if (t1 - t0 > hi - lo) return (t0 + t1) / 2;
    if (t0 < lo) return c - (lo - t0);
    if (t1 > hi) return c + (t1 - hi);
    return c;
  };
  const x = axis(center.x, vw, target.x, target.x + target.w);
  const y = axis(center.y, vh, target.y, target.y + target.h);
  if (Math.abs(x - center.x) < 0.5 && Math.abs(y - center.y) < 0.5) return null;
  return { x, y };
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 pixel, 1 line, 2 page. */
  deltaMode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export type WheelIntent = { kind: "zoom"; factor: number } | { kind: "pan"; dx: number; dy: number };

/**
 * Trackpad-friendly wheel handling. Pinch (ctrlKey wheel, what browsers send
 * for a trackpad pinch) or Ctrl/Cmd+wheel zooms. Anything else pans: two
 * finger scrolls pan both ways; a plain vertical mouse wheel scrolls the
 * level sideways when the level already fits vertically (it is 200 x 20).
 * Shift+wheel always pans sideways. Returned pan deltas are SCREEN pixels.
 */
export function wheelIntent(e: WheelLike, levelFitsVertically: boolean): WheelIntent {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.exp(-clamp(dy, -100, 100) * 0.01);
    return { kind: "zoom", factor };
  }
  if (e.shiftKey && dx === 0) return { kind: "pan", dx: dy, dy: 0 };
  if (levelFitsVertically && Math.abs(dx) < Math.abs(dy) * 0.5) return { kind: "pan", dx: dy, dy: 0 };
  return { kind: "pan", dx, dy };
}

/** Ease used by the nudge tween. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
