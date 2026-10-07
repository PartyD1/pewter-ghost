import { search } from "../src/sim";
import { checkRules } from "../src/rules";
import { gridFromMatrix, gridToRows } from "../src/grid";
const W = 24, H = 12, gl = 8;
const run = (name: string, g: number[][]) => {
  const grid = gridFromMatrix(g);
  const r = checkRules(grid, { x: 0, y: 7 }, { x0: W - 1 });
  const ru = checkRules(grid, { x: 0, y: 7 }, { x0: W - 1 }, { tier: "ULTRA", arc: "none" });
  const a = search(grid, { x: 0, y: 7 }, { x0: W - 1 }, { capMs: 30000 });
  console.log(name.padEnd(28), "rules", r.ok, "rulesU", ru.ok, "| agent", a.found, a.exhausted, a.nodes, a.ms.toFixed(0), r.reason ?? "");
};
for (const G of [2, 3, 5, 7, 9, 11]) for (const h of [1, 2, 3, 4, 5]) {
  const g = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (y >= gl && !(x >= 8 && x < 8 + G)) ? 1 : 0));
  for (let x = 5; x < 8 + G + 2; x++) for (let y = 0; y <= gl - 1 - h; y++) g[y][x] = 1;
  run(`pit ${G} tunnel ${h}`, g);
}
for (const k of [4, 5, 6, 7, 8]) {
  const g = Array.from({ length: H }, (_, y) => Array.from({ length: W }, () => (y >= gl ? 1 : 0)));
  for (let y = gl - k; y < gl; y++) for (let x = 11; x <= 12; x++) if (y >= 0) g[y][x] = 1;
  run(`wall ${k}`, g);
}
