import { afterAll, describe, expect, it } from "vitest";
import { AgentClient, checkRules } from "@physsim";
import { SOLID_TILES, TILE, TILE_BY_NAME, type FillRequest, type TileId } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { verifyOnce } from "../verify";
import { parseWindowGrid } from "./AlgoFiller";
import { measureRequestWindow } from "./brief";
import { FILLER_NAMES } from "./Filler";
import { bandOf, chainFor, MarkovChain, MarkovFiller, markovLabel, OUT, referenceGrids, rng, SkinTable } from "./MarkovFiller";
import { PlacementStream } from "./stream";
import { buildFillRequest } from "./window";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());
const EXTEND = { kinds: { finish: true, extend: true, fix: true } };

/** The person's floor x 0..x1 at row y (top tile, dirt below), then a pause. */
function floorScene(o: { x1?: number; y?: number; top?: TileId; fill?: TileId; gaps?: number[] } = {}) {
  let t = 1000;
  const clock = () => t;
  const model = new LevelModel({ clock });
  const stream = new PlacementStream({ clock, recentCount: 12, pauseMs: 800, longPauseMs: 2500, newStructureTiles: 6 });
  stream.attach(model);
  const x1 = o.x1 ?? 20;
  const y = o.y ?? 15;
  const gaps = new Set(o.gaps ?? []);
  const cells = [];
  for (let x = 0; x <= x1; x++) {
    if (gaps.has(x)) continue;
    cells.push({ x, y, tile: o.top ?? TILE.GRASS }, { x, y: y + 1, tile: o.fill ?? TILE.DIRT });
  }
  model.paint(cells);
  t += 1500;
  return { model, stream, now: t };
}

const request = (s: ReturnType<typeof floorScene>): FillRequest =>
  buildFillRequest(s.model, s.stream, { now: s.now, measure: measureRequestWindow, cols: 24, rows: 12 });

