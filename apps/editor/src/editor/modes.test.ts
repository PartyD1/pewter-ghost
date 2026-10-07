import { describe, expect, it } from "vitest";
import { TILE } from "../contracts";
import { describeMode, MODE_KEY, modeForKey, ModeState, sameBrush, type ModeSnapshot } from "./modes";

describe("ModeState", () => {
  it("starts in Select so a first click is harmless", () => {
    expect(new ModeState().mode).toBe("select");
  });

  it("maps keys 1-4 to Select, Paint, Erase, Pan", () => {
    expect(["1", "2", "3", "4"].map(modeForKey)).toEqual(["select", "paint", "erase", "pan"]);
    expect(modeForKey("5")).toBeUndefined();
    expect(MODE_KEY.pan).toBe("4");
  });

  it("notifies on real changes only", () => {
    const s = new ModeState();
    const seen: [ModeSnapshot, ModeSnapshot][] = [];
    s.subscribe((n, p) => seen.push([n, p]));
    expect(s.setMode("erase")).toBe(true);
    expect(s.setMode("erase")).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0][0].mode).toBe("erase");
    expect(seen[0][1].mode).toBe("select");
  });

  it("picking a brush switches to Paint", () => {
    const s = new ModeState("erase");
    s.setBrush({ kind: "entity", entity: "coin" });
    expect(s.mode).toBe("paint");
    expect(s.brush).toEqual({ kind: "entity", entity: "coin" });
    expect(s.setBrush({ kind: "entity", entity: "coin" })).toBe(false);
  });

  it("Space pans temporarily without losing the chosen mode", () => {
    const s = new ModeState("paint");
    s.setTempPan(true);
    expect(s.effective).toBe("pan");
    expect(s.mode).toBe("paint");
    s.setTempPan(false);
    expect(s.effective).toBe("paint");
  });

  it("a throwing listener does not break the others", () => {
    const s = new ModeState();
    let called = false;
    const orig = console.error;
    console.error = () => {};
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe(() => {
      called = true;
    });
    s.setMode("pan");
    console.error = orig;
    expect(called).toBe(true);
  });

  it("describes the mode for the indicator", () => {
    const name = () => "grass";
    expect(describeMode({ mode: "paint", brush: { kind: "tile", tile: TILE.GRASS }, tempPan: false }, name)).toBe("Paint · grass");
    expect(describeMode({ mode: "erase", brush: { kind: "start" }, tempPan: false }, name)).toBe("Erase");
    expect(describeMode({ mode: "erase", brush: { kind: "start" }, tempPan: true }, name)).toBe("Pan (Space)");
  });

  it("compares brushes", () => {
    expect(sameBrush({ kind: "tile", tile: TILE.DIRT }, { kind: "tile", tile: TILE.DIRT })).toBe(true);
    expect(sameBrush({ kind: "tile", tile: TILE.DIRT }, { kind: "tile", tile: TILE.GRASS })).toBe(false);
    expect(sameBrush({ kind: "entity", entity: "sign", text: "a" }, { kind: "entity", entity: "sign", text: "b" })).toBe(false);
    expect(sameBrush({ kind: "start" }, { kind: "start" })).toBe(true);
  });
});
