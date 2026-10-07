import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeWindow, fullRect, measureLevel, measuredDistance } from "@measure";
import { knightLimits } from "@jump-tables";
import { AUTHOR, LEVEL_H, LEVEL_W } from "../apps/editor/src/contracts";
import { LevelModel } from "../apps/editor/src/level/LevelModel";
import { selectExamples } from "../apps/editor/src/fill/examples";
import {
  buildChunksFile,
  buildIndex,
  buildLevel,
  chunksFromJson,
  fitType,
  formatChunksFile,
  formatIndex,
  goalOf,
  LEVEL_TYPES,
  LEVELS_DIR,
  LevelSourceError,
  lintLevel,
  loadFixture,
  loadReferenceChunks,
  loadReferenceLevels,
  parseLevelSource,
  readIndex,
  readLevelFile,
  referenceExampleLibrary,
  rightmostStandable,
  snapshotRows,
  sourceToSnapshot,
  TYPE_RULES,
  typeNumbers,
  verifyBeatable,
  type BuiltLevel,
  type LevelType,
} from "./index";

const SRC = join(LEVELS_DIR, "src");
const sourceFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".txt"))
  .sort();
const buildAll = (): BuiltLevel[] =>
  sourceFiles.map((f) => buildLevel(readFileSync(join(SRC, f), "utf8"), f, { verify: false }));

// ---------------------------------------------------------------------------
// Source format
// ---------------------------------------------------------------------------

const tiny = (extra = "", map?: string) =>
  [
    "; a comment",
    "@name tiny",
    "@kind fixture",
    "@title Tiny",
    "@size 20x8",
    extra,
    map ??
      [
        "== left",
        "......",
        "P..i..",
        "######",
        "dddddd",
        "== right",
        "..c.",
        "..sF",
        "####",
      ].join("\n"),
  ].join("\n");

describe("level source format", () => {
  it("lays sections side by side, bottom-aligned, padded to the level width", () => {
    const s = parseLevelSource(tiny("@sign Hello"), "tiny.txt");
    expect(s.w).toBe(20);
    expect(s.h).toBe(8);
    expect(s.rows).toHaveLength(8);
    expect(s.rows.every((r) => r.length === 20)).toBe(true);
    expect(s.sections).toEqual([
      { name: "left", x0: 0, x1: 5, line: 7 },
      { name: "right", x0: 6, x1: 9, line: 12 },
    ]);
    // "right" has 3 rows, so its ground lands on the last row (7), beside "left"'s dirt row.
    expect(s.rows[5]).toBe("P..i....c." + ".".repeat(10));
    expect(s.rows[6]).toBe("######..sF" + ".".repeat(10));
    expect(s.rows[7]).toBe("dddddd####" + ".".repeat(10));
    expect(s.rows[0]).toBe(".".repeat(20));
    expect(s.expect).toBe("beatable");
    expect(s.signs).toEqual(["Hello"]);
  });

  it("builds a snapshot: person-authored, ids in x order, sign text, goal = flag, patrols derived", () => {
    const snap = sourceToSnapshot(parseLevelSource(tiny("@sign Hello"), "tiny.txt"));
    expect(snap.start).toEqual({ x: 0, y: 5 });
    expect(snap.goal).toEqual({ x: 9, y: 6 });
    expect(snap.entities.map((e) => `${e.id}:${e.kind}@${e.x},${e.y}`)).toEqual([
      "e1:sign@3,5",
      "e2:coin@8,5",
      "e3:slime@8,6",
      "e4:flag@9,6",
    ]);
    expect(snap.entities[0].text).toBe("Hello");
    expect(snap.entities[2].patrol).toEqual([6, 9]);
    expect(Object.values(snap.entityAuthors).every((a) => a === AUTHOR.PERSON)).toBe(true);
    for (let i = 0; i < snap.cells.length; i++)
      expect(snap.authors[i]).toBe(snap.cells[i] === 0 ? AUTHOR.NONE : AUTHOR.PERSON);
    // Round trip through the renderer.
    expect(snapshotRows(snap)).toEqual(parseLevelSource(tiny("@sign Hello")).rows);
  });

  it.each([
    ["rows of different width", tiny("@sign x", "== a\nP...\n###\n"), /row is 3 wide/],
    ["unknown glyph", tiny("@sign x", "== a\nP.X.\n####"), /unknown glyph 'X'/],
    ["no start", tiny("@sign x", "== a\n..iF\n####"), /exactly one start/],
    ["two flags", tiny("@sign x", "== a\nPiFF\n####"), /exactly one flag/],
    ["sign without text", tiny("", "== a\nPiF.\n####"), /1 sign glyph/],
    ["rows before a section", tiny("@sign x", "P.iF\n####"), /must follow/],
    ["too wide", tiny("@sign x", "== a\nP.iF" + ".".repeat(20) + "\n" + "#".repeat(24)), /24 columns wide/],
    ["unknown directive", tiny("@colour red"), /unknown directive @colour/],
  ])("rejects %s with a located error", (_, text, msg) => {
    expect(() => parseLevelSource(text, "tiny.txt")).toThrow(msg);
    try {
      parseLevelSource(text, "tiny.txt");
    } catch (e) {
      expect(e).toBeInstanceOf(LevelSourceError);
      expect((e as Error).message.startsWith("tiny.txt")).toBe(true);
    }
  });

  it("checks name, kind, type and expect", () => {
    expect(() => parseLevelSource(tiny("@sign x"), "other.txt")).toThrow(/does not match the file name/);
    const ref = tiny("@sign x").replace("@kind fixture", "@kind reference");
    expect(() => parseLevelSource(ref)).toThrow(/needs @type/);
    expect(() => parseLevelSource(ref + "\n@type parkour\n@expect open")).toThrow(/must be @expect beatable/);
    expect(() => parseLevelSource(tiny("@sign x\n@type speedy"))).toThrow(/@type must be one of/);
    const open = tiny("", "== a\nP...\n####").replace("@kind fixture", "@kind fixture\n@expect open");
    expect(parseLevelSource(open).expect).toBe("open");
    expect(() => parseLevelSource(open.replace("P...", "P..F"))).toThrow(/has no flag/);
  });
});

