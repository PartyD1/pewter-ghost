import { composeChunk } from "@chunks";
import { describe, expect, it } from "vitest";
import { CAPTION_MAX_WORDS, extendCaption, finishCaption } from "./algoCaption";

const wordCount = (s: string) => s.trim().split(/\s+/).length;

describe("finishCaption", () => {
  it.each([
    ["finish the staircase: 3 more steps (2 wide, rising 1), filled to the base", "staircase, three more steps"],
    ["finish the staircase: 1 more step", "staircase, one more step"],
    ["finish the coin arc: 2 more coins", "coin arc, two more coins"],
    ["continue the coin line: 4 more", "coin line, four more"],
    ["close the pit: a 5-tile floor", "floor across the pit"],
    ["finish the platform: 3 more tiles to match the others", "platform, three more tiles"],
    ["finish the row: 4 more tiles", "row, four more tiles"],
    ["finish the stepping stones: 2 more stones", "stepping stones, two more"],
    ["repeat the pillar: 2 more", "two more pillars"],
    ["repeat the platform: 1 more", "one more platform"],
    ["finish the pillar you are drawing and add 2 more", "finish the pillar, two more"],
    ["finish the unit you are drawing", "finish the unit"],
  ])("%s -> %s", (label, want) => {
    expect(finishCaption(label)).toBe(want);
  });

  it("anything else is cut to the model's limit, without the lead verb", () => {
    const c = finishCaption("finish the zigzag: something long and unusual that keeps going and going on");
    expect(wordCount(c)).toBeLessThanOrEqual(CAPTION_MAX_WORDS);
    expect(c.startsWith("zigzag")).toBe(true);
  });
});

describe("extendCaption", () => {
  it("names the first one or two pieces in plain words", () => {
    expect(extendCaption([{ kind: "pit", phrase: "a 3-wide gap" }, { kind: "flat", phrase: "a flat run" }, { kind: "stairs", phrase: "stairs up, three steps" }])).toBe(
      "3-wide gap, then stairs up, three steps",
    );
    expect(extendCaption([{ kind: "coin_jump", phrase: "a gap with a coin arc" }])).toBe("gap with a coin arc");
    expect(extendCaption([{ kind: "flat", phrase: "a flat run" }])).toBe("more floor");
  });

  it("never runs past eight words and never shows the engine's terse notation", () => {
    for (let seed = 0; seed < 300; seed++) {
      const c = extendCaption(composeChunk({ w: 16, h: 20, ground: 15, seed }).pieces);
      expect(wordCount(c), c).toBeLessThanOrEqual(CAPTION_MAX_WORDS);
      expect(c).not.toMatch(/^extend|\d+x\d+|ledge up \d|block row \d|slime run \d/);
    }
  });
});
