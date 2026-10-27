import { describe, expect, it } from "vitest";
import { FILLER_LABELS, TIMING_HINTS, TIMING_LABELS, variantsEnabled } from "./VariantSwitch";
import { TIMING_POLICIES } from "../suggest/timing/policy";

describe("variant switch", () => {
  const prod = { devBuild: false, automated: false };
  const dev = { devBuild: true, automated: false };

  it("shows with ?dev=1 or ?variants=1, in any build", () => {
    expect(variantsEnabled("?dev=1", prod)).toBe(true);
    expect(variantsEnabled("?variants=true", prod)).toBe(true);
    expect(variantsEnabled("?dev=1&token=abc", { devBuild: false, automated: true })).toBe(true);
  });

  it("never shows to a participant: production builds and launcher links", () => {
    expect(variantsEnabled("", prod)).toBe(false);
    expect(variantsEnabled("?filler=llm", prod)).toBe(false);
    expect(variantsEnabled("?token=abc", dev)).toBe(false);
  });

  it("shows in a dev build opened by hand, not in automated browsers", () => {
    expect(variantsEnabled("", dev)).toBe(true);
    expect(variantsEnabled("?filler=stub", dev)).toBe(true);
    expect(variantsEnabled("", { devBuild: true, automated: true })).toBe(false);
  });

  it("labels every timing policy", () => {
    for (const t of TIMING_POLICIES) {
      expect(TIMING_LABELS[t]).toBeTruthy();
      expect(TIMING_HINTS[t]).toBeTruthy();
    }
    expect(Object.keys(FILLER_LABELS)).toEqual(["llm", "algo", "markov", "stub", "none"]);
  });
});