// ---------------------------------------------------------------------------
// Files on disk are what the sources build to
// ---------------------------------------------------------------------------

describe("built files are up to date (npx tsx levels/build.ts)", () => {
  const built = buildAll();

  it("every source has a JSON save identical to its build", () => {
    for (const b of built) expect(readFileSync(join(LEVELS_DIR, b.out), "utf8"), b.out).toBe(b.json);
  });

  it("chunks.json is the slice of the reference levels", () => {
    const refs = built.filter((b) => b.source.kind === "reference");
    const file = buildChunksFile(refs.map((b) => ({ name: b.source.name, type: b.source.type!, level: b.snapshot })));
    expect(readFileSync(join(LEVELS_DIR, "reference", "chunks.json"), "utf8")).toBe(formatChunksFile(file));
  });

  it("index.json lists every level with the same numbers", () => {
    const idx = readIndex();
    const fresh = JSON.parse(formatIndex(buildIndex(built)));
    expect(idx.levels.map((l) => l.name)).toEqual(built.map((b) => b.source.name));
    for (let i = 0; i < built.length; i++) {
      expect(idx.levels[i].numbers).toEqual(fresh.levels[i].numbers);
      expect(idx.levels[i].file).toBe(built[i].out);
    }
  });
});

// ---------------------------------------------------------------------------
// Reference levels
// ---------------------------------------------------------------------------

const refs = loadReferenceLevels();

