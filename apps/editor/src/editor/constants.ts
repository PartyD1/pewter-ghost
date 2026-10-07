/**
 * Editor-wide constants: texture keys, sprite frames, render depths.
 * Pure (no Phaser import) so tests and the ghost layer can read them.
 */
import { TILE, TILE_PX, type EntityKind, type TileId } from "../contracts";

export { TILE_PX };

/** Asset keys loaded by LoadingScene. */
export const ASSET = {
  /** Brackeys/Pewter 15-frame strip (16 px). */
  brackeys: "pewter-tileset",
  /** Kenney sheet (18 px frames, 20 x 16). */
  kenney: "kenney-tiles",
  pellets: "pellets",
  /** Composite 16 px texture built at boot; frame index == TileId for terrain. */
  tiles: "pg-tiles",
  /** 16x16 grid cell texture for the editing grid. */
  grid: "pg-grid",
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
 */
export const DEPTH = {
  background: 0,
  grid: 5,
  tiles: 10,
  entities: 20,
  markers: 25,
  ghost: 30,
  ghostCaption: 35,
  cursor: 40,
  player: 50,
  pellets: 55,
  hud: 100,
} as const;

/** Scene keys. */
export const SCENE = { loading: "LoadingScene", editor: "EditorScene", ui: "UIScene" } as const;

export const SKY_COLOR = 0x8fd3ff;
