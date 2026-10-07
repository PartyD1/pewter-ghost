/**
 * The palette's contents (pure): terrain, collectables, enemies, markers and
 * the eraser. Frames index the composite `pg-tiles` texture.
 */
import { TILE, type EntityKind, type TileId } from "../contracts";
import { ENTITY_FRAME, FRAME } from "../editor/constants";
import type { Brush } from "../editor/modes";

export type PaletteGroup = "terrain" | "collectables" | "enemies" | "markers" | "tools";

export interface PaletteItem {
  id: string;
  label: string;
  group: PaletteGroup;
  /** Frame of pg-tiles for the swatch; -1 = icon only. */
  frame: number;
  /** Brush to select, or "erase" for the eraser (switches to Erase mode). */
  action: Brush | "erase";
  hint?: string;
}

const tile = (id: string, label: string, t: TileId): PaletteItem => ({
  id,
  label,
  group: "terrain",
  frame: t,
  action: { kind: "tile", tile: t },
});

const entity = (kind: EntityKind, label: string, group: PaletteGroup, hint?: string): PaletteItem => ({
  id: kind,
  label,
  group,
  frame: ENTITY_FRAME[kind],
  action: { kind: "entity", entity: kind },
  hint,
});

export const PALETTE_ITEMS: readonly PaletteItem[] = [
  tile("block", "Block", TILE.BLOCK),
  tile("grass_half", "Grass half", TILE.GRASS_HALF),
  tile("dirt", "Dirt", TILE.DIRT),
  tile("grass", "Grass", TILE.GRASS),
  tile("question", "Question", TILE.QUESTION),
  entity("coin", "Coin", "collectables"),
  entity("fruit", "Fruit", "collectables", "Restores a heart"),
  entity("slime", "Slime", "enemies", "Walks its floor, shoots ahead"),
  entity("ultraslime", "Ultra slime", "enemies", "Chases when near, bursts after a flash"),
  entity("flag", "Goal flag", "markers", "One per level: reaching it wins"),
  entity("sign", "Sign", "markers", "Shows its text in Play"),
  { id: "start", label: "Start", group: "markers", frame: FRAME.START, action: { kind: "start" }, hint: "Where the knight starts" },
  { id: "eraser", label: "Eraser", group: "tools", frame: -1, action: "erase", hint: "Erase mode (3)" },
];

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  terrain: "Terrain",
  collectables: "Collectables",
  enemies: "Enemies",
  markers: "Markers",
  tools: "Tools",
};

export const GROUP_ORDER: readonly PaletteGroup[] = ["terrain", "collectables", "enemies", "markers", "tools"];

export function itemsInGroup(group: PaletteGroup): PaletteItem[] {
  return PALETTE_ITEMS.filter((i) => i.group === group);
}

/** Which item a brush corresponds to (sign text is ignored). */
export function itemForBrush(b: Brush): PaletteItem | undefined {
  return PALETTE_ITEMS.find((i) => {
    if (i.action === "erase") return false;
    const a = i.action;
    if (a.kind !== b.kind) return false;
    if (a.kind === "tile" && b.kind === "tile") return a.tile === b.tile;
    if (a.kind === "entity" && b.kind === "entity") return a.entity === b.entity;
    return true;
  });
}

/** Short lower-case name for the mode indicator, e.g. "grass", "sign". */
export function brushLabel(b: Brush): string {
  return (itemForBrush(b)?.label ?? "brush").toLowerCase();
}

/** Highlighted palette item id for a mode/brush. */
export function activeItemId(mode: string, b: Brush): string | undefined {
  if (mode === "erase") return "eraser";
  if (mode !== "paint") return undefined;
  return itemForBrush(b)?.id;
}
