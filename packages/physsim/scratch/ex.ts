import { search } from "../src/sim";
import { gridFromMatrix } from "../src/grid";
function gapLevel(r: number, G: number, rise = 0) {
  const W = r + 1 + G + 3, H = 12, gy = 8;
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  for (let x = 0; x <= r; x++) for (let y = gy; y < H; y++) g[y][x] = 1;
  for (let x = r + 1 + G; x < W; x++) for (let y = gy - rise; y < H; y++) g[y][x] = 1;
  return g;
}
for (const [r,G] of [[7,13],[0,11],[0,12],[3,12]]) {
const grid = gridFromMatrix(gapLevel(r, G));
for (const passes of [[{K:4,qx:4,qv:32}],[{K:2,qx:2,qv:32}],[{K:4,qx:2,qv:32}], [{K:2,qx:4,qv:32}]]) {
  const res = search(grid, { x: 0, y: 7 }, { x0: grid.w - 1 }, { capMs: 60000, passes, maxNodes: 1e8 });
  console.log(r,G,JSON.stringify(passes), res.found, res.exhausted, res.nodes, res.ms.toFixed(0));
}}
