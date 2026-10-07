import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AUTHOR, TILE, type LevelSnapshot } from "../contracts";
import { LevelModel } from "./LevelModel";
import {
  decodePayload,
  decodeShareCode,
  deflateAvailable,
  encodePayload,
  encodeShareCode,
  fromBase64Url,
  packBits,
  toBase64Url,
  unpackBits,
} from "./share";

/** What a share code preserves: everything but provenance and entity ids. */
function shareable(s: LevelSnapshot, includeAuthors = true) {
  return {
    w: s.w,
    h: s.h,
    cells: s.cells,
    authors: includeAuthors ? s.authors : s.authors.map(() => 0),
    entities: s.entities.map((e) => ({
      kind: e.kind,
      x: e.x,
      y: e.y,
      patrol: e.patrol,
      text: e.text,
      author: includeAuthors ? s.entityAuthors[e.id] : AUTHOR.NONE,
    })),
    start: s.start,
    goal: s.goal,
  };
}

function sample(): LevelModel {
  const m = new LevelModel({ clock: () => 0 });
  const floor = [];
  for (let x = 0; x < 200; x++) if (x % 37 !== 5) floor.push({ x, y: 15, tile: TILE.GRASS }, { x, y: 16, tile: TILE.DIRT });
  m.paint(floor);
  m.paint([
    { x: 20, y: 11, tile: TILE.BLOCK },
    { x: 21, y: 11, tile: TILE.QUESTION },
    { x: 22, y: 11, tile: TILE.GRASS_HALF },
  ]);
  m.placeEntity("slime", 30, 14);
  m.placeEntity("sign", 2, 14, { text: "héllo ✨ world" });
  m.placeEntity("flag", 190, 14);
  m.placeEntity("sign", 4, 14); // a sign without text stays without text
  m.applySuggestion({ id: "s1", adds: [{ x: 50, y: 12, tile: TILE.BLOCK }], removes: [], entities: [{ kind: "coin", x: 50, y: 11 }] });
  m.setGoal({ x: 190, y: 14 });
  return m;
}

const methods = (["rle", "auto", ...(deflateAvailable() ? (["deflate"] as const) : [])] as const);

