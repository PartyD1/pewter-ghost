import { checkRules } from "@physsim";
import { describe, expect, it } from "vitest";
import {
  CELL,
  COMPOSE_KINDS,
  HARD,
  composeChunk,
  composedKinds,
  composedRows,
  composedTags,
  neutralStyle,
  type ComposeKind,
  type ComposedChunk,
  type ComposeStyle,
} from "./compose";

const W = 24;
const H = 20;
const GROUND = 15;

const beatable = (c: ComposedChunk) =>
  checkRules({ w: c.w, h: c.h, solid: c.grid }, { x: 0, y: c.ground - 1 }, { x0: c.w - 1, x1: c.w - 1 }).ok;

const only = (kind: ComposeKind, over: Partial<ComposeStyle> = {}): ComposeStyle => ({
  ...neutralStyle(),
  weights: { flat: 0.4, [kind]: 4 },
  ...over,
});

const compose = (seed: number, style?: ComposeStyle, w = W) => composeChunk({ w, h: H, ground: GROUND, seed, style });

describe("composeChunk", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    const a = compose(7);
    const b = compose(7);
    expect(composedRows(a)).toEqual(composedRows(b));
    expect(a.desc).toEqual(b.desc);
    const distinct = new Set(Array.from({ length: 20 }, (_, s) => composedRows(compose(s)).join("\n")));
    expect(distinct.size).toBeGreaterThan(15);
  });

  it("keeps the first and last columns flat at a standing height, and reports the end height", () => {
    for (let seed = 0; seed < 100; seed++) {
      const c = compose(seed);
      expect(c.heights[0]).toBe(GROUND);
      expect(c.heights[c.w - 1]).toBe(c.endY);
      expect(c.heights[c.w - 2]).toBe(c.endY);
      expect(c.endY).toBeGreaterThanOrEqual(3);
      expect(c.endY).toBeLessThanOrEqual(H - 2);
    }
  });

  it("marks every solid cell as surface, fill or block, and nothing else", () => {
    for (let seed = 0; seed < 60; seed++) {
      const c = compose(seed);
      for (let i = 0; i < c.grid.length; i++) expect(c.cell[i] !== CELL.NONE).toBe(c.grid[i] === 1);
      for (const p of [...c.coins, ...c.slimes]) expect(c.grid[p.y * c.w + p.x]).toBe(0);
    }
  });

  it.each(COMPOSE_KINDS.filter((k) => k !== "flat"))("%s: lays out, and the knight can cross almost every section", (kind) => {
    let seen = 0;
    let ok = 0;
    const N = 150;
    for (let seed = 0; seed < N; seed++) {
      const c = compose(seed, only(kind));
      if (c.pieces.some((p) => p.kind === kind)) seen++;
      if (beatable(c)) ok++;
    }
    expect(seen).toBeGreaterThan(N * 0.8);
    expect(ok).toBeGreaterThanOrEqual(N * 0.95);
  });

  it("the neutral style is beatable for nearly every seed and uses most of the grammar", () => {
    const kinds = new Set<ComposeKind>();
    let ok = 0;
    const N = 300;
    for (let seed = 0; seed < N; seed++) {
      const c = compose(seed);
      composedKinds(c).forEach((k) => kinds.add(k));
      if (beatable(c)) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(N * 0.95);
    expect(kinds.size).toBeGreaterThanOrEqual(COMPOSE_KINDS.length - 2);
  });

  it("pacing: a hard piece is followed by a breather, and two flat runs never touch", () => {
    for (let seed = 0; seed < 200; seed++) {
      const c = compose(seed, { ...neutralStyle(), intensity: 0.8 }, 48);
      for (let i = 1; i < c.pieces.length; i++) {
        const prev = c.pieces[i - 1];
        const cur = c.pieces[i];
        if (prev.intensity >= HARD) expect(["flat", "coin_row", "brick_row"]).toContain(cur.kind);
        if (prev.kind === "flat") expect(cur.kind).not.toBe("flat");
      }
    }
  });

  it("the target intensity moves the mix: a calm style has fewer hard pieces than a tense one", () => {
    const hard = (intensity: number) => {
      let n = 0;
      for (let seed = 0; seed < 200; seed++) n += compose(seed, { ...neutralStyle(), intensity }).pieces.filter((p) => p.intensity >= HARD).length;
      return n;
    };
    expect(hard(0.05)).toBeLessThan(hard(0.9) * 0.7);
  });

  it("echo: the person's gap width and stairs come back, give or take one", () => {
    const style: ComposeStyle = {
      ...neutralStyle(),
      gap: [2, 2],
      motifs: [
        { kind: "pit", size: 4 },
        { kind: "stairs", size: -4, tread: 2, rise: 1 },
      ],
    };
    let echoedPits = 0;
    let echoedStairs = 0;
    for (let seed = 0; seed < 200; seed++) {
      const c = compose(seed, style);
      for (const p of c.pieces) {
        if (!p.echo) continue;
        if (p.kind === "pit") {
          echoedPits++;
          expect(p.size).toBeGreaterThanOrEqual(3);
          expect(p.size).toBeLessThanOrEqual(5);
        }
        if (p.kind === "stairs") {
          echoedStairs++;
          expect(p.size).toBeLessThan(0); // up, like the person's
        }
      }
    }
    expect(echoedPits).toBeGreaterThan(20);
    expect(echoedStairs).toBeGreaterThan(20);
  });

  it("avoid makes recently used kinds rarer", () => {
    const count = (avoid: ComposeKind[]) => {
      let n = 0;
      for (let seed = 0; seed < 300; seed++)
        n += composeChunk({ w: W, h: H, ground: GROUND, seed, avoid }).pieces.filter((p) => p.kind === "pit").length;
      return n;
    };
    expect(count(["pit"])).toBeLessThan(count([]) * 0.7);
  });

  it("a weight of zero switches a kind off", () => {
    const style: ComposeStyle = { ...neutralStyle(), enemyP: 0, weights: { ...neutralStyle().weights, enemy_run: 0, mesa: 0 } };
    for (let seed = 0; seed < 150; seed++) {
      const c = compose(seed, style);
      expect(c.slimes).toHaveLength(0);
      expect(c.pieces.some((p) => p.kind === "enemy_run" || p.kind === "mesa")).toBe(false);
    }
  });

  it("tags name what a section holds", () => {
    const stairs = Array.from({ length: 40 }, (_, s) => compose(s, only("stairs"))).find((c) => c.pieces.some((p) => p.kind === "stairs"))!;
    expect(composedTags(stairs)).toContain("staircase");
    const run = Array.from({ length: 40 }, (_, s) => compose(s, only("gap_run"))).find((c) => c.pieces.some((p) => p.kind === "gap_run"))!;
    expect(composedTags(run)).toEqual(expect.arrayContaining(["pit", "gap-run"]));
  });

  it("rejects impossible sizes", () => {
    expect(() => composeChunk({ w: 0 })).toThrow(RangeError);
    expect(() => composeChunk({ h: 12, ground: 12 })).toThrow(RangeError);
  });
});
