import { describe, expect, it } from "vitest";
import { RouteStore, simplifyRoute } from "./routes";

describe("simplifyRoute", () => {
  it("drops repeats and straight-run interior points", () => {
    const p = simplifyRoute([
      { x: 0, y: 5 },
      { x: 0, y: 5 },
      { x: 1, y: 5 },
      { x: 2, y: 5 },
      { x: 3, y: 4 },
      { x: 4, y: 3 },
      { x: 5, y: 3 },
    ]);
    expect(p).toEqual([
      { x: 0, y: 5 },
      { x: 2, y: 5 },
      { x: 4, y: 3 },
      { x: 5, y: 3 },
    ]);
  });

  it("keeps U-turns and drops non-finite points", () => {
    const p = simplifyRoute([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: Number.NaN, y: 0 },
    ]);
    expect(p).toEqual([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
    ]);
  });
});

describe("RouteStore", () => {
  it("finds the route covering a column, most recent first", () => {
    const r = new RouteStore();
    r.add("a", [
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    ]);
    r.add("b", [
      { x: 8, y: 5 },
      { x: 20, y: 5 },
    ]);
    expect(r.forColumn(9)!.id).toBe("b");
    expect(r.forColumn(3)!.id).toBe("a");
    expect(r.forColumn(25)!.id).toBe("b");
    expect(r.forColumn(60)).toBeNull();
    expect(r.forColumn(60, 100)!.id).toBe("b");
  });

  it("ignores empty paths, replaces by id, retains, caps and clears", () => {
    const r = new RouteStore(2);
    expect(r.add("x", [])).toBeNull();
    expect(r.add("x", undefined)).toBeNull();
    expect(r.add("x", [{ x: 1, y: 1 }])).toBeNull();
    r.add("a", [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    r.add("a", [
      { x: 5, y: 0 },
      { x: 6, y: 0 },
    ]);
    expect(r.size).toBe(1);
    expect(r.all()[0].x0).toBe(5);
    r.add("b", [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    r.add("c", [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(r.all().map((x) => x.id)).toEqual(["b", "c"]);
    r.retain((id) => id === "c");
    expect(r.all().map((x) => x.id)).toEqual(["c"]);
    r.clear();
    expect(r.size).toBe(0);
  });
});
