import { describe, expect, it } from "vitest";
import { clampCenter, easeOutCubic, fitZoom, nudgeTarget, screenToWorld, wheelIntent, zoomAround, zoomLimits } from "./cameraMath";

const level = { w: 3200, h: 320 };
const vp = { w: 1280, h: 720 };

describe("camera math", () => {
  it("fit zoom shows the whole level height", () => {
    const z = fitZoom(vp, level);
    expect(320 * z).toBeLessThanOrEqual(720);
    const lim = zoomLimits(vp, level);
    expect(lim.min).toBeLessThan(z);
    expect(lim.max).toBeGreaterThan(z);
  });

  it("clamps the centre to the level and centres an axis that fits", () => {
    const z = 2;
    const c = clampCenter({ x: -500, y: 9999 }, z, vp, level);
    expect(c.x).toBeCloseTo(1280 / 2 / z - 48);
    // view 360 world px tall, level 320 + 2*48 pad: clamped to the bottom edge
    expect(c.y).toBe(320 - 180 + 48);
    // at zoom 1 the view (720) is taller than level + pad: centred
    expect(clampCenter({ x: 0, y: 9999 }, 1, vp, level).y).toBe(160);
    const far = clampCenter({ x: 99999, y: 160 }, z, vp, level);
    expect(far.x).toBeCloseTo(3200 - 320 + 48);
  });

  it("zooms around an anchor that stays put on screen", () => {
    const center = { x: 500, y: 160 };
    const anchor = { x: 600, y: 100 };
    const nc = zoomAround(center, 2, 4, anchor);
    const before = { x: (anchor.x - center.x) * 2, y: (anchor.y - center.y) * 2 };
    const after = { x: (anchor.x - nc.x) * 4, y: (anchor.y - nc.y) * 4 };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("converts screen to world", () => {
    expect(screenToWorld({ x: 640, y: 360 }, { x: 100, y: 50 }, 2, vp)).toEqual({ x: 100, y: 50 });
    expect(screenToWorld({ x: 0, y: 0 }, { x: 100, y: 50 }, 2, vp)).toEqual({ x: 100 - 320, y: 50 - 180 });
  });

  it("nudges only as far as needed and not at all when visible", () => {
    const c = { x: 400, y: 160 };
    expect(nudgeTarget(c, 2, vp, { x: 400, y: 160, w: 16, h: 16 }, 32)).toBeNull();
    const n = nudgeTarget(c, 2, vp, { x: 1000, y: 160, w: 16, h: 16 }, 32)!;
    // right edge of view = 400 + 320 - 32 = 688; target right = 1016 -> move by 328
    expect(n.x).toBeCloseTo(728);
    expect(n.y).toBe(160);
    const left = nudgeTarget(c, 2, vp, { x: 0, y: 160, w: 16, h: 16 }, 32)!;
    expect(left.x).toBeCloseTo(400 - (400 - 320 + 32));
  });

  it("wheel: pinch / ctrl zooms, two-finger pans, vertical wheel scrolls sideways when the level fits", () => {
    const pinch = wheelIntent({ deltaX: 0, deltaY: -10, ctrlKey: true }, true);
    expect(pinch.kind).toBe("zoom");
    expect(pinch.kind === "zoom" && pinch.factor).toBeGreaterThan(1);
    expect(wheelIntent({ deltaX: 12, deltaY: 3 }, true)).toEqual({ kind: "pan", dx: 12, dy: 3 });
    expect(wheelIntent({ deltaX: 0, deltaY: 50 }, true)).toEqual({ kind: "pan", dx: 50, dy: 0 });
    expect(wheelIntent({ deltaX: 0, deltaY: 50 }, false)).toEqual({ kind: "pan", dx: 0, dy: 50 });
    expect(wheelIntent({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: true }, false)).toEqual({ kind: "pan", dx: 48, dy: 0 });
  });

  it("ease is monotone from 0 to 1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(2)).toBe(1);
  });
});
