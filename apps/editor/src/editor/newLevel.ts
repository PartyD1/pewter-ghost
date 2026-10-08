/**
 * The level a new session opens on: the old Pewter Platformer default map.
 *
 * pewterPlatformerDefaultMap.json next to this file is a verbatim copy of
 * pewter-platfomer public/phaserAssets/pewterPlatformerDefaultMap.json (same
 * md5 as the public/phaserAssets/ copy that Phaser loads for the backdrop).
 * The old editor opened on this map (editorScene.ts:487-525): a full grass
 * row 15 and dirt rows 16-19 across all 200 columns, nothing else. Its
 * Ground_Layer and Collectables_Layer go through the old-save importer
 * (level/save.ts importV1) in the shape the old Save wrote ({x, y, index} per
 * non-empty tile, index = Tiled gid = Phaser tile index), so every tile is
 * authored by PERSON, like a level the person built in the old editor.
 *
 * Added on top (new elements, no old source): the start marker above the
 * ground (DEFAULT_START) and a goal flag near the far end, a template entity
 * that belongs to nobody.
 */
import { AUTHOR, LEVEL_H, LEVEL_W, type LevelSnapshot, type Point } from "../contracts";
import { DEFAULT_START } from "../level/LevelModel";
import { importV1 } from "../level/save";
import { emptySnapshot } from "../level/snapshot";
import defaultMap from "./pewterPlatformerDefaultMap.json";

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

/** One old-map layer as the old Save's sparse tile list (gid 0 = empty). */
function layerTiles(name: string): { x: number; y: number; index: number }[] {
  const layer = (defaultMap.layers as TiledTileLayer[]).find((l) => l.name === name);
  if (!layer?.data) return [];
  const out: { x: number; y: number; index: number }[] = [];
  layer.data.forEach((gid, i) => {
    if (gid > 0) out.push({ x: i % layer.width, y: Math.floor(i / layer.width), index: gid });
  });
  return out;
}

export function starterSnapshot(opts: StarterOptions = {}): LevelSnapshot {
  const w = opts.w ?? LEVEL_W;
  const h = opts.h ?? LEVEL_H;
  const start = opts.start ?? DEFAULT_START;
  const res = importV1(
    { version: 1, groundTiles: layerTiles("Ground_Layer"), collectablesTiles: layerTiles("Collectables_Layer") },
    { w, h },
  );
  const s: LevelSnapshot = res.ok ? res.snapshot : emptySnapshot(w, h, start);
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
