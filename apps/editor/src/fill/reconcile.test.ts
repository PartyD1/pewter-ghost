import { beforeEach, describe, expect, it } from "vitest";
import { TILE, type Suggestion } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import {
  OfferLedger,
  STALE,
  freshness,
  reconcileAnswer,
  reconcileCells,
  snapshotReader,
  type AnswerContext,
  type CellReader,
} from "./reconcile";

/** A two-step staircase answer from (15,11): grass at (15,11), (16,10), and a coin above the top. */
function answer(over: Partial<Suggestion> = {}): Suggestion {
  return {
    id: "a1",
    kind: "finish",
    adds: [
      { x: 15, y: 11, tile: TILE.GRASS },
      { x: 16, y: 10, tile: TILE.GRASS },
    ],
    removes: [],
    entities: [{ kind: "coin", x: 16, y: 9 }],
    confidence: 0.85,
    label: "staircase, two more steps",
    anchor: { x: 15, y: 11 },
    requestHash: "h".repeat(64),
    filler: "llm",
    latencyMs: 2100,
    mode: "auto",
    verified: false,
    attempts: 1,
    ...over,
  };
}

describe("reconcileCells", () => {
  let m: LevelModel;
  let then: CellReader;
  beforeEach(() => {
    m = new LevelModel();
    m.paint([
      { x: 12, y: 14, tile: TILE.GRASS },
      { x: 13, y: 13, tile: TILE.GRASS },
      { x: 20, y: 5, tile: TILE.BLOCK },
    ]);
    then = snapshotReader(m.snapshot());
  });

  it("keeps an answer whose cells nobody touched (other edits do not matter)", () => {
    m.paintTile(14, 12, TILE.GRASS); // the person kept drawing, elsewhere
    const s = answer();
    const r = reconcileCells(s, then, m);
    expect(r).toEqual({ suggestion: s, trimmed: 0, conflicts: [] });
    expect(r.suggestion).toBe(s);
  });

  it("trims cells the person has since drawn with the same tile, and moves the anchor", () => {
    m.paintTile(15, 11, TILE.GRASS);
    const s = answer();
    const r = reconcileCells(s, then, m);
    expect(r.reason).toBeUndefined();
    expect(r.trimmed).toBe(1);
    expect(r.suggestion?.adds).toEqual([{ x: 16, y: 10, tile: TILE.GRASS }]);
    expect(r.suggestion?.entities).toEqual(s.entities);
    expect(r.suggestion?.anchor).toEqual({ x: 16, y: 10 });
    expect(r.suggestion?.id).toBe("a1");
    // The input is untouched.
    expect(s.adds).toHaveLength(2);
    expect(s.anchor).toEqual({ x: 15, y: 11 });
  });

  it("drops an answer whose cells were drawn with something else", () => {
    m.paintTile(16, 10, TILE.DIRT);
    const r = reconcileCells(answer(), then, m);
    expect(r.suggestion).toBeNull();
    expect(r.reason).toBe(STALE.cellsDrawn);
    expect(r.conflicts).toEqual([{ x: 16, y: 10 }]);
  });

  it("drops it when a proposed tile already there was erased, or a proposed entity cell was painted", () => {
    // An add over a cell that had a tile at request time and was erased since: drawn on.
    const s = answer({ adds: [{ x: 20, y: 5, tile: TILE.GRASS }], entities: [], anchor: { x: 20, y: 5 } });
    m.erase([{ x: 20, y: 5 }]);
    expect(reconcileCells(s, then, m).reason).toBe(STALE.cellsDrawn);

    const m2 = new LevelModel();
    const then2 = snapshotReader(m2.snapshot());
    m2.paintTile(16, 9, TILE.BLOCK); // where the coin was proposed
    expect(reconcileCells(answer(), then2, m2)).toMatchObject({ suggestion: null, reason: STALE.cellsDrawn, conflicts: [{ x: 16, y: 9 }] });
  });

  it("trims a removal the person erased and an entity they placed as proposed; a different entity conflicts", () => {
    const fix = answer({
      kind: "fix",
      adds: [{ x: 21, y: 5, tile: TILE.BLOCK }],
      removes: [{ x: 20, y: 5 }],
      entities: [{ kind: "coin", x: 22, y: 4 }],
      anchor: { x: 20, y: 5 },
    });
    m.erase([{ x: 20, y: 5 }]);
    m.placeEntity("coin", 22, 4);
    const r = reconcileCells(fix, then, m);
    expect(r.trimmed).toBe(2);
    expect(r.suggestion).toMatchObject({ adds: [{ x: 21, y: 5 }], removes: [], entities: [], anchor: { x: 21, y: 5 } });

    const m2 = new LevelModel();
    m2.paintTile(20, 5, TILE.BLOCK);
    const then2 = snapshotReader(m2.snapshot());
    m2.placeEntity("fruit", 22, 4);
    expect(reconcileCells(fix, then2, m2).reason).toBe(STALE.cellsDrawn);
  });

  it("drops an answer the person has drawn completely ('all cells drawn': right, but late)", () => {
    m.paintTile(15, 11, TILE.GRASS);
    m.paintTile(16, 10, TILE.GRASS);
    m.placeEntity("coin", 16, 9);
    const r = reconcileCells(answer(), then, m);
    expect(r).toMatchObject({ suggestion: null, trimmed: 3, reason: STALE.allDrawn, conflicts: [] });
  });

  it("snapshotReader matches the live model", () => {
    m.placeEntity("slime", 5, 14);
    const snap = snapshotReader(m.snapshot());
    for (const [x, y] of [
      [12, 14],
      [20, 5],
      [0, 0],
      [-1, 3],
      [500, 3],
    ])
      expect(snap.tileAt(x, y)).toBe(m.tileAt(x, y));
    expect(snap.entitiesAt(5, 14).map((e) => e.kind)).toEqual(["slime"]);
    expect(snap.entitiesAt(6, 14)).toEqual([]);
  });
});

