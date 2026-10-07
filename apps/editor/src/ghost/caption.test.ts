import { describe, expect, it } from "vitest";
import { canvasCaption, cleanText, sanitizeGuess, shortLabel, stripText, TEACHING_GHOSTS } from "./caption";

describe("labels and captions", () => {
  it("uses the label, or a word for the kind", () => {
    expect(shortLabel({ label: "  guarded   reward ", kind: "finish" })).toBe("guarded reward");
    expect(shortLabel({ label: "", kind: "extend" })).toBe("next stretch");
    expect(shortLabel({ label: "x".repeat(80), kind: "fix" }).length).toBeLessThanOrEqual(40);
  });

  it("strips control characters", () => {
    expect(cleanText("a\nb\u0007c")).toBe("a b c");
  });

  it("names Tab on the canvas for the first three ghosts only", () => {
    expect(canvasCaption({ label: "staircase", kind: "finish" }, 1)).toBe("staircase · Tab");
    expect(canvasCaption({ label: "staircase", kind: "finish" }, TEACHING_GHOSTS)).toBe("staircase · Tab");
    expect(canvasCaption({ label: "staircase", kind: "finish" }, TEACHING_GHOSTS + 1)).toBe("staircase");
  });
});

describe("sanitizeGuess", () => {
  it("never reveals the filler or condition", () => {
    for (const w of ["stub", "LLM", "algo", "jev", "none", " Gemini "]) expect(sanitizeGuess(w)).toBeNull();
    expect(sanitizeGuess("")).toBeNull();
    expect(sanitizeGuess(undefined)).toBeNull();
  });

  it("keeps a real guess", () => {
    expect(sanitizeGuess(" parkour ")).toBe("parkour");
    expect(sanitizeGuess("coin run")).toBe("coin run");
  });
});

describe("stripText", () => {
  it("says what Tab does while a ghost is shown (after the teaching ghosts)", () => {
    const t = stripText({ mode: "showing", ghost: { label: "staircase", kind: "finish" }, ordinal: 4, guess: "parkour" });
    expect(t.main).toBe("ghost: staircase · Tab to accept · Esc to dismiss");
    expect(t.guess).toBe("Ghost thinks: parkour");
    expect(t.tone).toBe("ghost");
  });

  it("is longer for the first three ghosts, by kind", () => {
    const f = stripText({ mode: "showing", ghost: { label: "staircase", kind: "finish" }, ordinal: 1 });
    expect(f.main.startsWith("ghost: staircase · ")).toBe(true);
    expect(f.main).toMatch(/Tab keeps them/);
    expect(f.main.length).toBeGreaterThan(60);
    const fix = stripText({ mode: "showing", ghost: { label: "gap 9 · knight clears 6", kind: "fix" }, ordinal: 2 });
    expect(fix.main).toMatch(/crossed-out/);
    expect(fix.main).toMatch(/one undo/);
    const ext = stripText({ mode: "showing", ghost: { label: "pit and landing", kind: "extend" }, ordinal: 3 });
    expect(ext.main).toMatch(/next stretch/);
  });

  it("counts cells left after partial accepts", () => {
    const t = stripText({ mode: "showing", ghost: { label: "steps", kind: "finish" }, ordinal: 9, remaining: 2, total: 5 });
    expect(t.main).toBe("ghost: steps · 2 of 5 left · Tab to accept · Esc to dismiss");
  });

  it("has quiet, asking, playing and off lines", () => {
    expect(stripText({ mode: "quiet" }).main).toBe("quiet · Ctrl+Space to ask");
    expect(stripText({ mode: "asking" }).main).toMatch(/^asked/);
    expect(stripText({ mode: "playing", routeKey: "R" }).main).toMatch(/R shows the checked route/);
    expect(stripText({ mode: "playing" }).main).toBe("playing · Esc to edit");
    expect(stripText({ mode: "off", guess: "parkour" })).toEqual({ guess: null, main: "", tone: "quiet" });
  });

  it("never contains filler names", () => {
    const all = [
      stripText({ mode: "showing", ghost: { label: "steps", kind: "finish" }, ordinal: 1, guess: sanitizeGuess("stub") }),
      stripText({ mode: "quiet", guess: sanitizeGuess("llm") }),
    ];
    for (const t of all) expect(`${t.main} ${t.guess ?? ""}`).not.toMatch(/\b(stub|llm|algo|jev)\b/i);
  });
});
