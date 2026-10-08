/**
 * Asset loading and the composite 16 px texture.
 *
 * preloadAssets() is the old Pewter Platformer LoadingScene.preload
 * (pewter-platfomer src/phaser/loadingScene.ts:8-28), copied verbatim, plus
 * one line for the Kenney sheet. The old editor drew terrain, collectables,
 * enemies and the knight from the 15-frame Brackeys strip
 * (pewterPlatformerTilesetExtended.png, 16 px). Its frame for tile id 1
 * ("Block 1") is blank, and it has no flag or sign, so those come from the
 * Kenney sheet already in public/ (18 px frames, resampled to 16). Everything
 * is copied once into one canvas texture whose frame index equals the
 * model's TileId for terrain. The old keys ("tileset", "extras-tileset",
 * "defaultMap", "spritesheet", "pellets") are the ASSET constants.
 */
import Phaser from "phaser";
import { ASSET, FRAME_COUNT, FRAME_SOURCES, KENNEY_PX, TILE_PX } from "./constants";

export function preloadAssets(scene: Phaser.Scene): void {
  // --- old loadingScene.ts preload(), verbatim (this -> scene) ---
  scene.load.setPath("phaserAssets/");
  scene.load.image("tileset", "pewterPlatformerTilesetExtended.png");
  scene.load.image("extras-tileset", "pewterPlatformerTilesetBackgroundExtras.png");
  scene.load.tilemapTiledJSON("defaultMap", "pewterPlatformerDefaultMap.json");
  //this.load.image("pellets", "pellets.png");

  scene.load.spritesheet("spritesheet", "pewterPlatformerTilesetExtended.png", {
    frameWidth: 16,
    frameHeight: 16,
  });

  scene.load.spritesheet("pellets", "pellets.png", {
    frameWidth: 16,
    frameHeight: 16,
  });
  // --- end of the old preload ---

  // New: the Kenney sheet for the Block, Flag and Sign frames (the old
  // EditorScene.preload loaded the same file as "tilemap_tiles").
  scene.load.image(ASSET.kenney, "tilemap_packed.png");
  scene.load.setPath("");
}

function drawStartMarker(ctx: CanvasRenderingContext2D, x: number): void {
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

/** Build `pg-tiles` (the composite) and `pg-tiles-ghost`. Safe to call twice. */
export function buildTextures(scene: Phaser.Scene): void {
  const textures = scene.textures;
  if (!textures.exists(ASSET.tiles)) {
    const canvas = textures.createCanvas(ASSET.tiles, FRAME_COUNT * TILE_PX, TILE_PX);
    if (!canvas) throw new Error("could not create the tile texture");
    const ctx = canvas.context;
    ctx.imageSmoothingEnabled = false;
    const brackeys = textures.get(ASSET.brackeys).getSourceImage() as CanvasImageSource;
    const kenney = textures.get(ASSET.kenney).getSourceImage() as CanvasImageSource;
    for (const [frameStr, src] of Object.entries(FRAME_SOURCES)) {
      const f = Number(frameStr);
      const dx = f * TILE_PX;
      if ("brackeys" in src) ctx.drawImage(brackeys, src.brackeys * TILE_PX, 0, TILE_PX, TILE_PX, dx, 0, TILE_PX, TILE_PX);
      else if ("kenney" in src) {
        const [c, r] = src.kenney;
        ctx.drawImage(kenney, c * KENNEY_PX, r * KENNEY_PX, KENNEY_PX, KENNEY_PX, dx, 0, TILE_PX, TILE_PX);
      } else drawStartMarker(ctx, dx);
    }
    canvas.refresh();
    for (let f = 0; f < FRAME_COUNT; f++) canvas.add(f, 0, f * TILE_PX, 0, TILE_PX, TILE_PX);
  }
  if (!textures.exists(ASSET.ghostTiles)) buildGhostTiles(textures);
}

/**
 * `pg-tiles-ghost`: the composite in light grey, for ghost suggestions. Each
 * pixel's luminance is mapped to the upper half of the grey range, so a
 * ghost reads as a faint grey copy of the real tile on the old backdrop's
 * white, light-blue and dark-blue bands alike (the old app had no ghost; the
 * mapping has no old source).
 */
function buildGhostTiles(textures: Phaser.Textures.TextureManager): void {
  const src = textures.get(ASSET.tiles).getSourceImage() as HTMLCanvasElement;
  const grey = textures.createCanvas(ASSET.ghostTiles, FRAME_COUNT * TILE_PX, TILE_PX);
  if (!grey) return;
  const ctx = grey.context;
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
  grey.refresh();
  for (let f = 0; f < FRAME_COUNT; f++) grey.add(f, 0, f * TILE_PX, 0, TILE_PX, TILE_PX);
}

/** Grey range of the ghost texture (dark outline pixels -> lo, white -> hi). */
const GHOST_GREY = { lo: 110, hi: 245 } as const;
