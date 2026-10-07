/**
 * Parity with the Python prototype: chunkgen.gen(...) outputs recorded by
 * py/dump_parity.py must be reproduced exactly (grid, coins, slimes, desc)
 * by generateChunk with the same seed and the audit's caps.
 */
import { describe, expect, it } from "vitest";
import { checkRules } from "@physsim";
import { AUDIT_CAPS, capsFor } from "./caps";
import { chunkMetrics, chunkRows, generateChunk, profileFor, type Difficulty, type Theme } from "./generator";
import { checkChunk } from "./validate";
import records from "./__fixtures__/chunkgen-parity.json";

interface Rec {
  W: number;
  H: number;
  difficulty: number;
  theme: Theme;
  seed: number;
  ground: number;
  rows: string[];
  coins: [number, number][];
  slimes: [number, number][];
  desc: string[];
  exit: boolean;
  exitArcMin: boolean;
}
const RECS = records as unknown as Rec[];

const gen = (r: Rec, caps = AUDIT_CAPS.NORMAL) =>
  generateChunk({ w: r.W, h: r.H, ground: r.ground, seed: r.seed, caps, profile: profileFor(r.difficulty as Difficulty, r.theme, caps) });

describe("generateChunk parity with chunkgen.py", () => {
  it("has the recorded cases", () => {
    expect(RECS.length).toBeGreaterThanOrEqual(120);
  });

  it.each(RECS.map((r, i) => [`${i} d${r.difficulty} ${r.theme} seed ${r.seed} ${r.W}x${r.H}`, r] as const))(
    "%s",
    (_name, r) => {
      const c = gen(r);
      expect(chunkRows(c).map((row) => row.replace(/[cs]/g, "."))).toEqual(r.rows);
      expect(c.coins.map((p) => [p.x, p.y])).toEqual(r.coins);
      expect(c.slimes.map((p) => [p.x, p.y])).toEqual(r.slimes);
      expect(c.desc).toEqual(r.desc);
    },
  );

  it("the @jump-tables caps give the same chunks as the audit caps at NORMAL", () => {
    for (const r of RECS) expect(chunkRows(gen(r, capsFor("NORMAL")))).toEqual(chunkRows(gen(r)));
  });

  it("every recorded chunk the Python called beatable passes the TS rule check too", () => {
    let agree = 0;
    for (const r of RECS) {
      const ok = checkChunk(gen(r)).ok;
      if (ok === r.exitArcMin) agree++;
    }
    // The rule check uses the solver's per-height tables rather than reachpy's
    // ladder; the two agree on these chunks.
    expect(agree).toBe(RECS.length);
  });

  it("metrics match chunkgen.metrics on an example", () => {
    const r = RECS[50];
    const m = chunkMetrics(gen(r));
    expect(m.coins).toBe(r.coins.length);
    expect(m.slimes).toBe(r.slimes.length);
    // pits are fully empty columns
    const empty = Array.from({ length: r.W }, (_, x) => r.rows.every((row) => row[x] === "."));
    const pits: number[] = [];
    let run = -1;
    empty.forEach((e, x) => {
      if (e && run < 0) run = x;
      if (!e && run >= 0) {
        pits.push(x - run);
        run = -1;
      }
    });
    expect(m.pits).toEqual(pits);
    void checkRules;
  });
});
