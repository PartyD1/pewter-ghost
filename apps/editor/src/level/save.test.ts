import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AUTHOR, LEVEL_H, LEVEL_W, TILE } from "../contracts";
import { LevelModel } from "./LevelModel";
import {
  formatSave,
  importV1,
  loadSaveInto,
  parseSave,
  saveFileName,
  serializeSave,
  summariseHistory,
  toSaveFile,
  V1_START,
  type SaveFileV2,
} from "./save";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");

function sampleModel(): LevelModel {
  const m = new LevelModel({ clock: () => 0 });
  const floor = [];
  for (let x = 0; x < 30; x++) floor.push({ x, y: 15, tile: TILE.GRASS }, { x, y: 16, tile: TILE.DIRT });
  m.paint(floor);
  m.placeEntity("slime", 8, 14);
  m.placeEntity("sign", 3, 14, { text: 'Jump "far" →' });
  m.applySuggestion({
    id: "sug-7",
    adds: [
      { x: 12, y: 11, tile: TILE.BLOCK },
      { x: 13, y: 11, tile: TILE.BLOCK },
    ],
    removes: [{ x: 20, y: 15 }],
    entities: [{ kind: "coin", x: 12, y: 10 }],
  });
  m.setGoal({ x: 28, y: 14 });
  return m;
}

