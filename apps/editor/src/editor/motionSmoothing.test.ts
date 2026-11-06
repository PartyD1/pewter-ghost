import { describe, expect, it } from "vitest";
import { MotionInterpolator, TELEPORT_PX } from "./motionSmoothing";

const at = (x: number, y = 0) => ({ x, y });

describe("MotionInterpolator", () => {
  it("draws between the last two physics positions and restores the real one", () => {
    const m = new MotionInterpolator();
    const o = at(0);
    m.beginDraw([o], 0, 0);
    m.endDraw();

    o.x = 4; // a physics step moved it
    m.beginDraw([o], 1, 0.25);
    expect(o.x).toBe(1);
    m.endDraw();
    expect(o.x).toBe(4);

    m.beginDraw([o], 0, 0.75); // no step this frame: carries on along the same segment
    expect(o.x).toBe(3);
    m.endDraw();
    expect(o.x).toBe(4);
  });

  it("drawn motion never goes backward across steps at a steady speed", () => {
    const m = new MotionInterpolator();
    const o = at(0);
    const drawn: number[] = [];
    let elapsed = 0;
    let real = 0;
    for (let frame = 0; frame < 240; frame++) {
      elapsed += 1000 / 144;
      let steps = 0;
      while (elapsed >= 1000 / 60) {
        elapsed -= 1000 / 60;
        real += 3.6;
        steps++;
      }
      o.x = real;
      m.beginDraw([o], steps, elapsed / (1000 / 60));
      drawn.push(o.x);
      m.endDraw();
    }
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!).toBeGreaterThanOrEqual(drawn[i - 1]!);
  });

  it("interpolates across the last step when a slow frame ran several", () => {
    const m = new MotionInterpolator();
    const o = at(0);
    m.beginDraw([o], 0, 0);
    m.endDraw();
    o.x = 9;
    m.beginDraw([o], 3, 0.5);
    expect(o.x).toBe(7.5); // between 6 and 9
    m.endDraw();
  });

  it("jumps straight to a teleport, with or without a physics step that frame", () => {
    const m = new MotionInterpolator();
    const o = at(500, 100);
    m.beginDraw([o], 0, 0);
    m.endDraw();

    o.x = 16; // respawn on a frame with no step, however short the distance
    m.beginDraw([o], 0, 0.5);
    expect(o.x).toBe(16);
    m.endDraw();

    o.x = 16 + TELEPORT_PX + 1; // on a frame with a step, too far for one step
    m.beginDraw([o], 1, 0.5);
    expect(o.x).toBe(16 + TELEPORT_PX + 1);
    m.endDraw();

    o.y = 300; // either axis counts
    m.beginDraw([o], 1, 0.5);
    expect(o.y).toBe(300);
    m.endDraw();
  });

  it("draws a new object where it is", () => {
    const m = new MotionInterpolator();
    const o = at(42, 7);
    m.beginDraw([o], 1, 0.5);
    expect(o).toEqual({ x: 42, y: 7 });
    m.endDraw();
  });

  it("a drawn shift is undone by endDraw and never touches an object outside a draw", () => {
    const m = new MotionInterpolator();
    const o = at(10, 20);
    m.shiftDrawn(o, 5, 5);
    expect(o).toEqual({ x: 10, y: 20 });
    m.beginDraw([o], 0, 0);
    m.shiftDrawn(o, 0.25, -0.25);
    expect(o).toEqual({ x: 10.25, y: 19.75 });
    m.endDraw();
    expect(o).toEqual({ x: 10, y: 20 });
    m.shiftDrawn(o, 5, 5);
    expect(o).toEqual({ x: 10, y: 20 });
  });

  it("clamps alpha, and beginning twice cannot lose the real position", () => {
    const m = new MotionInterpolator();
    const o = at(0);
    m.beginDraw([o], 0, 0);
    m.endDraw();
    o.x = 4;
    m.beginDraw([o], 1, 7);
    expect(o.x).toBe(4);
    m.beginDraw([o], 0, 0);
    m.endDraw();
    expect(o.x).toBe(4);
  });
});
