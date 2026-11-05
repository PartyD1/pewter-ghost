import { describe, expect, it } from "vitest";
import { fitStageZoom, MAX_STAGE_ZOOM, MIN_STAGE_ZOOM } from "./stageFit";

const stage = { w: 928, h: 720 };
const reserved = { w: 368, h: 94 };

describe("fitStageZoom", () => {
  it("keeps the full size when the window has room, and never scales up", () => {
    expect(fitStageZoom({ view: { w: 2560, h: 1440 }, stage, reserved })).toBe(MAX_STAGE_ZOOM);
  });

  it("shrinks to the height on a short window, so the bottom is not cut off", () => {
    const zoom = fitStageZoom({ view: { w: 1440, h: 700 }, stage, reserved });
    expect(zoom).toBeCloseTo((700 - 94) / 720);
    expect(stage.h * zoom + reserved.h).toBeLessThanOrEqual(700);
  });

  it("shrinks to the width on a narrow window, so the panel stays on screen", () => {
    const zoom = fitStageZoom({ view: { w: 1024, h: 900 }, stage, reserved });
    expect(zoom).toBeCloseTo((1024 - 368) / 928);
    expect(stage.w * zoom + reserved.w).toBeLessThanOrEqual(1024);
  });

  it("stops at the minimum on a tiny window", () => {
    expect(fitStageZoom({ view: { w: 200, h: 100 }, stage, reserved })).toBe(MIN_STAGE_ZOOM);
  });
});
