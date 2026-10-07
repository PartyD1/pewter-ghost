import { describe, expect, it } from "vitest";
import { PyRandom } from "./rng";

// Golden values from CPython 3.11: random.Random(seed).
describe("PyRandom (CPython random.Random parity)", () => {
  it("seed 0: random, randint, choice, getrandbits", () => {
    const r = new PyRandom(0);
    expect([r.random(), r.random(), r.random()]).toEqual([0.8444218515250481, 0.7579544029403025, 0.420571580830845]);
    expect([1, 2, 3, 4, 5].map(() => r.randint(1, 6))).toEqual([3, 5, 4, 4, 3]);
    expect(r.choice("abcdefg".split(""))).toBe("d");
    expect(r.getrandbits(32)).toBe(1537810351);
  });

  it("seed 7: randint stream", () => {
    const r = new PyRandom(7);
    expect(Array.from({ length: 8 }, () => r.randint(2, 9))).toEqual([7, 4, 8, 2, 3, 3, 7, 2]);
    expect(r.random()).toBe(0.9097040631431023);
  });

  it("multi-word seed", () => {
    const r = new PyRandom(123456789012);
    expect(r.random()).toBe(0.37701448538609916);
    expect(r.randint(0, 100)).toBe(2);
  });

  it("negative seeds equal their absolute value (as in Python)", () => {
    expect(new PyRandom(-5).random()).toBe(new PyRandom(5).random());
  });

  it("rejects bad arguments", () => {
    expect(() => new PyRandom(1.5)).toThrow(RangeError);
    expect(() => new PyRandom(0).randint(3, 2)).toThrow(RangeError);
    expect(() => new PyRandom(0).choice([])).toThrow(RangeError);
  });
});
