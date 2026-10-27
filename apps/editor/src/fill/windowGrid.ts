/**
 * The request's window grid read back into tiles (window-relative). Shared by the
 * algorithm filler and the structure hint in the prompt; light on purpose, because
 * the prompt also runs in the proxy.
 */
import type { DetectGrid } from "@chunks";
import type { EntityKind, FillRequest } from "../contracts";
import {
  EMPTY_GLYPH,
  ENTITY_GLYPH,
  GHOST_GLYPH,
  gridRows,
  OUTSIDE_GLYPH,
  PATROL_GLYPH,
  PERSON_GLYPH,
  START_GLYPH,
} from "./window";

const TILE_BY_GLYPH = new Map<string, number>();
for (const [t, g] of Object.entries(PERSON_GLYPH)) TILE_BY_GLYPH.set(g, Number(t));
for (const [t, g] of Object.entries(GHOST_GLYPH)) TILE_BY_GLYPH.set(g, Number(t));
const ENTITY_BY_GLYPH = new Map<string, EntityKind>();
for (const [k, g] of Object.entries(ENTITY_GLYPH)) ENTITY_BY_GLYPH.set(g, k as EntityKind);

/** The request's window as tiles, a solid mask and entities (window-relative). */
export interface WindowGrid extends DetectGrid {
  tiles: Uint8Array;
  blocked: Uint8Array;
  solid: Uint8Array;
  entities: { kind: EntityKind; x: number; y: number }[];
}

/** Parse request.grid back into tiles. Null when the grid does not match request.size. */
export function parseWindowGrid(req: Pick<FillRequest, "grid" | "size">): WindowGrid | null {
  const rows = gridRows(req.grid);
  const { w, h } = req.size;
  if (rows.length !== h || rows.some((r) => r.length !== w)) return null;
  const tiles = new Uint8Array(w * h);
  const blocked = new Uint8Array(w * h);
  const solid = new Uint8Array(w * h);
  const entities: WindowGrid["entities"] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const g = row[x];
      const i = y * w + x;
      if (g === EMPTY_GLYPH || g === PATROL_GLYPH) continue;
      const t = TILE_BY_GLYPH.get(g) ?? (g === "X" || g === "x" ? 1 : undefined);
      if (t !== undefined) {
        tiles[i] = t;
        solid[i] = 1;
        continue;
      }
      if (g === OUTSIDE_GLYPH || g === START_GLYPH) {
        blocked[i] = 1;
        continue;
      }
      const kind = ENTITY_BY_GLYPH.get(g);
      if (kind) {
        entities.push({ kind, x, y });
        if (kind === "flag") blocked[i] = 1;
      }
    }
  });
  return { w, h, tiles, blocked, solid, entities };
}