describe("reference levels", () => {
  it("has at least three levels of every type", () => {
    for (const t of LEVEL_TYPES) expect(refs.filter((r) => r.type === t).length, t).toBeGreaterThanOrEqual(3);
  });

  describe.each(refs.map((r) => [r.name, r] as const))("%s", (name, r) => {
    it("loads cleanly as save format v2, 200x20, with a start and a flag", () => {
      const res = readLevelFile(`reference/${name}.json`);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.warnings).toEqual([]);
      expect(res.file.version).toBe(2);
      expect([res.snapshot.w, res.snapshot.h]).toEqual([LEVEL_W, LEVEL_H]);
      expect(res.snapshot.entities.filter((e) => e.kind === "flag")).toHaveLength(1);
      expect(res.snapshot.goal).toBeDefined();
      const model = LevelModel.fromSnapshot(res.snapshot);
      expect(model.snapshot()).toEqual(res.snapshot);
    });

    it("is beatable by the playtest agent from start to flag", () => {
      const v = verifyBeatable(r.level, { capMs: 20_000 });
      expect(v.beatable, `blocked at ${JSON.stringify(v.blockedAt)}`).toBe(true);
      expect(v.goalKind).toBe("flag");
      expect(v.timedOut).toBe(false);
      const last = v.path[v.path.length - 1];
      expect(last.x).toBe(r.level.goal!.x);
      expect(r.entry.agent?.beatable).toBe(true);
    });

    it("its measured type-defining numbers fit its type", () => {
      const fit = fitType(r.type, typeNumbers(r.level));
      expect(fit.failures.map((f) => `${f.id}: ${f.key}=${f.value}`)).toEqual([]);
      expect(fit.results.length).toBe(TYPE_RULES[r.type].length);
    });

    it("follows the placement rules (lint)", () => {
      expect(lintLevel(r.level)).toEqual([]);
    });
  });

  it("every type's bands reject some level of another type (no vacuous rules)", () => {
    const nums = new Map(refs.map((r) => [r.name, typeNumbers(r.level)]));
    for (const t of LEVEL_TYPES) {
      const others = refs.filter((r) => r.type !== t);
      const rejected = others.filter((r) => !fitType(t, nums.get(r.name)!).ok);
      expect(rejected.length, t).toBeGreaterThan(0);
    }
    // And the types are told apart: no level fits every type.
    for (const r of refs) expect(LEVEL_TYPES.filter((t) => fitType(t, nums.get(r.name)!).ok).length).toBeLessThan(3);
  });

  it("types differ the way the brief says", () => {
    const by = (t: LevelType) => refs.filter((r) => r.type === t).map((r) => typeNumbers(r.level));
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const m = (t: LevelType, k: keyof ReturnType<typeof typeNumbers>) => mean(by(t).map((n) => n[k]));
    for (const t of LEVEL_TYPES.filter((t) => t !== "maze")) expect(m("maze", "density")).toBeGreaterThan(m(t, "density"));
    for (const t of LEVEL_TYPES.filter((t) => t !== "collect-a-thon"))
      expect(m("collect-a-thon", "rewardsPerScreen")).toBeGreaterThan(m(t, "rewardsPerScreen"));
    for (const t of LEVEL_TYPES.filter((t) => t !== "parkour")) expect(m("parkour", "gapNear")).toBeGreaterThan(m(t, "gapNear"));
    for (const t of LEVEL_TYPES.filter((t) => t !== "story")) expect(m("story", "signs")).toBeGreaterThan(m(t, "signs"));
    for (const t of LEVEL_TYPES.filter((t) => t !== "speedrun")) expect(m("speedrun", "rhythmCV")).toBeLessThan(m(t, "rhythmCV"));
    expect(m("story", "meanDifficulty")).toBeLessThan(m("parkour", "meanDifficulty"));
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("fixtures", () => {
  it("unbeatable-gap: the pit is wider than any jump and the agent exhausts its search", () => {
    const snap = loadFixture("unbeatable-gap");
    const a = analyzeWindow(snap, snap.entities, fullRect(snap));
    const gap = a.graph.transitions.find((t) => t.kind === "jump")!;
    expect(gap.gap).toBeGreaterThan(knightLimits().maxGapRun);
    expect(gap.possible).toBe(false);
    const v = verifyBeatable(snap);
    expect(v.beatable).toBe(false);
    expect(v.exhausted).toBe(true);
    expect(v.blockedAt!.x).toBeLessThanOrEqual(gap.takeoff.x + 1);
    expect(v.blockedAt!.x).toBeGreaterThan(gap.takeoff.x - 4);
  });

  it("staircase-mid-flight: no flag, a staircase, and the start reaches the top step", () => {
    const snap = loadFixture("staircase-mid-flight");
    expect(snap.entities.some((e) => e.kind === "flag")).toBe(false);
    expect(snap.goal).toBeUndefined();
    expect(analyzeWindow(snap, snap.entities, fullRect(snap)).patterns).toContain("staircase");
    const top = rightmostStandable(snap);
    expect(goalOf(snap)).toEqual({ goal: { x0: top }, kind: "frontier" });
    const v = verifyBeatable(snap);
    expect(v.beatable).toBe(true);
    expect(v.path[v.path.length - 1].x).toBe(top);
    // Everything right of the staircase is empty, for Ghost to extend.
    for (let x = top + 1; x < snap.w; x++) for (let y = 0; y < snap.h; y++) expect(snap.cells[y * snap.w + x]).toBe(0);
  });

  it("coin-floor: coins lie in rows on the floor, and it fails the collect-a-thon coin rules", () => {
    const snap = loadFixture("coin-floor");
    const lm = measureLevel(snap);
    expect(lm.whole.patterns).toContain("coin-row-on-floor");
    expect(lm.whole.coinsOnFloorShare).toBeGreaterThanOrEqual(0.5);
    expect(lm.whole.coinsOnArcShare).toBeGreaterThan(0);
    const fit = fitType("collect-a-thon", typeNumbers(snap, lm));
    expect(fit.failures.map((f) => f.id)).toContain("no-floor-rows");
    expect(verifyBeatable(snap).beatable).toBe(true);
  });

  it("enemy-cluster: enemies crowd the landings (high pressure, lint complains), geometry beatable", () => {
    const snap = loadFixture("enemy-cluster");
    const lm = measureLevel(snap);
    expect(lm.whole.counts.enemies).toBeGreaterThanOrEqual(4);
    expect(lm.whole.pressure).toBeGreaterThanOrEqual(1);
    const lint = lintLevel(snap);
    expect(lint.some((l) => /sits on the landing/.test(l))).toBe(true);
    expect(lint.some((l) => /patrols \d tile/.test(l))).toBe(true);
    expect(verifyBeatable(snap).beatable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chunks for the brief
// ---------------------------------------------------------------------------

describe("reference chunks", () => {
  const chunks = loadReferenceChunks();

  it("covers every reference level and type, with numbers and tags", () => {
    expect(new Set(chunks.map((c) => c.source))).toEqual(new Set(refs.map((r) => r.name)));
    for (const t of LEVEL_TYPES) expect(chunks.some((c) => c.levelType === t)).toBe(true);
    for (const c of chunks) {
      expect(c.rows.length).toBe(c.rect.h);
      expect(c.rows.every((row) => row.length === c.rect.w)).toBe(true);
      expect(c.rect.w).toBeLessThanOrEqual(32);
      expect(c.numbers.gapHist).toHaveLength(5);
    }
    expect(chunks.some((c) => c.tags.includes("coin-arc"))).toBe(true);
    expect(chunks.some((c) => c.tags.includes("tunnel"))).toBe(true);
    expect(chunks.some((c) => c.tags.includes("pillar-hop"))).toBe(true);
  });

  it("retrieval returns a chunk's own type for that chunk's numbers", () => {
    const lib = referenceExampleLibrary();
    expect(lib.size).toBe(chunks.length);
    for (const t of LEVEL_TYPES) {
      const probe = chunks.find((c) => c.levelType === t && c.tags.length > 1)!;
      const sel = lib.select(probe.numbers, { k: 2, maxTokens: 600 });
      expect(sel.picked.length).toBeGreaterThan(0);
      expect(sel.picked[0].distance).toBe(0);
      expect(measuredDistance(sel.picked[0].chunk.numbers, probe.numbers)).toBe(0);
      expect(sel.tokens).toBeLessThanOrEqual(600);
    }
    const sel = selectExamples(chunks, chunks[0].numbers, { k: 3, maxTokens: 400 });
    expect(sel.tokens).toBeLessThanOrEqual(400);
  });

  it("chunksFromJson rejects files that are not a chunk library", () => {
    expect(() => chunksFromJson(null)).toThrow();
    expect(() => chunksFromJson({ version: 2, chunks: [] })).toThrow(/version 1/);
    expect(() => chunksFromJson({ version: 1, chunks: [{ id: "x" }] })).toThrow(/malformed chunk x/);
    expect(chunksFromJson({ version: 1, chunks: [] })).toEqual([]);
  });
});
