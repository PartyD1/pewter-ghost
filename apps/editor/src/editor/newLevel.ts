/**
 * The level a new session opens on: a start platform under the knight and a
 * goal platform with the flag at the far end ("Canvas. Flat ground, a start
 * marker, and a goal marker at the chosen length."). Everything in between is
 * empty for the person (and Ghost) to draw. Template cells carry author NONE,
 * so they never count as the person's or Ghost's work.
 */
import { AUTHOR, LEVEL_H, LEVEL_W, TILE, type LevelSnapshot, type Point } from "../contracts";
import { DEFAULT_START } from "../level/LevelModel";
import { emptySnapshot } from "../level/snapshot";

export interface StarterOptions {
  w?: number;
  h?: number;
  start?: Point;
  /** Width of the start and goal platforms in tiles. */
  platform?: number;
  /** Goal flag column; default w - 4. */
  goalX?: number;
}

export function starterSnapshot(opts: StarterOptions = {}): LevelSnapshot {
  const w = opts.w ?? LEVEL_W;
  const h = opts.h ?? LEVEL_H;
  const start = opts.start ?? DEFAULT_START;
  const platform = Math.max(1, Math.min(opts.platform ?? 12, Math.floor(w / 2)));
  const s = emptySnapshot(w, h, start);
  const groundY = Math.min(h - 1, start.y + 1);
  const put = (x: number, y: number, tile: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    s.cells[y * w + x] = tile;
    s.authors[y * w + x] = AUTHOR.NONE;
  };
  const ground = (x0: number, x1: number) => {
    for (let x = x0; x <= x1; x++) {
      put(x, groundY, TILE.GRASS);
      for (let y = groundY + 1; y < h; y++) put(x, y, TILE.DIRT);
    }
  };
  ground(0, platform - 1);
  ground(w - platform, w - 1);
  const goalX = Math.max(w - platform, Math.min(w - 1, opts.goalX ?? w - 4));
  if (groundY - 1 >= 0) {
    s.entities.push({ id: "e1", kind: "flag", x: goalX, y: groundY - 1 });
    s.entityAuthors.e1 = AUTHOR.NONE;
  }
  return s;
}
