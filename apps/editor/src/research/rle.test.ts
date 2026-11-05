import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { LevelSnapshot } from "../contracts";
import { packSnapshot, rleDecode, rleEncode, unpackSnapshot } from "./rle";
import { validateEvent } from "./schema";

describe("rle", () => {
  it("round-trips any array", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 200 }), (a) => {
        expect(rleDecode(rleEncode(a))).toEqual(a);
      }),
    );
  });

  it("shrinks a mostly empty level", () => {
    const a = new Array(4000).fill(0);
    expect(rleEncode(a)).toEqual([0, 4000]);
  });

  it("rejects a length mismatch", () => {
    expect(() => rleDecode([0, 3], 4)).toThrow();
  });
});

describe("packed snapshot", () => {
  const snap: LevelSnapshot = {
    w: 4,
    h: 2,
    cells: [0, 0, 1, 1, 0, 0, 0, 2],
    authors: [0, 0, 1, 1, 0, 0, 0, 2],
    provenance: { 7: "g1" },
    entities: [],
    entityAuthors: {},
    start: { x: 0, y: 0 },
    goal: { x: 3, y: 0 },
  };

  it("round-trips", () => {
    expect(unpackSnapshot(packSnapshot(snap))).toEqual(snap);
  });

  it("is a valid snapshot event", () => {
    const e = { type: "snapshot", t: 0, reason: "start", level: packSnapshot(snap) };
    expect(validateEvent(e, { strict: true })).toMatchObject({ ok: true });
  });
});

describe("replay events in the schema", () => {
  const good = [
    { type: "pointer.path", t: 10, dt: [0, 16, 33], x: [1, 2, 3], y: [4, 5, 6] },
    { type: "pointer.btn", t: 12, x: 5, y: 6, down: true, button: 0 },
    { type: "pointer.edge", t: 13, inside: false },
    { type: "wheel", t: 14, x: 1, y: 2, dx: 0, dy: -100, ctrl: false },
    { type: "key", t: 15, code: "KeyZ", down: true },
    { type: "focus", t: 16, focused: false },
    { type: "camera", t: 17, x: 0, y: 0, w: 40, h: 20, zoom: 1 },
    { type: "tool", t: 18, mode: "paint", brush: "grass" },
    {
      type: "ghost.show",
      t: 19,
      suggestionId: "g1",
      kind: "extend",
      confidence: 0.5,
      shownBecause: "now",
      cells: 2,
      label: "x",
      adds: [[1, 2, 3]],
      removes: [[4, 5]],
      entities: [["coin", 6, 7]],
    },
  ];
  for (const e of good) it(`accepts ${e.type}`, () => expect(validateEvent(e, { strict: true })).toMatchObject({ ok: true }));

  it("rejects a pointer.btn without coordinates", () => {
    expect(validateEvent({ type: "pointer.btn", t: 1, down: true, button: 0 }).ok).toBe(false);
  });
});
