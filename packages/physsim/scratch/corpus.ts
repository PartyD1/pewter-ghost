import { search, THOROUGH_PASSES } from "../src/sim";
import { checkRules } from "../src/rules";
import { gridFromMatrix } from "../src/grid";
import fs from "fs";
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gen(seed: number) {
    const R = rng(seed * 7919); const W = 24, H = 12; const g = Array.from({ length: H }, () => Array(W).fill(0));
    let y = 8, x = 0; const col = (cx: number, top: number | null) => { if (top === null) return; for (let yy = top; yy < H; yy++) g[yy][cx] = 1; };
    const ri = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));
    for (; x < 3; x++) col(x, y);
    while (x < W - 3) {
      const k = R();
      if (k < 0.22) { const n = ri(2, 4); for (let i = 0; i < n && x < W - 3; i++, x++) col(x, y); }
      else if (k < 0.45) { const w = ri(2, 12); for (let i = 0; i < w && x < W - 3; i++, x++) col(x, null); }
      else if (k < 0.62) { y = Math.max(3, Math.min(10, y + (R() < 0.6 ? -ri(1, 7) : ri(1, 5)))); for (let i = 0; i < 2 && x < W - 3; i++, x++) col(x, y); }
      else if (k < 0.80) { const w = ri(4, 9); const pw = ri(2, 4); const ph = y - ri(2, 6); const p0 = x + ri(1, Math.max(1, w - pw - 1));
        for (let i = 0; i < w && x < W - 3; i++, x++) { if (x >= p0 && x < p0 + pw && ph >= 1) g[ph][x] = 1; } }
      else { const n = ri(3, 6); const cy = y - ri(2, 4); for (let i = 0; i < n && x < W - 3; i++, x++) { col(x, y); if (cy >= 0) g[cy][x] = 1; } }
    }
    for (; x < W; x++) col(x, y);
    return g;
}
const audit: Record<string, boolean> = {};
for (const f of ["log_random0.txt", "log_random1.txt"]) for (const line of fs.readFileSync("/home/user/pewter-platfomer/audit-prototypes/playtest-agent/" + f, "utf8").split("\n")) {
  const m = line.match(/^(rand_\d+) .* agent (true|false) (true|false) \d+ms(?: agent2 (true|false))?/); if (m) audit[m[1]] = m[2] === "true" || m[4] === "true";
}
let dis = 0, disT = 0, n = 0, rulesFP = 0, rulesFN = 0, slow = 0;
const lim = Number(process.argv[2] ?? 60);
for (let seed = 1; seed <= lim; seed++) {
  const grid = gridFromMatrix(gen(seed));
  const a = search(grid, { x: 0, y: 7 }, { x0: 23 }, { capMs: 60000 });
  const r = checkRules(grid, { x: 0, y: 7 }, { x0: 23 }, { tier: "ULTRA" });
  let t = a.found;
  if (!a.found) t = search(grid, { x: 0, y: 7 }, { x0: 23 }, { capMs: 60000, passes: THOROUGH_PASSES }).found;
  n++; if (t !== a.found) disT++;
  const au = audit[`rand_${seed}`];
  if (au !== undefined && au !== t) { dis++; console.log("AUDIT DISAGREE", seed, au, t); }
  if (r.ok && !t) rulesFP++; if (!r.ok && t) rulesFN++;
  if (a.found && a.ms > 100) slow++;
  console.log(`rand_${seed}`, "agent", a.found, a.exhausted, a.ms.toFixed(0), "thorough", t, "rulesULTRA", r.ok, "audit", au);
}
console.log({ n, dis, disT, rulesFP, rulesFN, slow });
