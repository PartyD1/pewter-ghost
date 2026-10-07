import { describe, expect, it } from "vitest";
import { ArgError, autoName, bool, configFromFlags, list, num, parseArgs, parseWindow, str } from "./args";
import { DEFAULT_RUN_CONFIG } from "./run";

describe("parseArgs", () => {
  it("splits command, positionals and flags", () => {
    const a = parseArgs(["compare", "runA", "runB", "--report", "x", "--strict"]);
    expect(a.command).toBe("compare");
    expect(a.positionals).toEqual(["runA", "runB"]);
    expect(a.flags).toEqual({ report: "x", strict: true });
  });

  it("supports --k=v, --no-bool, repeats and --", () => {
    const a = parseArgs(["run", "--data=a.jsonl", "--data", "b", "--no-brief", "--examples=off", "--", "--weird"]);
    expect(a.flags.data).toEqual(["a.jsonl", "b"]);
    expect(a.flags.brief).toBe(false);
    expect(a.flags.examples).toBe(false);
    expect(a.positionals).toEqual(["--weird"]);
  });

  it("rejects a value flag without a value and a bad switch value", () => {
    expect(() => parseArgs(["run", "--model"])).toThrow(ArgError);
    expect(() => parseArgs(["run", "--model", "--strict"])).toThrow(/needs a value/);
    expect(() => parseArgs(["run", "--strict=maybe"])).toThrow(/switch/);
  });

  it("reads typed values", () => {
    const { flags } = parseArgs(["x", "--n", "3", "--l", "a,b", "--l", "c", "--b", "off", "--f", "0.5"]);
    expect(num(flags, "n", { int: true })).toBe(3);
    expect(list(flags, "l")).toEqual(["a", "b", "c"]);
    expect(bool(flags, "b")).toBe(false);
    expect(str(flags, "f")).toBe("0.5");
    expect(() => num(flags, "f", { int: true })).toThrow(/integer/);
    expect(() => num(flags, "n", { max: 2 })).toThrow(/<= 2/);
    expect(num(flags, "missing")).toBeUndefined();
  });
});

describe("parseWindow", () => {
  it("parses COLSxROWS within range", () => {
    expect(parseWindow("24x12")).toEqual({ cols: 24, rows: 12 });
    expect(parseWindow("32X14")).toEqual({ cols: 32, rows: 14 });
    expect(() => parseWindow("24by12")).toThrow(ArgError);
    expect(() => parseWindow("4x4")).toThrow(/out of range/);
  });
});

describe("configFromFlags", () => {
  const cfg = (argv: string[], prefix = "") => configFromFlags(parseArgs(["run", ...argv]).flags, DEFAULT_RUN_CONFIG, prefix, (f) => ({ text: `SYS ${f}`, version: "custom-1" }));

  it("defaults to the default config with a derived name", () => {
    const c = cfg([]);
    expect(c).toMatchObject({ model: DEFAULT_RUN_CONFIG.model, confidenceSource: "stated", samples: 1, sendBack: "always", thinkingBudget: 0 });
    expect(c.name).toBe(DEFAULT_RUN_CONFIG.model);
  });

  it("reads every setting", () => {
    const c = cfg([
      "--model", "gemini-x", "--window", "16x10", "--summary", "off", "--examples", "--no-brief",
      "--confidence", "logprob", "--samples", "2", "--temperature", "0.7", "--thinking", "default",
      "--send-back", "budget", "--agent-cap", "500", "--budget", "1200", "--system", "draft.md",
    ]);
    expect(c).toMatchObject({
      model: "gemini-x",
      window: { cols: 16, rows: 10 },
      summary: false,
      examples: true,
      compactUser: true,
      confidenceSource: "logprob",
      samples: 2,
      temperature: 0.7,
      thinkingBudget: null,
      sendBack: "budget",
      agentCapMs: 500,
      callTimeoutMs: 1200,
      systemOverride: { text: "SYS draft.md", version: "custom-1" },
    });
    expect(c.name).toBe(autoName(c));
    expect(c.name).toContain("16x10");
  });

  it("twoSample forces two samples", () => {
    expect(cfg(["--confidence", "twoSample"]).samples).toBe(2);
  });

  it("uses prefixed flags for compare", () => {
    const a = cfg(["--a-model", "m1", "--b-model", "m2", "--b-window", "32x14"], "a-");
    const b = cfg(["--a-model", "m1", "--b-model", "m2", "--b-window", "32x14"], "b-");
    expect(a.model).toBe("m1");
    expect(a.window).toBeUndefined();
    expect(b).toMatchObject({ model: "m2", window: { cols: 32, rows: 14 } });
  });

  it("rejects bad values", () => {
    expect(() => cfg(["--confidence", "vibes"])).toThrow(/one of/);
    expect(() => cfg(["--send-back", "sometimes"])).toThrow(ArgError);
    expect(() => cfg(["--model", "bad/model"])).toThrow(/invalid model/);
    expect(() => cfg(["--samples", "3"])).toThrow(/<= 2/);
    expect(() => cfg(["--thinking", "lots"])).toThrow(/budget/);
    expect(() => cfg(["--name", "has space"])).toThrow(/letters/);
  });
});