describe("share codes", () => {
  for (const method of methods) {
    it(`round-trips a level (${method})`, async () => {
      const m = sample();
      const code = await encodeShareCode(m, { method, playSettings: { gravityScale: 1.25, speedScale: 0.9 } });
      expect(code).toMatch(/^pg1\.[dr]\.[A-Za-z0-9_-]+$/);
      const res = await decodeShareCode(code);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(shareable(res.snapshot)).toEqual(shareable(m.snapshot()));
      expect(res.snapshot.provenance).toEqual({});
      expect(res.snapshot.entities.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
      expect(res.playSettings).toEqual({ gravityScale: 1.25, speedScale: 0.9 });
      // Decoded level loads into a model.
      const m2 = LevelModel.fromSnapshot(res.snapshot);
      expect(m2.tileAt(21, 11)).toBe(TILE.QUESTION);
    });
  }

  it("is compact for a typical level", async () => {
    const code = await encodeShareCode(sample());
    expect(code.length).toBeLessThan(deflateAvailable() ? 300 : 600);
    const rle = await encodeShareCode(sample(), { method: "rle" });
    expect(rle.length).toBeLessThan(1000);
  });

  it("can drop authorship", async () => {
    const m = sample();
    const res = await decodeShareCode(await encodeShareCode(m, { includeAuthors: false }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(shareable(res.snapshot, false)).toEqual(shareable(m.snapshot(), false));
    expect(res.snapshot.authors.every((a) => a === 0)).toBe(true);
    expect(res.playSettings).toBeUndefined();
  });

  it("tolerates whitespace from copy-paste", async () => {
    const code = await encodeShareCode(sample(), { method: "rle" });
    const spaced = code.slice(0, 10) + "\n  " + code.slice(10, 40) + " " + code.slice(40);
    expect((await decodeShareCode(spaced)).ok).toBe(true);
  });

  it("property: random levels round-trip with both packings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.constantFrom(0, 0, 1, 4, 5, 6, 7), { minLength: 360, maxLength: 360 }),
        fc.array(fc.constantFrom(1, 2), { minLength: 360, maxLength: 360 }),
        fc.array(fc.record({ x: fc.nat(29), y: fc.nat(11), k: fc.constantFrom("coin", "fruit", "slime", "ultraslime", "flag", "sign" as const), t: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }) }), { maxLength: 10 }),
        fc.constantFrom("rle" as const, deflateAvailable() ? ("deflate" as const) : ("rle" as const)),
        async (w, h, cells, who, ents, method) => {
          const m = new LevelModel({ w, h, start: { x: 0, y: 0 } });
          for (let i = 0; i < w * h; i++) {
            const t = cells[i];
            if (!t) continue;
            const x = i % w;
            const y = Math.floor(i / w);
            if (who[i] === 2) m.applySuggestion({ id: "g", adds: [{ x, y, tile: t as 1 }], removes: [], entities: [] });
            else m.paintTile(x, y, t as 1);
          }
          for (const e of ents) m.placeEntity(e.k, e.x % w, e.y % h, { text: e.k === "sign" ? e.t : undefined });
          const res = await decodeShareCode(await encodeShareCode(m, { method }));
          expect(res.ok).toBe(true);
          if (res.ok) expect(shareable(res.snapshot)).toEqual(shareable(m.snapshot()));
        },
      ),
      { numRuns: 120 },
    );
  });

  it("rejects garbage without throwing", async () => {
    const good = await encodeShareCode(sample(), { method: "rle" });
    const bad = [
      "",
      "hello",
      "pg1.r",
      "pg1.x.AAAA",
      "pg2.r.AAAA",
      "pg1.r.@@@@",
      "pg1.r.A",
      "pg1.d.AAAAAAAA",
      "pg1.r." + good.split(".")[2].slice(0, 20),
      good.slice(0, -3) + (good.endsWith("A") ? "BBB" : "AAA"),
      123 as unknown as string,
    ];
    for (const code of bad) {
      const res = await decodeShareCode(code);
      expect(res.ok, String(code)).toBe(false);
      if (!res.ok) expect(res.error.length).toBeGreaterThan(5);
    }
  });

  it("property: random byte payloads are rejected or decode to a valid level", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const res = decodePayload(bytes);
        if (res.ok) expect(res.snapshot.cells.length).toBe(res.snapshot.w * res.snapshot.h);
      }),
      { numRuns: 300 },
    );
  });

  it("checksum catches a flipped byte", () => {
    const raw = encodePayload(sample().snapshot());
    raw[20] ^= 0x01;
    const res = decodePayload(raw);
    expect(res.ok).toBe(false);
  });

  it("guards against decompression bombs", async () => {
    // A tiny RLE stream that would expand to far more than any level.
    const bomb = new Uint8Array(40000);
    for (let i = 0; i < bomb.length; i += 2) {
      bomb[i] = 255;
      bomb[i + 1] = 0;
    }
    const res = await decodeShareCode("pg1.r." + toBase64Url(bomb));
    expect(res.ok).toBe(false);
  });
});

describe("packing helpers", () => {
  it("packBits round-trips arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (b) => {
        expect(Array.from(unpackBits(packBits(b)))).toEqual(Array.from(b));
      }),
      { numRuns: 300 },
    );
  });

  it("packBits compresses runs", () => {
    const b = new Uint8Array(4000);
    expect(packBits(b).length).toBeLessThan(70);
  });

  it("unpackBits rejects truncated input", () => {
    expect(() => unpackBits(new Uint8Array([5, 1, 2]))).toThrow();
    expect(() => unpackBits(new Uint8Array([200]))).toThrow();
  });

  it("base64url round-trips and rejects bad input", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (b) => {
        const s = toBase64Url(b);
        expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(Array.from(fromBase64Url(s)!)).toEqual(Array.from(b));
        if (typeof Buffer !== "undefined") expect(s).toBe(Buffer.from(b).toString("base64url"));
      }),
    );
    expect(fromBase64Url("ab+c")).toBeUndefined();
    expect(fromBase64Url("abcde")).toBeUndefined();
    expect(fromBase64Url("é")).toBeUndefined();
  });
});