describe("reconcileAnswer / freshness", () => {
  const ctx = (over: Partial<AnswerContext> = {}): AnswerContext => ({
    seq: 1,
    requestedAt: 1000,
    now: 3100,
    ledger: new OfferLedger(),
    maxAgeMs: 8000,
    margin: 1,
    ...over,
  });
  const level = new LevelModel();
  const then = snapshotReader(level.snapshot());

  it("drops an answer whose request is older than maxAgeMs", () => {
    expect(reconcileAnswer(answer(), then, level, ctx({ now: 9000 })).reason).toBeUndefined(); // exactly 8000 ms: still fine
    const r = reconcileAnswer(answer(), then, level, ctx({ now: 9001 }));
    expect(r).toMatchObject({ suggestion: null, reason: STALE.tooOld });
    expect(freshness(answer(), ctx({ now: 9001 }))).toBe(STALE.tooOld);
  });

  it("drops an older answer once a newer overlapping one was offered; never the other way round", () => {
    const ledger = new OfferLedger();
    // Request 3's answer (one step further up) was verified and offered.
    ledger.record(3, answer({ id: "a3", adds: [{ x: 17, y: 9, tile: TILE.GRASS }], entities: [], anchor: { x: 17, y: 9 } }), 2500);
    // Request 1's answer arrives late: it overlaps (coin at 16,9 is next to 17,9).
    expect(reconcileAnswer(answer(), then, level, ctx({ seq: 1, ledger })).reason).toBe(STALE.newerShown);
    // A newer request's answer is not blocked by an older offer.
    expect(reconcileAnswer(answer(), then, level, ctx({ seq: 4, ledger })).suggestion).not.toBeNull();
    // Far away: not the same structure.
    const far = answer({ adds: [{ x: 60, y: 10, tile: TILE.GRASS }], entities: [], anchor: { x: 60, y: 10 } });
    expect(reconcileAnswer(far, then, level, ctx({ seq: 1, ledger })).suggestion).toBe(far);
    // The margin decides "overlapping": two tiles apart is not with margin 1.
    const twoOff = answer({ adds: [{ x: 19, y: 9, tile: TILE.GRASS }], entities: [], anchor: { x: 19, y: 9 } });
    expect(freshness(twoOff, ctx({ seq: 1, ledger }))).toBeNull();
    expect(freshness(twoOff, ctx({ seq: 1, ledger, margin: 2 }))).toBe(STALE.newerShown);
  });

  it("checks the TRIMMED answer against newer offers", () => {
    const m = new LevelModel();
    const t0 = snapshotReader(m.snapshot());
    m.paintTile(15, 11, TILE.GRASS);
    m.paintTile(16, 10, TILE.GRASS);
    const ledger = new OfferLedger();
    // A newer offer at (14,12): with margin 1 it touches the untrimmed answer at (15,11)...
    const near = answer({ id: "near", adds: [{ x: 14, y: 12, tile: TILE.GRASS }], entities: [], anchor: { x: 14, y: 12 } });
    ledger.record(2, near, 0);
    expect(ledger.newerOverlapping(1, answer(), 1)).toBe(true);
    // ...but (15,11) and (16,10) were drawn as proposed, and what is left (the coin at 16,9) is clear of it.
    const r = reconcileAnswer(answer(), t0, m, ctx({ seq: 1, ledger }));
    expect(r.reason).toBeUndefined();
    expect(r.trimmed).toBe(2);
    expect(r.suggestion?.adds).toEqual([]);
    expect(r.suggestion?.entities).toEqual([{ kind: "coin", x: 16, y: 9 }]);
    expect(r.suggestion?.anchor).toEqual({ x: 16, y: 9 });
  });

  it("OfferLedger prunes by time and caps its size", () => {
    const l = new OfferLedger(3);
    for (let i = 1; i <= 5; i++) l.record(i, answer(), i * 100);
    expect(l.size).toBe(3);
    l.prune(450);
    expect(l.size).toBe(1);
    expect(l.newerOverlapping(4, answer(), 0)).toBe(true);
    expect(l.newerOverlapping(5, answer(), 0)).toBe(false);
    l.clear();
    expect(l.size).toBe(0);
  });
});
