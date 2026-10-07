/**
 * Asset loading and the composite 16 px texture.
 *
 * The old editor drew terrain, collectables, enemies and the knight from the
 * 15-frame Brackeys strip (pewterPlatformerTilesetExtended.png, 16 px). Its
 * frame for tile id 1 ("Block 1") is blank, and it has no flag or sign, so
 * those come from the Kenney sheet already in public/ (18 px frames,
 * resampled to 16). Everything is copied once into one canvas texture whose
 * frame index equals the model's TileId for terrain.
 */
import Phaser from "phaser";
import { ASSET, FRAME_COUNT, FRAME_SOURCES, KENNEY_PX, TILE_PX } from "./constants";

export function preloadAssets(scene: Phaser.Scene): void {
  scene.load.setPath("phaserAssets/");
  scene.load.image(ASSET.brackeys, "pewterPlatformerTilesetExtended.png");
  scene.load.image(ASSET.kenney, "tilemap_packed.png");
  scene.load.spritesheet(ASSET.pellets, "pellets.png", { frameWidth: 16, frameHeight: 16 });
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

/** Build `pg-tiles` (composite) and `pg-grid`. Safe to call twice. */
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
  if (!textures.exists(ASSET.grid)) {
    const g = textures.createCanvas(ASSET.grid, TILE_PX, TILE_PX);
    if (!g) throw new Error("could not create the grid texture");
    const ctx = g.context;
    ctx.fillStyle = "rgba(20, 40, 70, 0.11)";
    ctx.fillRect(0, 0, TILE_PX, 1);
    ctx.fillRect(0, 1, 1, TILE_PX - 1);
    g.refresh();
  }
}
