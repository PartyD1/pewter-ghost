# @jump-tables

One answer to "can the knight make this?", precomputed from the Player
Physics Fork's frame-accurate jump solver (`apps/editor/src/player/jumpSolver.ts`).

```ts
import { knightLimits, canReach, maxGap, arcCells, arcCoins } from "@jump-tables";

knightLimits();          // { maxGapStand: 8, maxGapRun: 11, maxRise: 6 }  (NORMAL tier)
canReach(9, 0);          // 9 empty tiles, same height, full run-up -> true
canReach(9, 0, false);   // ... from a standstill -> false
maxGap(-3, true);        // widest gap onto a ledge 3 rows HIGHER (y is down)
arcCoins(6, 0);          // one coin per gap column on the knight's arc
arcCells(6, 0);          // every airborne cell the knight's centre passes through
```

Conventions: tiles, y down; `gap`/`dx` = empty columns between the two
surfaces; `dy` = target row minus takeoff row; arc offsets are relative to the
takeoff cell and the landing cell is `(gap + 1, dy)`. Tiers: GUARANTEED,
NORMAL (design default), EXPERT, ULTRA (physical bound).

Regenerate after any change under `apps/editor/src/player/`:

```sh
npx tsx packages/jump-tables/src/export.ts          # writes src/tables.json
npx tsx packages/jump-tables/src/export.ts --check  # exit 1 if stale
```

`build.test.ts` fails when `tables.json` is stale. `caps.test.ts` pins the
comparison with the audit's `caps.json` (differences explained in
`src/build.ts`). `arcs.test.ts` replays every arc through Phaser's real tile
separation and checks it lands and touches every coin.