describe("save v2", () => {
  it("round-trips through JSON exactly", () => {
    const m = sampleModel();
    const text = serializeSave(m, {
      history: summariseHistory([
        { id: "sug-7", kind: "extend", label: "two blocks", outcome: "accepted", cells: 3, acceptedCells: 3 },
        { id: "sug-8", kind: "finish", label: "close gap", outcome: "esc" },
      ]),
      playSettings: { gravityScale: 1.2, enemyAggression: 0.5 },
    });
    const res = parseSave(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot).toEqual(m.snapshot());
    expect(res.warnings).toEqual([]);
    expect(res.file.history?.outcomes).toEqual({ accepted: 1, esc: 1 });
    expect(res.file.history?.shown).toBe(2);
    expect(res.file.playSettings).toEqual({ gravityScale: 1.2, enemyAggression: 0.5 });
    // Re-serialising the parsed file is byte-identical.
    expect(formatSave(res.file)).toBe(text);
  });

  it("writes readable rows, one per line, with authorship", () => {
    const m = sampleModel();
    const file = toSaveFile(m, { savedAt: null });
    expect(file.version).toBe(2);
    expect(file.grid).toHaveLength(LEVEL_H);
    expect(file.grid[15].slice(0, 22)).toBe("6666666666666666666606");
    expect(file.authors[15].slice(0, 22)).toBe("1111111111111111111101");
    expect(file.grid[11].slice(12, 14)).toBe("11");
    expect(file.authors[11].slice(12, 14)).toBe("22");
    expect(file.provenance).toEqual({ [String(11 * LEVEL_W + 12)]: "sug-7", [String(11 * LEVEL_W + 13)]: "sug-7" });
    expect(file.savedAt).toBeUndefined();
    const text = formatSave(file);
    expect(text.split("\n").filter((l) => l.startsWith('    "6666')).length).toBe(1);
    expect(JSON.parse(text)).toEqual(file);
  });

  it("golden: a tiny level serialises to a stable text", () => {
    const m = new LevelModel({ w: 4, h: 3, start: { x: 0, y: 1 }, clock: () => 0 });
    m.paint([
      { x: 0, y: 2, tile: TILE.GRASS },
      { x: 1, y: 2, tile: TILE.GRASS },
    ]);
    m.applySuggestion({ id: "g1", adds: [{ x: 3, y: 2, tile: TILE.BLOCK }], removes: [], entities: [{ kind: "coin", x: 2, y: 1 }] });
    expect(serializeSave(m, { savedAt: null })).toBe(
      [
        "{",
        '  "version": 2,',
        '  "w": 4,',
        '  "h": 3,',
        '  "grid": [',
        '    "0000",',
        '    "0000",',
        '    "6601"',
        "  ],",
        '  "authors": [',
        '    "0000",',
        '    "0000",',
        '    "1102"',
        "  ],",
        '  "provenance": {"11":"g1"},',
        '  "entities": [',
        '    {"id":"e1","kind":"coin","x":2,"y":1}',
        "  ],",
        '  "entityAuthors": {"e1":2},',
        '  "start": {"x":0,"y":1}',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("property: random levels survive save -> load", () => {
    const cellArb = fc.constantFrom(0, 0, 0, TILE.BLOCK, TILE.GRASS_HALF, TILE.DIRT, TILE.GRASS, TILE.QUESTION);
    fc.assert(
      fc.property(
        fc.array(cellArb, { minLength: 60, maxLength: 60 }),
        fc.array(fc.constantFrom(1, 2), { minLength: 60, maxLength: 60 }),
        fc.array(fc.record({ x: fc.nat(9), y: fc.nat(5), k: fc.constantFrom("coin", "slime", "sign", "flag" as const) }), { maxLength: 8 }),
        (cells, who, ents) => {
          const m = new LevelModel({ w: 10, h: 6, start: { x: 0, y: 0 } });
          cells.forEach((t, i) => {
            if (!t) return;
            const x = i % 10;
            const y = Math.floor(i / 10);
            if (who[i] === 2) m.applySuggestion({ id: `s${i}`, adds: [{ x, y, tile: t as 1 }], removes: [], entities: [] });
            else m.paintTile(x, y, t as 1);
          });
          for (const e of ents) m.placeEntity(e.k, e.x, e.y, { text: e.k === "sign" ? `t${e.x}` : undefined });
          const res = parseSave(serializeSave(m));
          expect(res.ok).toBe(true);
          if (res.ok) expect(res.snapshot).toEqual(m.snapshot());
        },
      ),
      { numRuns: 100 },
    );
  });

  it("loadSaveInto loads, clears history and reports", () => {
    const src = sampleModel();
    const dst = new LevelModel();
    dst.paintTile(1, 1, TILE.BLOCK);
    const res = loadSaveInto(dst, serializeSave(src));
    expect(res.ok).toBe(true);
    expect(dst.snapshot()).toEqual(src.snapshot());
    expect(dst.canUndo).toBe(false);
  });

  it("saveFileName is timestamped", () => {
    expect(saveFileName(new Date(2026, 9, 7, 4, 5, 6))).toBe("pewter-level_2026-10-07_04-05-06.json");
  });
});

describe("malformed files never load and never touch the model", () => {
  const good = () => JSON.parse(serializeSave(sampleModel())) as SaveFileV2;
  const cases: [string, () => unknown][] = [
    ["not JSON", () => "{ nope"],
    ["empty string", () => ""],
    ["null", () => "null"],
    ["array", () => "[1,2,3]"],
    ["number", () => "42"],
    ["no version", () => ({ hello: "world" })],
    ["future version", () => ({ ...good(), version: 3 })],
    ["string version", () => ({ ...good(), version: "2" })],
    ["missing grid", () => ({ ...good(), grid: undefined })],
    ["short grid", () => ({ ...good(), grid: good().grid.slice(1) })],
    ["short row", () => ({ ...good(), grid: good().grid.map((r, i) => (i === 3 ? r.slice(1) : r)) })],
    ["bad tile char", () => ({ ...good(), grid: good().grid.map((r, i) => (i === 3 ? "2" + r.slice(1) : r)) })],
    ["bad author char", () => ({ ...good(), authors: good().authors.map((r, i) => (i === 3 ? "3" + r.slice(1) : r)) })],
    ["authors row count", () => ({ ...good(), authors: [] })],
    ["provenance key outside", () => ({ ...good(), provenance: { "999999": "x" } })],
    ["provenance non-numeric key", () => ({ ...good(), provenance: { abc: "x" } })],
    ["entity unknown kind", () => ({ ...good(), entities: [{ id: "a", kind: "dragon", x: 1, y: 1 }] })],
    ["entity outside", () => ({ ...good(), entities: [{ id: "a", kind: "coin", x: 500, y: 1 }] })],
    ["entity negative", () => ({ ...good(), entities: [{ id: "a", kind: "coin", x: -1, y: 1 }] })],
    ["entity fractional", () => ({ ...good(), entities: [{ id: "a", kind: "coin", x: 1.5, y: 1 }] })],
    ["entity no id", () => ({ ...good(), entities: [{ kind: "coin", x: 1, y: 1 }] })],
    ["duplicate entity ids", () => ({ ...good(), entities: [{ id: "a", kind: "coin", x: 1, y: 1 }, { id: "a", kind: "coin", x: 2, y: 1 }] })],
    ["bad entity author", () => ({ ...good(), entityAuthors: { e1: 7 } })],
    ["start outside", () => ({ ...good(), start: { x: 200, y: 0 } })],
    ["start missing", () => ({ ...good(), start: undefined })],
    ["goal outside", () => ({ ...good(), goal: { x: 0, y: 20 } })],
    ["bad play settings", () => ({ ...good(), playSettings: { gravityScale: 0 } })],
    ["unknown play setting", () => ({ ...good(), playSettings: { warp: 2 } })],
    ["bad history", () => ({ ...good(), history: { shown: -1, outcomes: {}, recent: [] } })],
    ["huge dims", () => ({ ...good(), w: 100000 })],
    ["w mismatch", () => ({ ...good(), w: 199 })],
    ["v1 with bad tiles", () => ({ version: 1, groundTiles: "lots" })],
    ["v1 with bad enemy", () => ({ version: 1, groundTiles: [], enemies: [{ kind: "Slime" }] })],
  ];

  for (const [name, make] of cases) {
    it(name, () => {
      const m = sampleModel();
      const before = m.snapshot();
      const rev = m.revision;
      const input = make();
      const text = typeof input === "string" ? input : JSON.stringify(input);
      const res = loadSaveInto(m, text);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(typeof res.error).toBe("string");
        expect(res.error.length).toBeGreaterThan(5);
      }
      expect(m.snapshot()).toEqual(before);
      expect(m.revision).toBe(rev);
      // parseSave on the raw object never throws either.
      expect(() => parseSave(input)).not.toThrow();
    });
  }

  it("property: arbitrary JSON never throws and never loads garbage", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const res = parseSave(JSON.stringify(v));
        if (res.ok) {
          // Only things that look like a level may load.
          expect(typeof v).toBe("object");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("property: corrupting one character of a save never throws", () => {
    const text = serializeSave(sampleModel(), { savedAt: null });
    fc.assert(
      fc.property(fc.nat(text.length - 1), fc.string({ minLength: 1, maxLength: 1 }), (i, c) => {
        const bad = text.slice(0, i) + c + text.slice(i + 1);
        const m = new LevelModel();
        const before = m.snapshot();
        const res = loadSaveInto(m, bad);
        if (!res.ok) expect(m.snapshot()).toEqual(before);
      }),
      { numRuns: 300 },
    );
  });

  it("normalises repairable inconsistencies with warnings", () => {
    const f = good();
    // Author on an empty cell, provenance on a person cell, stray entity author.
    f.authors[0] = "1" + f.authors[0].slice(1);
    f.provenance[String(15 * LEVEL_W + 0)] = "bogus";
    f.entityAuthors["ghost-id"] = 2;
    const res = parseSave(JSON.stringify(f));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot.authors[0]).toBe(0);
    expect(res.snapshot.provenance[15 * LEVEL_W]).toBeUndefined();
    expect(res.warnings.length).toBe(3);
  });
});

describe("v1 import (old Pewter saves)", () => {
  it("imports the audit's malformed save instead of wiping the level", () => {
    const res = parseSave(fixture("v1-malformed-dynamic-enemy.json"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.migratedFrom).toBe(1);
    expect(res.snapshot.cells[3 * LEVEL_W + 3]).toBe(TILE.GRASS);
    expect(res.snapshot.authors[3 * LEVEL_W + 3]).toBe(AUTHOR.PERSON);
    expect(res.snapshot.entities).toEqual([]);
    expect(res.warnings.some((w) => w.includes("Dynamic"))).toBe(true);
    expect(res.snapshot.start).toEqual(V1_START);
  });

  it("maps terrain, collectables and enemies with author = person", () => {
    const res = parseSave(fixture("v1-typical.json"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.snapshot;
    const at = (x: number, y: number) => s.cells[y * LEVEL_W + x];
    expect([at(0, 15), at(1, 15), at(2, 15), at(3, 15), at(4, 15), at(5, 15)]).toEqual([6, 6, 6, 4, 1, 7]);
    expect([at(0, 16), at(1, 16)]).toEqual([5, 5]);
    expect(at(3, 3)).toBe(0);
    for (let i = 0; i < s.cells.length; i++) expect(s.authors[i]).toBe(s.cells[i] ? AUTHOR.PERSON : AUTHOR.NONE);
    expect(s.entities.map((e) => [e.kind, e.x, e.y])).toEqual([
      ["slime", 10, 14],
      ["ultraslime", 12, 14],
      ["coin", 2, 12],
      ["fruit", 3, 12],
      ["ultraslime", 20, 14],
    ]);
    for (const e of s.entities) expect(s.entityAuthors[e.id]).toBe(AUTHOR.PERSON);
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        "skipped coin at x=0 y=15: the cell is solid",
        "skipped slime at x=12 y=14: a ultraslime is already there",
        "skipped 1 item(s) outside the 200x20 level",
        "skipped 1 tile(s) with unknown index 42",
      ]),
    );
    expect(Object.keys(s.provenance)).toHaveLength(0);
  });

  it("loads into the model and saves back as v2", () => {
    const m = new LevelModel();
    const res = loadSaveInto(m, fixture("v1-typical.json"));
    expect(res.ok).toBe(true);
    expect(m.tileAt(4, 15)).toBe(TILE.BLOCK);
    const again = parseSave(serializeSave(m));
    expect(again.ok && again.migratedFrom).toBe(undefined);
    expect(again.ok && again.snapshot).toEqual(m.snapshot());
  });

  it("accepts an old save without a version field and with missing layers", () => {
    const res = importV1({ groundTiles: [{ x: 1, y: 1, index: 1 }] });
    expect(res.ok).toBe(true);
    const res2 = parseSave({ groundTiles: [] });
    expect(res2.ok).toBe(true);
    const res3 = parseSave({ version: 1 });
    expect(res3.ok).toBe(true);
  });
});
