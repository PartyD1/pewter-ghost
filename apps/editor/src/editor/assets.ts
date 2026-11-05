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
import { ASSET, FRAME_COUNT, TILE_PX } from "./constants";
import { paintComposite, paintGhost } from "./tileComposite";

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

/** Build `pg-tiles` (the composite) and `pg-tiles-ghost`. Safe to call twice. The pixels come from tileComposite.ts (shared with the replay viewer). */
export function buildTextures(scene: Phaser.Scene): void {
  const textures = scene.textures;
  if (!textures.exists(ASSET.tiles)) {
    const canvas = textures.createCanvas(ASSET.tiles, FRAME_COUNT * TILE_PX, TILE_PX);
    if (!canvas) throw new Error("could not create the tile texture");
    const brackeys = textures.get(ASSET.brackeys).getSourceImage() as CanvasImageSource;
    const kenney = textures.get(ASSET.kenney).getSourceImage() as CanvasImageSource;
    paintComposite(canvas.context, brackeys, kenney);
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
  paintGhost(grey.context, src);
  grey.refresh();
  for (let f = 0; f < FRAME_COUNT; f++) grey.add(f, 0, f * TILE_PX, 0, TILE_PX, TILE_PX);
}
