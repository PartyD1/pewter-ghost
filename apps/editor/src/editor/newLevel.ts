/**
 * The level a new session opens on: the old Pewter Platformer default map.
 *
 * apps/editor/assets/pewterPlatformerDefaultMap.json (served at
 * phaserAssets/ by the vite config) is the old Pewter
 * Platformer's Tiled map; Phaser loads it for the backdrop and this file
 * reads its ground layer (one copy, imported from here).
 * The old editor opened on this map (editorScene.ts:487-525): a full grass
 * row 15 and dirt rows 16-19 across all 200 columns, nothing else. Its
 * Ground_Layer is stamped in as is (Tiled gid = Phaser tile index), so every
 * tile is authored by PERSON, like a level the person built by hand.
 *
 * Added on top (new elements, no old source): the start marker above the
 * ground (DEFAULT_START) and a goal flag near the far end, a template entity
 * that belongs to nobody.
 */
import { AUTHOR, LEVEL_H, LEVEL_W, TILE, type LevelSnapshot, type Point } from "../contracts";
import { DEFAULT_START } from "../level/LevelModel";
import { emptySnapshot } from "../level/snapshot";
import defaultMap from "../../assets/pewterPlatformerDefaultMap.json";

export interface StarterOptions {
  w?: number;
  h?: number;
  start?: Point;
  /** Goal flag column; default w - 4. */
  goalX?: number;
}

interface TiledTileLayer {
  name: string;
  width: number;
  data?: number[];
}

/** Terrain tile ids the editor knows (Tiled gid = Phaser tile index). */
const TERRAIN = new Set<number>([TILE.BLOCK, TILE.GRASS_HALF, TILE.DIRT, TILE.GRASS, TILE.QUESTION]);

/** Stamp the default map's Ground_Layer into a snapshot, every tile authored by PERSON. */
function stampGround(s: LevelSnapshot): void {
  const layer = (defaultMap.layers as TiledTileLayer[]).find((l) => l.name === "Ground_Layer");
  layer?.data?.forEach((gid, i) => {
    const x = i % layer.width;
    const y = Math.floor(i / layer.width);
    if (!TERRAIN.has(gid) || x >= s.w || y >= s.h) return;
    s.cells[y * s.w + x] = gid;
    s.authors[y * s.w + x] = AUTHOR.PERSON;
  });
}

export function starterSnapshot(opts: StarterOptions = {}): LevelSnapshot {
  const w = opts.w ?? LEVEL_W;
  const h = opts.h ?? LEVEL_H;
  const start = opts.start ?? DEFAULT_START;
  const s: LevelSnapshot = emptySnapshot(w, h, start);
  stampGround(s);
  s.start = { ...start };
  // Goal flag standing on the ground near the far end (template: author NONE).
  const goalX = Math.max(0, Math.min(w - 1, opts.goalX ?? w - 4));
  let groundY = -1;
  for (let y = 1; y < h; y++) {
    if (s.cells[y * w + goalX] !== 0) {
      groundY = y;
      break;
    }
  }
  if (groundY > 0 && !s.entities.some((e) => e.x === goalX && e.y === groundY - 1)) {
    let n = s.entities.length + 1;
    while (s.entities.some((e) => e.id === `e${n}`)) n++;
    const id = `e${n}`;
    s.entities.push({ id, kind: "flag", x: goalX, y: groundY - 1 });
    s.entityAuthors[id] = AUTHOR.NONE;
  }
  return s;
}
