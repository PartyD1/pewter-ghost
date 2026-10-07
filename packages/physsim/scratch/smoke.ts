import { search, replay, Level } from "../src/sim";
import { gridFromMatrix } from "../src/grid";
import * as A from "/home/user/pewter-platfomer/audit-prototypes/playtest-agent/physsim.ts";
function gapLevel(r: number, G: number, rise = 0) {
  const W = r + 1 + G + 3, H = 12, gy = 8;
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  for (let x = 0; x <= r; x++) for (let y = gy; y < H; y++) g[y][x] = 1;
  for (let x = r + 1 + G; x < W; x++) for (let y = gy - rise; y < H; y++) g[y][x] = 1;
  return g;
}
for (const [r, G] of [[7,11],[7,12],[7,13],[0,8],[0,9],[0,10]]) {
  const m = gapLevel(r, G); const grid = gridFromMatrix(m);
  for (const weight of [1, 1.5, 3]) {
    const res = search(grid, { x: 0, y: 7 }, { x0: grid.w - 1 }, { capMs: 20000, weight });
    console.log(`r${r} G${G} w${weight}`, res.found, res.exhausted, res.timedOut, res.nodes, res.ms.toFixed(1), res.pass);
    if (res.found && weight === 1.5) {
      const mine = replay(grid, { x: 0, y: 7 }, res.inputs!);
      const theirs = A.replay(new A.Level(m), { x: 0, y: 7 }, res.inputs!);
      let md = 0; for (let i = 0; i < mine.length; i++) for (let j = 0; j < 5; j++) md = Math.max(md, Math.abs(mine[i][j] - theirs[i][j]));
      console.log("  parity vs audit max diff", md);
    }
  }
  const a = A.search(new A.Level(m), { x: 0, y: 7 }, { K: 4, qx: 4, qv: 32, goalCol: m[0].length - 1, maxExpand: 3_000_000 });
  console.log("  audit", a.found, a.exhausted, a.expanded, a.ms);
}
