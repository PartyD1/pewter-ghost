/**
 * Parity with the Python prototype: chunkgen.gen(...) outputs recorded by
 * py/dump_parity.py must be reproduced exactly (grid, coins, slimes, desc)
 * by generateChunk with the same seed and the audit's caps.
 */
import { describe, expect, it } from "vitest";
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

  // Before the 2026-10-08 feel retune the live @jump-tables caps gave exactly the
  // same chunks as the audit caps at NORMAL. The knight now reaches less, so they
  // differ on purpose; what must still hold is that the live caps give chunks the
  // current rule check accepts, for every recorded configuration.
  it("the live @jump-tables caps give rule-checked chunks for every recorded configuration", () => {
    for (const r of RECS) expect(checkChunk(gen(r, capsFor("NORMAL"))).ok, `${r.difficulty} ${r.theme} seed ${r.seed}`).toBe(true);
  });

  it("the rule check never accepts a recorded chunk the Python called unbeatable", () => {
    // The recorded verdicts were made for the OLD, longer reach (audit caps),
    // so the new rule check says no more often (it is stricter). It must not say
    // yes where the old reach said no.
    let ruleOkPyNo = 0;
    for (const r of RECS) if (checkChunk(gen(r)).ok && !r.exitArcMin) ruleOkPyNo++;
    expect(ruleOkPyNo).toBe(0);
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
  });
});
