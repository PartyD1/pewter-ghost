import { beforeEach, describe, expect, it } from "vitest";
import { TILE, type FillRequest, type ModelAnswer } from "../contracts";
import { clampConfidence, cleanLabel, convertModelAnswer, modelAnswerToSuggestion, nextSuggestionId, resetSuggestionIds } from "./answer";
import { windowToLevel } from "./window";

const req: Pick<FillRequest, "origin" | "size" | "mode"> = { origin: { x: 40, y: 8 }, size: { w: 24, h: 12 }, mode: "auto" };
const meta = { filler: "llm" as const, requestHash: "0123456789abcdef", latencyMs: 412.6 };

function answer(over: Partial<ModelAnswer> = {}): ModelAnswer {
  return {
    act: true,
    kind: "extend",
    adds: [
      { x: 3, y: 9, tile: "grass" },
      { x: 4, y: 8, tile: "block" },
    ],
    removes: [],
    entities: [{ kind: "coin", x: 4, y: 7 }],
    confidence: 0.7,
    label: "two steps up",
    ...over,
  };
}

beforeEach(() => resetSuggestionIds());

describe("modelAnswerToSuggestion", () => {
  it("converts window-relative names to level coordinates and TileIds", () => {
    const s = modelAnswerToSuggestion(answer({ levelGuess: " parkour " }), req, meta)!;
    expect(s.adds).toEqual([
      { x: 43, y: 17, tile: TILE.GRASS },
      { x: 44, y: 16, tile: TILE.BLOCK },
    ]);
    expect(s.entities).toEqual([{ kind: "coin", x: 44, y: 15 }]);
    expect(s.anchor).toEqual({ x: 43, y: 17 });
    expect(s).toMatchObject({
      id: "llm-1-01234567",
      kind: "extend",
      confidence: 0.7,
      label: "two steps up",
      levelGuess: "parkour",
      requestHash: meta.requestHash,
      filler: "llm",
      latencyMs: 413,
      mode: "auto",
      verified: false,
      attempts: 1,
    });
    expect(modelAnswerToSuggestion(answer(), req, meta)!.id).toBe("llm-2-01234567");
  });

  it("every tile name maps to its id", () => {
    const names = ["block", "grass_half", "dirt", "grass", "question"] as const;
    const s = modelAnswerToSuggestion(answer({ adds: names.map((tile, i) => ({ x: i, y: 0, tile })), entities: [] }), req, meta)!;
    expect(s.adds.map((a) => a.tile)).toEqual([TILE.BLOCK, TILE.GRASS_HALF, TILE.DIRT, TILE.GRASS, TILE.QUESTION]);
  });

  it("returns null when the model declines or nothing usable is left", () => {
    expect(modelAnswerToSuggestion(answer({ act: false }), req, meta)).toBeNull();
    const r = convertModelAnswer(answer({ adds: [{ x: 30, y: 0, tile: "grass" }], entities: [] }), req, meta);
    expect(r.suggestion).toBeNull();
    expect(r.empty).toBe("nothing-left");
    expect(r.dropped).toEqual([{ what: "add", x: 30, y: 0, reason: "outside-window" }]);
    expect(convertModelAnswer(answer({ act: false }), req, meta).empty).toBe("declined");
  });

  it("drops (never clamps) cells outside the window, on every edge", () => {
    const r = convertModelAnswer(
      answer({
        adds: [
          { x: -1, y: 0, tile: "grass" },
          { x: 24, y: 0, tile: "grass" },
          { x: 0, y: -1, tile: "grass" },
          { x: 0, y: 12, tile: "grass" },
          { x: 0, y: 0, tile: "grass" },
          { x: 23, y: 11, tile: "grass" },
        ],
        entities: [{ kind: "coin", x: 5, y: 12 }],
      }),
      req,
      meta,
    );
    expect(r.suggestion!.adds).toEqual([
      { x: 40, y: 8, tile: TILE.GRASS },
      { x: 63, y: 19, tile: TILE.GRASS },
    ]);
    expect(r.suggestion!.entities).toEqual([]);
    expect(r.dropped.filter((d) => d.reason === "outside-window")).toHaveLength(5);
  });

  it("rounds fractional coordinates and drops non-finite ones", () => {
    const r = convertModelAnswer(
      answer({
        adds: [
          { x: 2.4, y: 3.6, tile: "dirt" },
          { x: Number.NaN, y: 1, tile: "dirt" },
          { x: "5" as unknown as number, y: 1, tile: "dirt" },
          { x: Infinity, y: 1, tile: "dirt" },
        ],
        entities: [],
      }),
      req,
      meta,
    );
    expect(r.suggestion!.adds).toEqual([
      { x: 42, y: 12, tile: TILE.DIRT },
      { x: 45, y: 9, tile: TILE.DIRT },
    ]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["not-finite", "not-finite"]);
  });

  it("drops unknown tiles and entity kinds", () => {
    const r = convertModelAnswer(
      answer({
        adds: [
          { x: 1, y: 1, tile: "lava" as never },
          { x: 2, y: 1, tile: "constructor" as never },
          { x: 3, y: 1, tile: "grass" },
        ],
        entities: [
          { kind: "dragon" as never, x: 1, y: 0 },
          { kind: "slime", x: 3, y: 0 },
        ],
      }),
      req,
      meta,
    );
    expect(r.suggestion!.adds).toHaveLength(1);
    expect(r.suggestion!.entities).toEqual([{ kind: "slime", x: 43, y: 8 }]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["unknown-tile", "unknown-tile", "unknown-entity"]);
  });

  it("keeps the first of duplicate cells and drops entities inside added solids", () => {
    const r = convertModelAnswer(
      answer({
        adds: [
          { x: 1, y: 1, tile: "grass" },
          { x: 1, y: 1, tile: "dirt" },
          { x: 1.2, y: 0.8, tile: "dirt" },
        ],
        entities: [
          { kind: "coin", x: 1, y: 1 },
          { kind: "coin", x: 1, y: 0 },
          { kind: "fruit", x: 1, y: 0 },
        ],
      }),
      req,
      meta,
    );
    expect(r.suggestion!.adds).toEqual([{ x: 41, y: 9, tile: TILE.GRASS }]);
    expect(r.suggestion!.entities).toEqual([{ kind: "coin", x: 41, y: 8 }]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate", "duplicate", "entity-in-solid", "duplicate"]);
  });

  it("removes: only for fixes, not under adds, deduplicated; anchor is the fix point", () => {
    const fix = convertModelAnswer(
      answer({
        kind: "fix",
        adds: [{ x: 6, y: 9, tile: "grass" }],
        removes: [
          { x: 6, y: 9 },
          { x: 7, y: 9 },
          { x: 7, y: 9 },
        ],
        entities: [],
      }),
      req,
      meta,
    );
    expect(fix.suggestion!.removes).toEqual([{ x: 47, y: 17 }]);
    expect(fix.suggestion!.anchor).toEqual({ x: 47, y: 17 });
    expect(fix.dropped.map((d) => d.reason)).toEqual(["remove-under-add", "duplicate"]);

    const ext = convertModelAnswer(answer({ removes: [{ x: 1, y: 1 }] }), req, meta);
    expect(ext.suggestion!.removes).toEqual([]);
    expect(ext.dropped).toEqual([{ what: "remove", x: 1, y: 1, reason: "remove-not-fix" }]);
  });

  it("anchor falls back to the first add, entity, then remove", () => {
    expect(modelAnswerToSuggestion(answer({ kind: "fix" }), req, meta)!.anchor).toEqual({ x: 43, y: 17 });
    expect(modelAnswerToSuggestion(answer({ adds: [] }), req, meta)!.anchor).toEqual({ x: 44, y: 15 });
    const removeOnly = modelAnswerToSuggestion(answer({ kind: "fix", adds: [], entities: [], removes: [{ x: 0, y: 0 }] }), req, meta)!;
    expect(removeOnly.anchor).toEqual({ x: 40, y: 8 });
  });

  it("clamps confidence and cleans the label", () => {
    expect(modelAnswerToSuggestion(answer({ confidence: 1.7 }), req, meta)!.confidence).toBe(1);
    expect(modelAnswerToSuggestion(answer({ confidence: -2 }), req, meta)!.confidence).toBe(0);
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence("0.4")).toBe(0.4);
    expect(cleanLabel("  a \n  b  ")).toBe("a b");
    expect(cleanLabel(undefined)).toBe("");
    expect(cleanLabel("x".repeat(200))).toHaveLength(80);
  });

  it("uses meta id / idGen / attempts and the request mode", () => {
    const s = modelAnswerToSuggestion(answer(), { ...req, mode: "patrol" }, { ...meta, id: "fixed", attempts: 2 })!;
    expect(s.id).toBe("fixed");
    expect(s.attempts).toBe(2);
    expect(s.mode).toBe("patrol");
    const g = modelAnswerToSuggestion(answer(), req, { ...meta, idGen: ({ filler }) => `${filler}-custom` })!;
    expect(g.id).toBe("llm-custom");
    expect(nextSuggestionId({ filler: "stub", requestHash: "" })).toBe("stub-1-nohash");
  });

  it("tolerates missing arrays", () => {
    const s = modelAnswerToSuggestion(
      { act: true, kind: "extend", adds: [{ x: 0, y: 0, tile: "grass" }], confidence: 0.5, label: "x" } as unknown as ModelAnswer,
      req,
      meta,
    )!;
    expect(s.removes).toEqual([]);
    expect(s.entities).toEqual([]);
  });

  it("round-trips: every window cell converts to windowToLevel of itself", () => {
    const adds: ModelAnswer["adds"] = [];
    for (let y = 0; y < 12; y++) for (let x = 0; x < 24; x++) adds.push({ x, y, tile: "grass" as const });
    const s = modelAnswerToSuggestion(answer({ adds, entities: [] }), req, meta)!;
    expect(s.adds).toHaveLength(24 * 12);
    s.adds.forEach((a, i) => expect({ x: a.x, y: a.y }).toEqual(windowToLevel(adds[i], req)));
  });
});
