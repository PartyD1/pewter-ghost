import { buildSeedCases } from "./fixtures/seed";
const t0 = Date.now();
const cases = await buildSeedCases();
console.log(cases.length, Date.now()-t0, "ms");
for (const c of cases) console.log(c.id, c.request.mode, c.request.origin, c.blocked?.blockedAt ?? "", JSON.stringify(c).length);
console.log(cases[0].request.grid);
console.log(cases.find(c=>c.id==="patrol-wide-pit")!.request.grid);
