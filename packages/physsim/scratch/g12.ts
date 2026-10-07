import { search, replay } from "@physsim/sim";
import { gapLevel } from "@physsim/fixtures";
const g = gapLevel(0, Number(process.argv[2]));
const a = search(g, { x: 0, y: 7 }, { x0: g.w - 1 }, { capMs: 30000, xRange: [0, g.w-1] });
console.log(a.found, a.path.map(p=>`${p.x},${p.y}`).join(" "));
const t = replay(g, {x:0,y:7}, a.inputs!);
t.forEach((r,i)=>{ if (i<60) console.log(i, JSON.stringify(a.inputs![i]), r.map(v=>+v.toFixed(1)).join(" ")); });
