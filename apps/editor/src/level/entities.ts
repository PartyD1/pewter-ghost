/**
 * Entity helpers (G-06 pure part): kinds, ids and enemy patrol spans.
 *
 * Patrol span: an enemy standing at (x, y) walks along the floor row y + 1.
 * Its span is the contiguous run of solid floor tiles containing x whose cell
 * above (the walking row y) is empty. Pure and Phaser-free so the renderer,
 * the ASCII window, the validator and the playtest agent all agree.
 */
import {
  COLLECTABLE_KINDS,
  ENEMY_KINDS,
  type Entity,
  type EntityKind,
} from "../contracts";

export const ENTITY_KINDS: readonly EntityKind[] = [
  "coin",
  "fruit",
  "slime",
  "ultraslime",
  "flag",
  "sign",
];

export const isEntityKind = (k: unknown): k is EntityKind =>
  typeof k === "string" && (ENTITY_KINDS as readonly string[]).includes(k);

export const isEnemyKind = (k: EntityKind): boolean => ENEMY_KINDS.has(k);
export const isCollectableKind = (k: EntityKind): boolean => COLLECTABLE_KINDS.has(k);

/** Minimal read access needed to compute a patrol. LevelModel satisfies it. */
export interface SolidReader {
  readonly w: number;
  readonly h: number;
  isSolid(x: number, y: number): boolean;
}

/**
 * Inclusive patrol range [left, right] for an enemy standing at (x, y), or
 * undefined when there is no floor directly below it (it would fall) or it is
 * embedded in a solid tile.
 */
export function computePatrol(
  level: SolidReader,
  x: number,
  y: number,
): [number, number] | undefined {
  if (x < 0 || x >= level.w || y < 0 || y >= level.h) return undefined;
  if (level.isSolid(x, y)) return undefined;
  const fy = y + 1;
  if (!level.isSolid(x, fy)) return undefined;
  const walkable = (cx: number) =>
    cx >= 0 && cx < level.w && level.isSolid(cx, fy) && !level.isSolid(cx, y);
  let left = x;
  while (walkable(left - 1)) left--;
  let right = x;
  while (walkable(right + 1)) right++;
  return [left, right];
}

export const samePatrol = (
  a: [number, number] | undefined,
  b: [number, number] | undefined,
): boolean => (a === undefined ? b === undefined : b !== undefined && a[0] === b[0] && a[1] === b[1]);

export function cloneEntity(e: Entity): Entity {
  const c: Entity = { id: e.id, kind: e.kind, x: e.x, y: e.y };
  if (e.patrol) c.patrol = [e.patrol[0], e.patrol[1]];
  if (e.text !== undefined) c.text = e.text;
  return c;
}

/** Numeric suffix of an id like "e42" (for continuing a counter after load). */
export function idCounterOf(id: string, prefix = "e"): number {
  if (!id.startsWith(prefix)) return 0;
  const n = Number(id.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}
