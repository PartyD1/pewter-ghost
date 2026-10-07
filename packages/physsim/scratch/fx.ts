import { search } from "../src/sim";
import { checkRules } from "../src/rules";
import { FIXTURES } from "../src/fixtures";
import { gridToRows } from "../src/grid";
for (const f of FIXTURES) {
  const r = checkRules(f.grid, f.from, f.to);
  const a = search(f.grid, f.from, f.to, { capMs: 30000 });
  const ok = r.ok === f.rules && a.found === f.beatable;
  console.log((ok ? "  " : "XX") + f.name.padEnd(32), "rules", r.ok, "agent", a.found, a.exhausted, a.nodes, a.ms.toFixed(0) + "ms", r.reason ?? "");
}
console.log(gridToRows(FIXTURES[12].grid).join("\n"));
