import { search } from "@physsim/sim";
import { gapLevel } from "@physsim/fixtures";
for (const [r, G] of [[0,8],[0,9],[0,10],[7,11],[7,12],[7,13],[3,11],[3,12]]) {
const g = gapLevel(r, G);
const a = search(g, { x: 0, y: 7 }, { x0: g.w - 1 }, { capMs: 30000, xRange: [0, g.w - 1] });
console.log(r, G, a.found, a.exhausted, a.nodes, a.ms.toFixed(0));
}
