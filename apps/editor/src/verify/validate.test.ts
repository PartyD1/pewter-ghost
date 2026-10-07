import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ENEMY_KINDS, SOLID_TILES, TILE, type Point, type Suggestion } from "../contracts";
import { ents, GROUND, groundRows, H, modelFrom, rect, snapshotFrom, sugg, W } from "./__fixtures__/levels";
import { BH, BW, frame, gridFromCells, isStandable, Level, search, settleStart, spawnBody, T, type SolidGrid } from "@physsim";
import { mergeSuggestion } from "./merge";
import { validateSuggestion, VALIDATION_BANDS } from "./validate";

/** Person drew ground on columns 0..19. */
const base = () => modelFrom(groundRows([[0, 19]]));

describe("validateSuggestion: shape", () => {
  it("passes a plain continuation of the ground", () => {
    const v = validateSuggestion(base(), sugg({ adds: rect(20, 27, GROUND, H - 1) }));
    expect(v).toMatchObject({ ok: true });
    expect(v.ms).toBeGreaterThanOrEqual(0);
  });

  it("accepts a live model or a snapshot", () => {
    const m = base();
    const s = sugg({ adds: rect(20, 27, GROUND, H - 1) });
    expect(validateSuggestion(m.snapshot(), s).ok).toBe(true);
  });

  it("rejects cells outside the level", () => {
    const v = validateSuggestion(base(), sugg({ adds: [{ x: W, y: 3, tile: TILE.GRASS }] }));
    expect(v).toMatchObject({ ok: false, stage: "shape" });
    expect(v.reason).toMatch(/outside the level/);
  });

  it("rejects fractional coordinates", () => {
    const v = validateSuggestion(base(), sugg({ adds: [{ x: 20.5, y: 8, tile: TILE.GRASS }] }));
    expect(v).toMatchObject({ ok: false, stage: "shape" });
    expect(v.reason).toMatch(/whole-number/);
  });

  it("rejects non-terrain tiles and duplicates", () => {
    expect(validateSuggestion(base(), sugg({ adds: [{ x: 20, y: 8, tile: 3 as never }] })).reason).toMatch(/not a terrain tile/);
    const dup = validateSuggestion(base(), sugg({ adds: [{ x: 20, y: 8, tile: TILE.GRASS }, { x: 20, y: 8, tile: TILE.DIRT }] }));
    expect(dup.reason).toMatch(/added twice/);
  });

  it("rejects adds over the person's tiles unless it is a fix", () => {
    const over = rect(18, 22, GROUND, GROUND);
    const v = validateSuggestion(base(), sugg({ kind: "extend", adds: over }));
    expect(v).toMatchObject({ ok: false, stage: "shape" });
    expect(v.reason).toMatch(/\(18,8\) already holds a tile/);
    const f = validateSuggestion(base(), sugg({ kind: "fix", adds: over }));
    expect(f.stage).not.toBe("shape");
  });

  it("rejects removes outside a fix and removes of empty cells", () => {
    const r1 = validateSuggestion(base(), sugg({ kind: "finish", removes: [{ x: 5, y: 8 }] }));
    expect(r1.reason).toMatch(/removes are only allowed in a fix/);
    const r2 = validateSuggestion(base(), sugg({ kind: "fix", removes: [{ x: 30, y: 8 }] }));
    expect(r2.reason).toMatch(/already empty/);
    const r3 = validateSuggestion(base(), sugg({ kind: "fix", removes: [{ x: 5, y: 8 }] }));
    expect(r3.ok).toBe(true);
  });

  it("rejects burying the knight's start", () => {
    const v = validateSuggestion(base(), sugg({ kind: "fix", adds: [{ x: 1, y: GROUND - 1, tile: TILE.BLOCK }] }));
    expect(v.reason).toMatch(/bury the knight's start/);
  });

  it("checks entity cells and surfaces", () => {
    expect(validateSuggestion(base(), sugg({ entities: ents("coin", [[5, 9]]) })).reason).toMatch(/inside a solid tile/);
    expect(validateSuggestion(base(), sugg({ entities: ents("slime", [[25, 4]]) })).reason).toMatch(/no ground under it/);
    expect(validateSuggestion(base(), sugg({ entities: ents("flag", [[30, 4]]) })).reason).toMatch(/no ground under it/);
    // A slime standing on ground the same suggestion adds is fine.
    const ok = validateSuggestion(
      base(),
      sugg({ adds: rect(20, 29, GROUND, H - 1), entities: ents("slime", [[26, GROUND - 1]]) }),
    );
    expect(ok.ok).toBe(true);
    const inside = validateSuggestion(base(), sugg({ adds: rect(20, 22, GROUND, H - 1), entities: ents("coin", [[21, GROUND]]) }));
    expect(inside.reason).toMatch(/inside a tile the answer adds/);
  });

  it("allows an empty answer only with act=false", () => {
    const empty = sugg({});
    expect(validateSuggestion(base(), empty)).toMatchObject({ ok: false, stage: "shape" });
    expect(validateSuggestion(base(), empty, { act: false })).toMatchObject({ ok: true });
  });

  it("rejects oversized answers", () => {
    const v = validateSuggestion(base(), sugg({ adds: rect(20, 47, 0, 7) }), { bands: { maxCells: 50 } });
    expect(v.reason).toMatch(/at most 50/);
  });
});

describe("validateSuggestion: repeat", () => {
  it("rejects the same cells as one of the last two ghosts", () => {
    const s = sugg({ adds: rect(20, 27, GROUND, H - 1) });
    const v = validateSuggestion(base(), s, { lastGhosts: [{ adds: s.adds }, { cells: [{ x: 1, y: 1 }] }] });
    expect(v).toMatchObject({ ok: false, stage: "repeat" });
    expect(v.reason).toMatch(/ghost before last/);
    // Older than the last two: allowed.
    const old = validateSuggestion(base(), s, { lastGhosts: [{ adds: s.adds }, { cells: [{ x: 1, y: 1 }] }, { cells: [{ x: 2, y: 1 }] }] });
    expect(old.ok).toBe(true);
  });

  it("rejects an extend with the same pattern tags as both of the last two ghosts", () => {
    // Rising steps: three 2-wide steps up from the ground.
    const steps = [...rect(20, 21, GROUND - 1, GROUND - 1), ...rect(22, 23, GROUND - 2, GROUND - 2), ...rect(24, 25, GROUND - 3, GROUND - 3), ...rect(26, 27, GROUND - 4, GROUND - 4)];
    const m = modelFrom(groundRows([[0, 30]]));
    const first = validateSuggestion(m, sugg({ kind: "extend", adds: steps }));
    expect(first.ok).toBe(true);
    const tags = first.tags!.filter((t) => t !== "rest");
    expect(tags.length).toBeGreaterThan(0);
    const hist = [{ patterns: tags }, { patterns: [...tags, "rest"] }];
    const v = validateSuggestion(m, sugg({ kind: "extend", adds: steps }), { lastGhosts: hist });
    expect(v).toMatchObject({ ok: false, stage: "repeat" });
    expect(v.reason).toMatch(/differ in pattern/);
    // Only one matches: allowed. A finish is allowed to continue the same pattern.
    expect(validateSuggestion(m, sugg({ kind: "extend", adds: steps }), { lastGhosts: [{ patterns: ["pit"] }, ...hist.slice(1)] }).ok).toBe(true);
    expect(validateSuggestion(m, sugg({ kind: "finish", adds: steps }), { lastGhosts: hist }).ok).toBe(true);
  });
});

describe("validateSuggestion: measure bands", () => {
  it("rejects a suggestion that makes the screen far denser than the drawing", () => {
    // Sparse drawing: a one-row floor.
    const m = modelFrom(groundRows([[0, 19]], W, H, (x, y) => (y > GROUND ? "." : undefined)));
    const v = validateSuggestion(m, sugg({ adds: rect(20, 31, 2, GROUND) }));
    expect(v).toMatchObject({ ok: false, stage: "measure" });
    expect(v.reason).toMatch(/solid; the drawing so far is/);
  });

  it("rejects a gap the knight cannot clear, with the measurement", () => {
    const v = validateSuggestion(base(), sugg({ adds: rect(33, 40, GROUND, H - 1) }));
    expect(v).toMatchObject({ ok: false, stage: "measure" });
    expect(v.reason).toMatch(/gap at x=20 is 13 wide; the knight clears 11 with a full run-up/);
  });

  it("rejects a gap far wider than the drawing's gaps (band), accepts a moderate one", () => {
    const wide = validateSuggestion(base(), sugg({ adds: rect(29, 36, GROUND, H - 1) })); // gap 9
    expect(wide).toMatchObject({ ok: false, stage: "measure" });
    expect(wide.reason).toMatch(/gap at x=20 is 9 wide; the drawing so far jumps at most 0, so keep gaps to 6 or less/);
    expect(validateSuggestion(base(), sugg({ adds: rect(25, 32, GROUND, H - 1) })).ok).toBe(true); // gap 5
    // A drawing that already has a 6-wide gap widens the band.
    const gappy = modelFrom(groundRows([[0, 9], [16, 25]]));
    expect(validateSuggestion(gappy, sugg({ adds: rect(35, 42, GROUND, H - 1) }), { bands: {} }).ok).toBe(true); // gap 9
  });
});

describe("validateSuggestion: collectables and enemies (G-26)", () => {
  const coinLevel = () =>
    modelFrom(
      groundRows([[0, 19], [24, 47]], W, H, (x, y) => (y === GROUND - 3 && x >= 20 && x <= 23 ? "c" : undefined)),
    );

  it("rejects coins laid flat on the floor in a coin-looking level", () => {
    const v = validateSuggestion(coinLevel(), sugg({ entities: ents("coin", [[30, 7], [31, 7], [32, 7]]) }));
    expect(v).toMatchObject({ ok: false, stage: "measure" });
    expect(v.reason).toMatch(/3 coins at x=30..32 lie flat on the floor/);
  });

  it("accepts coins on a jump arc, and floor coins in a level that is not about coins", () => {
    expect(validateSuggestion(coinLevel(), sugg({ entities: ents("coin", [[30, 5], [31, 4], [32, 5]]) })).ok).toBe(true);
    expect(validateSuggestion(base(), sugg({ entities: ents("coin", [[10, 7], [11, 7]]) })).ok).toBe(true);
  });

  it("enemies need >= 4 tiles of patrol", () => {
    const v = validateSuggestion(
      base(),
      sugg({ adds: rect(24, 25, 5, 5), entities: ents("slime", [[24, 4]]) }),
    );
    expect(v).toMatchObject({ ok: false, stage: "measure" });
    expect(v.reason).toMatch(/can patrol only 2 tiles \(x=24..25\)/);
  });

  it("enemies may not sit within 2 tiles of a landing", () => {
    // Pit 20..22, landing at x=23.
    const m = modelFrom(groundRows([[0, 19], [23, 40]]));
    const near = validateSuggestion(m, sugg({ entities: ents("ultraslime", [[24, GROUND - 1]]) }));
    expect(near).toMatchObject({ ok: false, stage: "measure" });
    expect(near.reason).toMatch(/1 tile from where the knight lands at \(23,7\)/);
    expect(validateSuggestion(m, sugg({ entities: ents("slime", [[30, GROUND - 1]]) })).ok).toBe(true);
  });
});

describe("validateSuggestion: property", () => {
  const level = () => modelFrom(groundRows([[0, 15], [20, 30]]));
  const pt = fc.record({ x: fc.integer({ min: -2, max: W + 1 }), y: fc.integer({ min: -2, max: H + 1 }) });
  const tile = fc.constantFrom<number>(TILE.GRASS, TILE.DIRT, TILE.BLOCK, TILE.QUESTION, TILE.GRASS_HALF, 0, 3);
  const kind = fc.constantFrom("finish", "extend", "fix") as fc.Arbitrary<Suggestion["kind"]>;
  const ekind = fc.constantFrom("coin", "fruit", "slime", "ultraslime", "flag", "sign") as fc.Arbitrary<Suggestion["entities"][number]["kind"]>;
  const arb = fc.record({
    kind,
    adds: fc.array(fc.record({ x: pt.map((p) => p.x), y: pt.map((p) => p.y), tile }), { maxLength: 12 }),
    removes: fc.array(pt, { maxLength: 4 }),
    entities: fc.array(fc.record({ kind: ekind, x: pt.map((p) => p.x), y: pt.map((p) => p.y) }), { maxLength: 4 }),
  });

  it("every validator pass is a well-formed level", () => {
    const m = level();
    const before = m.snapshot();
    fc.assert(
      fc.property(arb, (raw) => {
        const s = sugg(raw as Partial<Suggestion>);
        const v = validateSuggestion(before, s);
        if (!v.ok) return;
        const after = mergeSuggestion(before, s);
        for (const p of [...s.adds, ...s.removes, ...s.entities]) {
          expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
          expect(p.x >= 0 && p.y >= 0 && p.x < W && p.y < H).toBe(true);
        }
        for (const a of s.adds) {
          expect(SOLID_TILES.has(a.tile)).toBe(true);
          if (s.kind !== "fix") expect(before.cells[a.y * W + a.x]).toBe(0);
        }
        if (s.kind !== "fix") expect(s.removes).toHaveLength(0);
        const solid = (x: number, y: number) => y < H && SOLID_TILES.has(after.cells[y * W + x]);
        for (const e of after.entities) {
          expect(solid(e.x, e.y)).toBe(false);
          if (ENEMY_KINDS.has(e.kind) || e.kind === "flag") expect(solid(e.x, e.y + 1)).toBe(true);
        }
        expect(solid(before.start.x, before.start.y)).toBe(false);
        // The level model accepts it as one command.
        const live = modelFrom(groundRows([[0, 15], [20, 30]]));
        expect(() => live.applySuggestion(s)).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });
});

describe("VALIDATION_BANDS", () => {
  it("are exported and start wide", () => {
    // Wide: the lower bound only bites on dense drawings (see VALIDATION_BANDS).
    expect(VALIDATION_BANDS.densityRel).toBeGreaterThanOrEqual(0.5);
    expect(VALIDATION_BANDS.densityRel).toBeLessThan(1);
    expect(VALIDATION_BANDS.enemyMinPatrol).toBe(4);
    expect(VALIDATION_BANDS.enemyLandingClearance).toBe(2);
    expect(snapshotFrom(groundRows([[0, 3]])).w).toBe(W);
  });
});

describe("validateSuggestion: density band lower bound", () => {
  it("rejects a near-empty screen after dense drawing, but not after sparse drawing", () => {
    // Columns 4..47 solid from y=3 down (~70% dense) in a 96-wide level; the
    // suggestion opens a near-empty screen beyond.
    const dense = modelFrom(groundRows([[0, 47]], 96, H, (x, y) => (x >= 4 && x <= 47 && y >= 3 ? "#" : undefined)));
    const thin = sugg({ adds: rect(60, 62, H - 1, H - 1) });
    const v = validateSuggestion(dense, thin, { frontierX: 47 });
    expect(v).toMatchObject({ ok: false, stage: "measure" });
    expect(v.reason).toMatch(/solid; the drawing so far is/);
    // The same thin suggestion after ordinary ground passes.
    expect(validateSuggestion(base(), sugg({ adds: rect(20, 22, H - 1, H - 1) }), { frontierX: 19 }).ok).toBe(true);
  });
});

/**
 * Agent reachability of a coin: some standing cell within 8 columns is reached
 * by the physics agent from the start, and from it a jump (run-up of r frames,
 * jump held k frames, direction kept) makes the knight's body overlap the
 * coin's tile. The agent's search only ends on the ground, so the airborne
 * part is played out here with the same frame() physics.
 */
function coinReachable(grid: SolidGrid, start: Point, coin: Point): boolean {
  const L = new Level(grid);
  const hits = (b: { x: number; y: number }) =>
    b.x < (coin.x + 1) * T && b.x + BW > coin.x * T && b.y < (coin.y + 1) * T && b.y + BH > coin.y * T;
  for (let sx = Math.max(0, coin.x - 8); sx <= Math.min(grid.w - 1, coin.x + 8); sx++)
    for (let sy = 0; sy + 1 < grid.h; sy++) {
      if (!isStandable(grid, sx, sy)) continue;
      const here = { x: sx, y: sy };
      if (!(sx === start.x && sy === start.y) && !search(grid, start, here, { xRange: [0, grid.w - 1], capMs: 2000 }).found) continue;
      for (const dir of [-1, 0, 1] as const)
        for (const runUp of [0, 4, 8, 16, 30])
          for (const hold of [1, 4, 8, 12, 16, 20, 30]) {
            const b = spawnBody(sx, sy, L);
            for (let f = 0; f < runUp + 120; f++) {
              const jumping = f >= runUp && f < runUp + hold;
              frame(L, b, dir, jumping);
              if (hits(b)) return true;
            }
          }
    }
  return false;
}

describe("G-26: every accepted arc coin is reachable by the agent", () => {
  const fixtures: { name: string; rows: string[]; coins: [number, number][] }[] = [
    {
      name: "coins over a 4-wide pit",
      rows: groundRows([[0, 19], [24, 47]]),
      coins: [[20, 5], [21, 4], [22, 4], [23, 5]],
    },
    {
      name: "hop arc over flat ground",
      rows: groundRows([[0, 47]]),
      coins: [[30, 5], [31, 4], [32, 5]],
    },
    {
      name: "coins up to a raised ledge",
      rows: groundRows([[0, 47]], W, H, (x, y) => (x >= 26 && x <= 34 && y >= GROUND - 2 ? "#" : undefined)),
      coins: [[24, 4], [25, 3]],
    },
  ];
  for (const f of fixtures) {
    it(f.name, () => {
      const level = modelFrom(f.rows);
      const s = sugg({ entities: ents("coin", f.coins) });
      expect(validateSuggestion(level, s).ok).toBe(true);
      const snap = level.snapshot();
      const grid = gridFromCells(snap.cells, snap.w, snap.h);
      const start = settleStart(grid, snap.start)!;
      for (const [x, y] of f.coins) expect(coinReachable(grid, start, { x, y }), `coin (${x},${y}) in "${f.name}"`).toBe(true);
    });
  }
});
