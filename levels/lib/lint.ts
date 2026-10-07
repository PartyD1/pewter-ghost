/**
 * Placement rules a reference level must follow (prompts/brief/placement.md),
 * checked at build time because the playtest agent does not model enemies:
 *
 *  - the start and the flag stand on ground;
 *  - every enemy has a patrol of at least 4 tiles and does not sit within
 *    1 tile of a jump landing;
 *  - collectables and signs are not buried (an entity cell is never solid by
 *    construction, but a coin sealed in by tiles on all four sides is);
 *  - a rest at least every three screens (72 columns), counting from the
 *    start and up to the flag.
 *
 * Fixtures deliberately break these, so only references are linted.
 */
import { analyzeWindow, chebyshev, fullRect, isSolid, SCREEN_COLS, type GridLike } from "@measure";
import { ENEMY_KINDS, type LevelSnapshot } from "../../apps/editor/src/contracts";

export const LINT = {
  minPatrol: 4,
  landingClearance: 1,
  maxColsWithoutRest: SCREEN_COLS * 3,
} as const;

export function lintLevel(snap: LevelSnapshot): string[] {
  const out: string[] = [];
  const g: GridLike = snap;
  const stands = (x: number, y: number) => !isSolid(g, x, y) && isSolid(g, x, y + 1);
  if (!stands(snap.start.x, snap.start.y)) out.push(`start (${snap.start.x},${snap.start.y}) is not standing on ground`);
  const flag = snap.entities.find((e) => e.kind === "flag");
  if (flag && !stands(flag.x, flag.y)) out.push(`flag (${flag.x},${flag.y}) is not standing on ground`);

  const a = analyzeWindow(g, snap.entities, fullRect(g));
  const landings = a.graph.transitions.filter((t) => t.kind !== "drop" && t.kind !== "step").map((t) => t.landing);
  for (const e of snap.entities) {
    if (ENEMY_KINDS.has(e.kind)) {
      const span = e.patrol ? e.patrol[1] - e.patrol[0] + 1 : 0;
      if (span < LINT.minPatrol) out.push(`${e.kind} ${e.id} at (${e.x},${e.y}) patrols ${span} tile(s); needs ${LINT.minPatrol}`);
      const l = landings.find((p) => chebyshev(p, e) <= LINT.landingClearance);
      if (l) out.push(`${e.kind} ${e.id} at (${e.x},${e.y}) sits on the landing at (${l.x},${l.y})`);
    } else if (
      isSolid(g, e.x - 1, e.y) &&
      isSolid(g, e.x + 1, e.y) &&
      isSolid(g, e.x, e.y - 1) &&
      isSolid(g, e.x, e.y + 1)
    )
      out.push(`${e.kind} ${e.id} at (${e.x},${e.y}) is sealed in by tiles`);
  }

  const rests = a.hits.filter((h) => h.tag === "rest").sort((p, q) => p.x0 - q.x0);
  const endX = flag ? flag.x : snap.w - 1;
  let last = snap.start.x;
  for (const r of rests) {
    if (r.x0 - last > LINT.maxColsWithoutRest)
      out.push(`no rest between columns ${last} and ${r.x0} (${r.x0 - last} columns; at most ${LINT.maxColsWithoutRest})`);
    last = Math.max(last, r.x1);
  }
  if (endX - last > LINT.maxColsWithoutRest)
    out.push(`no rest between columns ${last} and the end at ${endX} (${endX - last} columns)`);
  return out;
}
