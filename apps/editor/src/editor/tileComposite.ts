/**
 * The editor's sprite composite, drawn with plain Canvas2D (no Phaser), so the
 * editor and the session replay viewer build the same pixels from the same
 * source images.
 *
 * `paintComposite` lays the 16 composite frames side by side (frame index ==
 * model TileId for terrain, see constants.ts FRAME / FRAME_SOURCES). `paintGhost`
 * turns that strip into the light-grey copy used for suggestions.
 * `backdropSource` says where a Tiled gid of the old default map's
 * Background_Layer comes from (the editor's backdrop).
 */
import { FRAME_COUNT, FRAME_SOURCES, KENNEY_PX, TILE_PX } from "./constants";

export function drawStartMarker(ctx: CanvasRenderingContext2D, x: number): void {
  // A small green pennant on a pole: "the knight starts here".
  ctx.fillStyle = "#2d3a2e";
  ctx.fillRect(x + 4, 2, 2, 13);
  ctx.fillStyle = "#3ccf6e";
  ctx.beginPath();
  ctx.moveTo(x + 6, 2);
  ctx.lineTo(x + 14, 5);
  ctx.lineTo(x + 6, 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#2d3a2e";
  ctx.fillRect(x + 2, 14, 6, 2);
}

/** Swap red and blue in the reddish pixels of one frame (red cloth -> blue; pole and outline stay). */
export function recolorBlue(ctx: CanvasRenderingContext2D, x: number): void {
  const img = ctx.getImageData(x, 0, TILE_PX, TILE_PX);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > d[i + 1] + 40 && d[i] > d[i + 2] + 40) [d[i], d[i + 2]] = [d[i + 2], d[i]];
  }
  ctx.putImageData(img, x, 0);
}

/**
 * Draw every composite frame into `ctx` (a canvas FRAME_COUNT * TILE_PX wide,
 * TILE_PX tall): Brackeys strip frames and Kenney frames (18 px, resampled to
 * 16), the Kenney flag's blue variant, and the procedural start pennant.
 */
export function paintComposite(ctx: CanvasRenderingContext2D, brackeys: CanvasImageSource, kenney: CanvasImageSource): void {
  ctx.imageSmoothingEnabled = false;
  for (const [frameStr, src] of Object.entries(FRAME_SOURCES)) {
    const dx = Number(frameStr) * TILE_PX;
    if ("brackeys" in src) ctx.drawImage(brackeys, src.brackeys * TILE_PX, 0, TILE_PX, TILE_PX, dx, 0, TILE_PX, TILE_PX);
    else if ("kenney" in src) {
      const [c, r] = src.kenney;
      ctx.drawImage(kenney, c * KENNEY_PX, r * KENNEY_PX, KENNEY_PX, KENNEY_PX, dx, 0, TILE_PX, TILE_PX);
      if (src.blue) recolorBlue(ctx, dx);
    } else drawStartMarker(ctx, dx);
  }
}

/** Grey range of the ghost texture (dark outline pixels -> lo, white -> hi). */
export const GHOST_GREY = { lo: 110, hi: 245 } as const;

/**
 * Draw the composite `src` into `ctx` in light grey, for ghost suggestions.
 * Each pixel's luminance is mapped to the upper half of the grey range, so a
 * ghost reads as a faint grey copy of the real tile on the backdrop's white,
 * light-blue and dark-blue bands alike.
 */
export function paintGhost(ctx: CanvasRenderingContext2D, src: CanvasImageSource): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, FRAME_COUNT * TILE_PX, TILE_PX);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.round(GHOST_GREY.lo + (l / 255) * (GHOST_GREY.hi - GHOST_GREY.lo));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

/** A tileset entry of the default map (Tiled): the first gid it owns and its name. */
export interface MapTileset {
  firstgid: number;
  name: string;
}

/**
 * Which 16 px source frame a Tiled gid of the default map draws: the tileset
 * with the highest firstgid <= gid, and the index inside its strip. The
 * "Extras" tileset is pewterPlatformerTilesetBackgroundExtras.png; the other
 * is the Brackeys strip. Null for gid 0 (empty) or an unknown tileset.
 */
export function backdropSource(gid: number, tilesets: readonly MapTileset[]): { sheet: "brackeys" | "extras"; index: number } | null {
  if (gid <= 0) return null;
  let owner: MapTileset | null = null;
  for (const t of tilesets) if (t.firstgid <= gid && (!owner || t.firstgid > owner.firstgid)) owner = t;
  if (!owner) return null;
  const sheet = owner.name === "Extras" ? "extras" : owner.name === "pewterPlatformerTilesetExtended" ? "brackeys" : null;
  return sheet ? { sheet, index: gid - owner.firstgid } : null;
}