describe("MarkovChain", () => {
  it("learns P(tile | left, below, diag) per height band and backs off for rare contexts", () => {
    const c = new MarkovChain();
    // Ground: grass over dirt, three columns wide, at the bottom of the level.
    const g = { w: 3, h: 2, cells: [TILE.GRASS, TILE.GRASS, TILE.GRASS, TILE.DIRT, TILE.DIRT, TILE.DIRT] };
    for (let i = 0; i < 4; i++) c.train(g, 18);
    expect(c.prob(19, TILE.DIRT, OUT, OUT, TILE.DIRT)).toBeGreaterThan(0.9);
    expect(c.prob(18, TILE.GRASS, TILE.DIRT, TILE.DIRT, TILE.GRASS)).toBeGreaterThan(0.9);
    // An unseen context backs off to the band's frequencies (never zero, sums to 1).
    const d = c.dist(18, TILE.QUESTION, TILE.QUESTION, TILE.QUESTION);
    expect(d.p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Math.min(...d.p)).toBeGreaterThan(0);
    expect([bandOf(0), bandOf(4), bandOf(5), bandOf(19)]).toEqual([0, 0, 1, 3]);
  });

  it("the bundled reference sections parse and train a chain", () => {
    const refs = referenceGrids();
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r.originY + r.grid.h).toBe(20);
    const scene = floorScene();
    const req = request(scene);
    const chain = chainFor(parseWindowGrid(req)!, req.origin.y, req.frontier.x, 6);
    expect(chain.weight).toBeGreaterThan(1000);
  });

  it("the skin layer puts the surface tile on top and the fill tile under it", () => {
    const s = new SkinTable();
    s.train({ w: 2, h: 3, cells: [TILE.GRASS, TILE.GRASS, TILE.DIRT, TILE.DIRT, TILE.DIRT, TILE.DIRT] });
    expect(s.pick(false, true, TILE.GRASS, TILE.DIRT)).toBe(TILE.GRASS); // nothing above: a top
    expect(s.pick(true, true, TILE.DIRT, TILE.GRASS)).toBe(TILE.DIRT); // buried
    expect(new SkinTable().pick(false, false, OUT, TILE.BLOCK)).toBe(TILE.BLOCK); // nothing learned: keep
  });

  it("rng is deterministic for a seed", () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("MarkovFiller", () => {
  it("is registered under its own name", () => {
    expect(FILLER_NAMES).toContain("markov");
    expect(new MarkovFiller().name).toBe("markov");
  });

  it("extends from the frontier without touching drawn cells, and the rule check passes", () => {
    const req = request(floorScene());
    const p = new MarkovFiller({ config: EXTEND }).propose(req);
    expect(p.answer.act, p.answer.label).toBe(true);
    expect(p.answer.kind).toBe("extend");
    const g = parseWindowGrid(req)!;
    for (const a of p.answer.adds) {
      expect(a.x).toBeGreaterThan(req.frontier.x);
      expect(g.tiles[a.y * g.w + a.x], `(${a.x},${a.y}) was drawn`).toBe(0);
    }
    expect(p.answer.adds.length).toBeLessThanOrEqual(40);
    expect(p.answer.confidence).toBeGreaterThanOrEqual(0.2);
    expect(p.answer.confidence).toBeLessThanOrEqual(0.6);
    expect(p.answer.label).toMatch(/^extend: /);
    // The merged window is passable from the frontier to the last new column.
    const solid = Uint8Array.from(g.tiles, (t) => (SOLID_TILES.has(t) ? 1 : 0));
    for (const a of p.answer.adds) solid[a.y * g.w + a.x] = 1;
    const end = Math.max(...p.answer.adds.map((a) => a.x));
    const sy = 15 - req.origin.y;
    expect(checkRules({ w: g.w, h: g.h, solid }, { x: req.frontier.x, y: sy - 1 }, { x0: end, x1: end }).ok).toBe(true);
  });

  it("the verifier plays its answer on the real level", async () => {
    const scene = floorScene();
    const s = await new MarkovFiller({ config: EXTEND }).fill(request(scene));
    expect(s).not.toBeNull();
    expect(s!.filler).toBe("markov");
    const v = await verifyOnce(scene.model, s!, { agent });
    expect(v.ok, v.reason).toBe(true);
  });

  it("continues the person's palette: block over block stays block", () => {
    const req = request(floorScene({ top: TILE.BLOCK, fill: TILE.BLOCK }));
    const p = new MarkovFiller({ config: EXTEND }).propose(req);
    expect(p.answer.act).toBe(true);
    const blocks = p.answer.adds.filter((a) => TILE_BY_NAME[a.tile] === TILE.BLOCK).length;
    expect(blocks / p.answer.adds.length).toBeGreaterThan(0.6);
  });

  it("carries the person's style over seeds: their gaps recur, no exposed dirt, no lone tiles", () => {
    const req = request(floorScene({ gaps: [6, 7, 12, 13] }));
    const g = parseWindowGrid(req)!;
    let withGap = 0;
    for (let seed = 0; seed < 12; seed++) {
      const p = new MarkovFiller({ seed, config: EXTEND }).propose(req);
      expect(p.answer.act).toBe(true);
      const solid = Uint8Array.from(g.tiles, (t) => (SOLID_TILES.has(t) ? 1 : 0));
      for (const a of p.answer.adds) solid[a.y * g.w + a.x] = 1;
      const at = (x: number, y: number) => x >= 0 && y >= 0 && x < g.w && y < g.h && solid[y * g.w + x] === 1;
      for (const a of p.answer.adds) {
        if (a.tile === "dirt") expect(at(a.x, a.y - 1), `dirt on top at (${a.x},${a.y}) seed ${seed}`).toBe(true);
        expect(at(a.x - 1, a.y) || at(a.x + 1, a.y) || at(a.x, a.y - 1) || at(a.x, a.y + 1), `lone tile (${a.x},${a.y})`).toBe(true);
      }
      if (/gap/.test(p.answer.label)) withGap++;
    }
    expect(withGap).toBeGreaterThan(0);
  });

  it("is deterministic for a request; a send-back of the same request samples again", () => {
    const req = request(floorScene({ gaps: [6, 7, 12] }));
    const a = new MarkovFiller({ config: EXTEND }).propose(req);
    const b = new MarkovFiller({ config: EXTEND }).propose(req);
    expect(b.answer).toEqual(a.answer);
    const f = new MarkovFiller({ config: EXTEND });
    f.propose(req);
    expect(f.propose(req).attempt).toBe(1);
  });

  it("declines patrol and tidy (no fixes), extend switched off, and no ground at the frontier", () => {
    const req = request(floorScene());
    const f = new MarkovFiller({ config: EXTEND });
    expect(f.propose({ ...req, mode: "patrol" }).answer.act).toBe(false);
    expect(f.propose({ ...req, mode: "tidy" }).answer.act).toBe(false);
    expect(new MarkovFiller({ config: { kinds: { finish: true, extend: false, fix: true } } }).propose(req).answer.act).toBe(false);
    expect(f.propose({ ...req, recent: [], frontier: { ...req.frontier, x: req.size.w - 2 } }).answer.label).toMatch(/room|stand/);
    expect(f.propose({ ...req, recent: [], frontier: { ...req.frontier, x: 40 } }).answer.label).toMatch(/nothing drawn/);
  });

  it("anchors on the person's stroke when the frontier is past the window (a platform on a long floor)", () => {
    let t = 1000;
    const clock = () => t;
    const model = new LevelModel({ clock });
    const stream = new PlacementStream({ clock, recentCount: 12, pauseMs: 800, longPauseMs: 2500, newStructureTiles: 6 });
    stream.attach(model);
    // A long floor at row 15 (the starter level's), then a raised platform with a gap on it.
    model.paint(Array.from({ length: 80 }, (_, x) => [{ x, y: 15, tile: TILE.GRASS }, { x, y: 16, tile: TILE.DIRT }]).flat());
    t += 2000;
    for (const x of [30, 31, 32, 33, 36, 37, 38, 39]) {
      model.beginStroke();
      model.paint([{ x, y: 13, tile: TILE.GRASS }, { x, y: 14, tile: TILE.DIRT }]);
      model.endStroke();
      t += 80;
    }
    t += 1500;
    const req = buildFillRequest(model, stream, { now: t, measure: measureRequestWindow, cols: 24, rows: 12 });
    const p = new MarkovFiller({ config: EXTEND }).propose(req);
    expect(p.answer.act, p.answer.label).toBe(true);
    const lastStroke = Math.max(...req.recent.filter((r) => r.x >= 0 && r.x < req.size.w).map((r) => r.x));
    expect(Math.min(...p.answer.adds.map((a) => a.x))).toBeGreaterThan(lastStroke);
  });

  it("answers fast enough for a call per placement", () => {
    const req = request(floorScene({ gaps: [5, 9] }));
    const f = new MarkovFiller({ config: EXTEND });
    f.propose(req);
    const p = f.propose(req);
    expect(p.ms).toBeLessThan(150);
  });

  it("labels the new surface: gaps, steps and drops", () => {
    // 6 x 4: frontier column 0 has ground at row 2; new columns 1..5.
    const w = 6;
    const h = 4;
    const cells = new Array(w * h).fill(0);
    const put = (x: number, y: number) => (cells[y * w + x] = TILE.GRASS);
    put(0, 2);
    put(3, 1);
    put(4, 1);
    put(5, 3);
    expect(markovLabel(cells, w, h, 0, 2, 1, 5)).toBe("extend: gap 2, step up 1, drop 2");
    // With the window before the ghost, a column over an existing floor is a gap, not a drop.
    const base = new Array(w * h).fill(0);
    base[0 * w + 0] = 0;
    for (let x = 0; x < w; x++) base[3 * w + x] = TILE.DIRT;
    const withFloor = cells.map((c, i) => (base[i] ? base[i] : c));
    withFloor[2 * w + 0] = TILE.GRASS;
    base[2 * w + 0] = TILE.GRASS;
    expect(markovLabel(withFloor, w, h, 0, 2, 1, 5, base)).toBe("extend: gap 2, step up 1, gap 1");
    expect(markovLabel(new Array(w * h).fill(0).map((_, i) => (Math.floor(i / w) === 2 ? TILE.GRASS : 0)), w, h, 0, 2, 1, 5)).toBe(
      "extend: a flat run",
    );
  });
});
