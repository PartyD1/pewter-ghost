/**
 * Editor-wide constants: texture keys, sprite frames, render depths.
 * Pure (no Phaser import) so tests and the ghost layer can read them.
 */
import { TILE, TILE_PX, type EntityKind, type TileId } from "../contracts";

export { TILE_PX };

/**
 * Asset keys loaded by LoadingScene. The first five are the old Pewter
 * Platformer keys (pewter-platfomer src/phaser/loadingScene.ts), unchanged.
 */
export const ASSET = {
  /** Brackeys/Pewter 15-frame strip (16 px), old key "tileset". */
  brackeys: "tileset",
  /** pewterPlatformerTilesetBackgroundExtras.png (2 frames of 16 px), old key "extras-tileset". */
  extras: "extras-tileset",
  /** pewterPlatformerDefaultMap.json (Tiled), old key "defaultMap". */
  defaultMap: "defaultMap",
  /** The Brackeys strip again as 16 px spritesheet frames, old key "spritesheet". */
  spritesheet: "spritesheet",
  pellets: "pellets",
  /** Kenney sheet (18 px frames, 20 x 16): only the Block, Flag and Sign frames. */
  kenney: "kenney-tiles",
  /** Composite 16 px texture built at boot; frame index == TileId for terrain. */
  tiles: "pg-tiles",
} as const;

/**
 * Frames of the composite `pg-tiles` texture. Terrain frames equal their
 * TileId, so a tilemap tileset with firstgid 0 maps model ids directly.
 */
export const FRAME = {
  EMPTY: 0,
  BLOCK: TILE.BLOCK, // 1, Kenney brick block (the Brackeys frame for id 1 is blank)
  COIN: 2,
  FRUIT: 3,
  GRASS_HALF: TILE.GRASS_HALF, // 4
  DIRT: TILE.DIRT, // 5
  GRASS: TILE.GRASS, // 6
  QUESTION: TILE.QUESTION, // 7
  ULTRASLIME: 8,
  SLIME: 9,
  FLAG: 10,
  SIGN: 11,
  KNIGHT: 12,
  START: 13,
} as const;
export const FRAME_COUNT = 16;

/**
 * Where each composite frame comes from. `brackeys` frames are indexes into
 * the 240x16 strip; `kenney` frames are [col, row] in the 18 px Kenney sheet
 * (resampled to 16 px). `start` is drawn procedurally.
 */
export const FRAME_SOURCES: Record<number, { brackeys: number } | { kenney: [number, number] } | { draw: "start" }> = {
  [FRAME.BLOCK]: { kenney: [6, 0] },
  [FRAME.COIN]: { brackeys: 1 },
  [FRAME.FRUIT]: { brackeys: 2 },
  [FRAME.GRASS_HALF]: { brackeys: 3 },
  [FRAME.DIRT]: { brackeys: 4 },
  [FRAME.GRASS]: { brackeys: 5 },
  [FRAME.QUESTION]: { brackeys: 6 },
  [FRAME.ULTRASLIME]: { brackeys: 7 },
  [FRAME.SLIME]: { brackeys: 8 },
  [FRAME.FLAG]: { kenney: [11, 5] },
  [FRAME.SIGN]: { kenney: [6, 4] },
  [FRAME.KNIGHT]: { brackeys: 14 },
  [FRAME.START]: { draw: "start" },
};

export const KENNEY_PX = 18;

export const ENTITY_FRAME: Record<EntityKind, number> = {
  coin: FRAME.COIN,
  fruit: FRAME.FRUIT,
  slime: FRAME.SLIME,
  ultraslime: FRAME.ULTRASLIME,
  flag: FRAME.FLAG,
  sign: FRAME.SIGN,
};

export const tileFrame = (tile: number): number => (tile === TILE.EMPTY ? -1 : tile);

export const TERRAIN_IDS: readonly TileId[] = [TILE.BLOCK, TILE.GRASS_HALF, TILE.DIRT, TILE.GRASS, TILE.QUESTION];

/**
 * Render order. The ghost layer (another module) should draw at DEPTH.ghost:
 * above tiles and entities, below the cursor.
 *
 * As in the old editor (editorScene.ts:509-525, 564-566), the Background_Layer
 * of the default map is at the bottom and the dotted grid is drawn ABOVE every
 * tile: there the tile layers were at depth 0 and the grid at 10; here the
 * level's tiles and entity sprites sit at 10-25, so the grid is just above them.
 */
export const DEPTH = {
  background: 0,
  tiles: 10,
  entities: 20,
  markers: 25,
  grid: 27,
  ghost: 30,
  ghostCaption: 35,
  cursor: 40,
  player: 50,
  pellets: 55,
  hud: 100,
} as const;

/** Scene keys. */
export const SCENE = { loading: "LoadingScene", editor: "EditorScene", ui: "UIScene" } as const;

/**
 * Old Pewter Platformer camera (editorScene.ts:76-78): zoom 2.25 (= 720 / 320,
 * so the 20-row level exactly fills the 720 px canvas), wheel range 2.25-10.
 */
export const OLD_ZOOM = { min: 2.25, max: 10, start: 2.25 } as const;

/**
 * Old minimap (editorScene.ts:84, 2342-2363): a second camera at canvas
 * (10, 10), the whole level at zoom 0.15, background 0x002244.
 */
export const MINIMAP = { x: 10, y: 10, zoom: 0.15, background: 0x002244 } as const;

/**
 * The old right panel covers the canvas from x = 925 to the right edge
 * (UIScene.ts:140: a 340 px panel centred at x 1095 on the 1280 px canvas).
 * The camera treats that strip as off-screen for the ghost (viewTiles, nudges,
 * edge arrow), so a suggestion is never "visible" only under the panel.
 */
export const OLD_PANEL_LEFT_PX = 925;
export const OLD_CANVAS = { w: 1280, h: 720 } as const;
