/**
 * Coordinate accuracy: do the answer's cells land where the ASCII window
 * says they should?
 *
 * Checks, per item and per answer:
 *  - inWindow  every item is inside the window (window-relative, 0..w-1 /
 *              0..h-1). Items outside that WOULD be inside after subtracting
 *              the origin are counted as `levelCoords`: the model answered
 *              in level coordinates.
 *  - free      adds and entities land on empty cells (not over authored
 *              terrain or another entity); removes target something.
 *  - anchored  every connected group of added tiles touches existing terrain
 *              or sits within the knight's reach of a standable surface
 *              (not floating in the sky or junk on the bottom row).
 *  - grounded  enemies stand on solid ground (in the merged level).
 *  - local     the answer is near the action: within `radius` tiles (one
 *              running jump) of the frontier, a recent placement or (patrol)
 *              the blocking point.
 *
 * `accurate` = every check passed. `share` = passed item checks / item checks.
 */
import {
  ENEMY_KINDS,
  type FillRequest,
  type KnightLimits,
  type LevelSnapshot,
  type ModelAnswer,
  type Point,
} from "../../../apps/editor/src/contracts";

export interface CoordScore {
  items: number;
  inWindow: number;
  /** Items outside the window that fit after subtracting the origin. */
  levelCoords: number;
  free: number;
  /** Item checks that passed / item checks made (inWindow + free per item). */
  share: number;
  /** Added-tile groups and how many are anchored. */
  groups: number;
  anchoredGroups: number;
  enemies: number;
  groundedEnemies: number;
  /** Chebyshev distance from the answer's bounding box to the nearest focus point. */
  focusDistance: number;
  local: boolean;
  accurate: boolean;
  issues: string[];
}

export interface CoordOptions {
  /** Max distance (tiles) from the action for `local`. Default knight.maxGapRun + 1 (one jump past the last placement). */
  radius?: number;
}

const key = (x: number, y: number) => `${x},${y}`;

/** Points the answer should be near, in LEVEL coordinates. */
export function focusPoints(req: Pick<FillRequest, "origin" | "frontier" | "recent" | "blockedAt" | "mode">): Point[] {
  const o = req.origin;
  if (req.mode === "patrol" && req.blockedAt) return [{ x: req.blockedAt.x + o.x, y: req.blockedAt.y + o.y }];
  const pts: Point[] = [{ x: req.frontier.x + o.x, y: req.frontier.y + o.y }];
  for (const r of req.recent) pts.push({ x: r.x + o.x, y: r.y + o.y });
  if (req.blockedAt) pts.push({ x: req.blockedAt.x + o.x, y: req.blockedAt.y + o.y });
  return pts;
}

/** 8-connected groups of points. */
export function groups(points: readonly Point[]): Point[][] {
  const left = new Map(points.map((p) => [key(p.x, p.y), p]));
  const out: Point[][] = [];
  for (const p of points) {
    if (!left.has(key(p.x, p.y))) continue;
    const g: Point[] = [];
    const stack = [p];
    left.delete(key(p.x, p.y));
    while (stack.length) {
      const c = stack.pop()!;
      g.push(c);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = key(c.x + dx, c.y + dy);
          const n = left.get(k);
          if (n) {
            left.delete(k);
            stack.push(n);
          }
        }
    }
    out.push(g);
  }
  return out;
}

