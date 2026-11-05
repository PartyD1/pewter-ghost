import { describe, expect, it } from "vitest";
import { BriefCache, buildBrief } from "./brief";
import { cleanIntent, INTENT_MAX_CHARS, INTENT_PRESETS, intentLine } from "./intent";

describe("cleanIntent", () => {
  it("collapses whitespace and trims", () => {
    expect(cleanIntent("  a   maze \n with\tdead ends ")).toBe("a maze with dead ends");
  });
  it("clips to the limit", () => {
    expect(cleanIntent("x".repeat(1000)).length).toBe(INTENT_MAX_CHARS);
  });
  it("treats missing input as empty", () => {
    expect(cleanIntent(undefined)).toBe("");
    expect(cleanIntent("   ")).toBe("");
  });
});

describe("intentLine", () => {
  it("is empty without an intent", () => {
    expect(intentLine("")).toBe("");
  });
  it("quotes the builder's words and cannot be broken out of the quotes", () => {
    const line = intentLine('a "maze"');
    expect(line).toContain(`"a 'maze'"`);
  });
});

describe("presets", () => {
  it("have unique ids and fit the limit", () => {
    expect(new Set(INTENT_PRESETS.map((p) => p.id)).size).toBe(INTENT_PRESETS.length);
    for (const p of INTENT_PRESETS) expect(cleanIntent(p.text)).toBe(p.text);
  });
});

describe("brief with an intent", () => {
  it("leads with the intent and stays within budget", () => {
    const b = buildBrief({ intent: INTENT_PRESETS[0].text });
    expect(b.text.startsWith("The builder says")).toBe(true);
  });
  it("is unchanged without an intent", () => {
    expect(buildBrief({ intent: "" }).text).toBe(buildBrief({}).text);
  });
  it("the cache rebuilds when the intent changes", () => {
    const cache = new BriefCache();
    const a = cache.get({ revision: 1, intent: "a maze" });
    const b = cache.get({ revision: 1, intent: "a parkour course" });
    expect(a.text).not.toBe(b.text);
    expect(cache.misses).toBe(2);
  });
});
