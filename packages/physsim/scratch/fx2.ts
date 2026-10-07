import { search } from "@physsim/sim";
import { checkRules } from "@physsim/rules";
import { FIXTURES, gapLevel } from "@physsim/fixtures";
for (const f of [...FIXTURES, { name: "gap9 standing", grid: gapLevel(0, 9), from: { x: 0, y: 7 }, to: { x0: 12 }, beatable: false, rules: false }]) {
  const r = checkRules(f.grid, f.from, f.to);
  const a = search(f.grid, f.from, f.to, { capMs: 30000 });
  const ok = r.ok === f.rules && a.found === f.beatable;
  console.log((ok ? "  " : "XX") + f.name.padEnd(32), "rules", r.ok, "agent", a.found, a.exhausted, a.nodes, a.ms.toFixed(0) + "ms", r.reason ?? "");
}
