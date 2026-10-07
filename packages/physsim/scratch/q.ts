import { search } from "@physsim/sim";
import { checkRules } from "@physsim/rules";
import { gapLevel, tunnelLevel, wallLevel } from "@physsim/fixtures";
const g = gapLevel(7, 12);
let a = search(g, { x: 7, y: 7 }, { x0: g.w - 1 }, { capMs: 30000, xRange: [7, g.w - 1] });
console.log("window", a.found, a.exhausted, a.ms.toFixed(0));
a = search(g, { x: 7, y: 7 }, { x0: g.w - 1 }, { capMs: 30000 });
console.log("nowindow", a.found, a.ms.toFixed(0));
for (const [G,h] of [[7,2],[3,1],[5,3]]) { const t = tunnelLevel(G,h); console.log("tunnel",G,h, checkRules(t,{x:0,y:7},{x0:t.w-1},{arc:"sweep"}).ok, checkRules(t,{x:0,y:7},{x0:t.w-1},{arc:"none"}).ok); }
const w = wallLevel(7); a = search(w, {x:0,y:7}, {x0: w.w-1}, {capMs: 30000}); console.log("wall blocked", a.blockedAt, a.exhausted);
// sweep rules ok => agent
let n=0, bad=0, rok=0;
for (const r of [0,2,4,7]) for (let G=1; G<=12; G++) for (let rise=-4; rise<=6; rise++) {
  const lv = gapLevel(r,G,rise); const v = checkRules(lv,{x:0,y:7},{x0:lv.w-1}); n++;
  if (!v.ok) continue; rok++;
  const s = search(lv,{x:0,y:7},{x0:lv.w-1},{capMs:3000}); if (!s.found) { bad++; console.log("BAD", r,G,rise, s.timedOut); }
}
console.log({n, rok, bad});
