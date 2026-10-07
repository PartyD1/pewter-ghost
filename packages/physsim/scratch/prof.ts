import { search } from "../src/sim";
import { gapLevel } from "../src/fixtures";
const g = gapLevel(7, 13);
const a = search(g, { x: 0, y: 7 }, { x0: g.w - 1 }, { capMs: 30000 });
console.log(a.nodes, a.visited, a.ms);
