import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW, viewSize } from "./stage";

describe("viewSize: the replay shows what the participant could see, no more", () => {
  it("is the editor's canvas (928 x 720) for the usual camera", () => {
    // 928 px wide at zoom 2.25 is 25.78 tiles; 720 px tall is 20 tiles. This is what the editor logs.
    expect(viewSize({ x: 8, y: 0, w: 928 / 36, h: 20, zoom: 2.25 })).toEqual({ w: 928, h: 720 });
    expect(DEFAULT_VIEW).toEqual({ w: 928, h: 720 });
  });

  it("is about 26 tiles wide, not the 35 a 1280 px stage would show", () => {
    const v = viewSize({ x: 0, y: 0, w: 928 / 36, h: 20, zoom: 2.25 });
    expect(v.w / 36).toBeCloseTo(25.8, 1);
  });

  it("follows the zoom: the same canvas shows fewer tiles when zoomed in", () => {
    const zoomedIn = { x: 0, y: 0, w: 928 / (16 * 4.5), h: 720 / (16 * 4.5), zoom: 4.5 };
    expect(viewSize(zoomedIn)).toEqual({ w: 928, h: 720 });
  });

  it("follows a window or panel that made the visible area smaller or larger", () => {
    expect(viewSize({ x: 0, y: 0, w: 600 / 36, h: 20, zoom: 2.25 })).toEqual({ w: 600, h: 720 }); // a panel laid over the canvas
    expect(viewSize({ x: 0, y: 0, w: 1280 / 36, h: 20, zoom: 2.25 })).toEqual({ w: 1280, h: 720 });
  });

  it("falls back to the editor's canvas with no camera or a nonsense one", () => {
    expect(viewSize(null)).toEqual(DEFAULT_VIEW);
    expect(viewSize(undefined)).toEqual(DEFAULT_VIEW);
    expect(viewSize({ x: 0, y: 0, w: 0, h: 20, zoom: 2.25 })).toEqual(DEFAULT_VIEW);
    expect(viewSize({ x: 0, y: 0, w: 10, h: 10, zoom: 0 })).toEqual(DEFAULT_VIEW);
    expect(viewSize({ x: 0, y: 0, w: 1e6, h: 20, zoom: 2.25 })).toEqual(DEFAULT_VIEW); // absurdly large
    expect(viewSize({ x: 0, y: 0, w: 0.5, h: 0.5, zoom: 1 })).toEqual(DEFAULT_VIEW); // absurdly small
  });

  it("always returns a fresh object (callers may keep it)", () => {
    expect(viewSize(null)).not.toBe(viewSize(null));
  });
});
