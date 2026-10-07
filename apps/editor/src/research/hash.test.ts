import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashRequest, sha256Hex } from "./hash";

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("matches JSON.stringify on primitives and keeps array order", () => {
    for (const v of ["x\n\"", 0, -1.5, true, false, null, [3, 1, 2]]) expect(canonicalJson(v)).toBe(JSON.stringify(v));
    expect(canonicalJson([undefined, NaN, Infinity])).toBe("[null,null,null]");
  });
  it("is key-order independent", () => {
    expect(canonicalJson({ x: 1, y: { p: 1, q: 2 } })).toBe(canonicalJson({ y: { q: 2, p: 1 }, x: 1 }));
  });
  it("throws on cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/cyclic/);
  });
  it("allows shared (non-cyclic) references", () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe("sha256Hex", () => {
  it("agrees with node:crypto", async () => {
    for (const s of ["", "abc", "ünïcødé ✓", "x".repeat(10_000)]) {
      expect(await sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
  it("hashRequest = sha256(canonicalJson(request))", async () => {
    const req = { b: 2, a: 1 };
    expect(await hashRequest(req)).toBe(createHash("sha256").update('{"a":1,"b":2}').digest("hex"));
  });
});