export function scoreCoords(
  answer: ModelAnswer,
  req: Pick<FillRequest, "origin" | "size" | "frontier" | "recent" | "blockedAt" | "mode" | "knight">,
  level: LevelSnapshot,
  o: CoordOptions = {},
): CoordScore {
  const { origin, size } = req;
  const knight: KnightLimits = req.knight;
  const radius = o.radius ?? knight.maxGapRun + 1;
  const issues: string[] = [];
  const W = level.w;
  const solidAt = (x: number, y: number) => x >= 0 && y >= 0 && x < level.w && y < level.h && level.cells[y * W + x] !== 0;
  const entityAt = new Set(level.entities.map((e) => key(e.x, e.y)));
  const inWin = (p: { x: number; y: number }) =>
    Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < size.w && p.y < size.h;
  const fitsAsLevel = (p: { x: number; y: number }) => inWin({ x: p.x - origin.x, y: p.y - origin.y });

  const isFix = answer.kind === "fix";
  const all = [
    ...answer.adds.map((a) => ({ what: "add" as const, p: a })),
    ...(isFix ? answer.removes.map((r) => ({ what: "remove" as const, p: r })) : []),
    ...answer.entities.map((e) => ({ what: "entity" as const, p: e, kind: e.kind })),
  ];
  let inWindow = 0;
  let levelCoords = 0;
  let free = 0;
  let checks = 0;
  let passed = 0;
  const addCells: Point[] = [];
  const addSet = new Set<string>();
  const levelPts: Point[] = [];
  for (const it of all) {
    checks += 2;
    if (!inWin(it.p)) {
      if ((origin.x || origin.y) && fitsAsLevel(it.p)) levelCoords++;
      continue;
    }
    inWindow++;
    passed++;
    const L = { x: it.p.x + origin.x, y: it.p.y + origin.y };
    levelPts.push(L);
    let ok: boolean;
    if (it.what === "remove") ok = solidAt(L.x, L.y) || entityAt.has(key(L.x, L.y));
    else ok = !solidAt(L.x, L.y) && !entityAt.has(key(L.x, L.y));
    if (it.what === "entity" && addSet.has(key(L.x, L.y))) ok = false;
    if (ok) {
      free++;
      passed++;
    }
    if (it.what === "add" && ok) {
      addCells.push(L);
      addSet.add(key(L.x, L.y));
    }
  }
  if (inWindow < all.length) issues.push(`${all.length - inWindow} item(s) outside the window`);
  if (levelCoords) issues.push(`${levelCoords} item(s) look like level coordinates`);
  if (free < inWindow) issues.push(`${inWindow - free} item(s) on occupied cells (or removes on empty ones)`);

  // Anchoring of added tile groups.
  const removed = new Set(isFix ? answer.removes.map((r) => key(r.x + origin.x, r.y + origin.y)) : []);
  const existingSolid = (x: number, y: number) => solidAt(x, y) && !removed.has(key(x, y));
  const standables: Point[] = [];
  const x0 = Math.max(0, origin.x - knight.maxGapRun - 2);
  const x1 = Math.min(level.w - 1, origin.x + size.w + knight.maxGapRun + 1);
  for (let y = 1; y < level.h; y++)
    for (let x = x0; x <= x1; x++) if (existingSolid(x, y) && !existingSolid(x, y - 1)) standables.push({ x, y });
  const gs = groups(addCells);
  let anchoredGroups = 0;
  for (const g of gs) {
    const touches = g.some((c) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && existingSolid(c.x + dx, c.y + dy)) return true;
      return false;
    });
    const reachable =
      touches ||
      g.some((c) =>
        standables.some((s) => {
          const dx = Math.abs(c.x - s.x);
          const up = s.y - c.y; // > 0: the group is above the surface
          return dx <= knight.maxGapRun + 1 && up <= knight.maxRise;
        }),
      );
    // The bottom row is a death pit: a lone group there with nothing to touch is junk.
    const bottomJunk = !touches && g.every((c) => c.y >= level.h - 1);
    if (reachable && !bottomJunk) anchoredGroups++;
  }
  if (anchoredGroups < gs.length) issues.push(`${gs.length - anchoredGroups} tile group(s) floating out of reach`);

  // Enemies stand on ground in the merged level.
  const mergedSolid = (x: number, y: number) => addSet.has(key(x, y)) || existingSolid(x, y);
  let enemies = 0;
  let groundedEnemies = 0;
  for (const e of answer.entities) {
    if (!ENEMY_KINDS.has(e.kind) || !inWin(e)) continue;
    enemies++;
    if (mergedSolid(e.x + origin.x, e.y + origin.y + 1)) groundedEnemies++;
  }
  if (groundedEnemies < enemies) issues.push(`${enemies - groundedEnemies} enemy(ies) with no floor under them`);

  // Locality.
  const focus = focusPoints(req);
  let focusDistance = Infinity;
  for (const p of levelPts)
    for (const f of focus) focusDistance = Math.min(focusDistance, Math.max(Math.abs(p.x - f.x), Math.abs(p.y - f.y)));
  if (!levelPts.length) focusDistance = all.length ? Infinity : 0;
  const local = focusDistance <= radius;
  if (!local && levelPts.length) issues.push(`nearest item is ${focusDistance} tiles from the action (> ${radius})`);

  const accurate =
    all.length > 0 &&
    inWindow === all.length &&
    free === inWindow &&
    anchoredGroups === gs.length &&
    groundedEnemies === enemies &&
    local;
  return {
    items: all.length,
    inWindow,
    levelCoords,
    free,
    share: checks ? passed / checks : 1,
    groups: gs.length,
    anchoredGroups,
    enemies,
    groundedEnemies,
    focusDistance: Number.isFinite(focusDistance) ? focusDistance : -1,
    local,
    accurate,
    issues,
  };
}
