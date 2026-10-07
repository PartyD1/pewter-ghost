import { describe, expect, it } from "vitest";
import { enemyTuning } from "../editor/playSettings";
import {
  createSlimeState,
  createUltraState,
  isStomp,
  patrolRangePx,
  SLIME,
  stepSlime,
  stepUltraSlime,
  ULTRA,
  type Shot,
} from "./brains";

const normal = enemyTuning(1);

function runSlime(hz: number, seconds: number, range: [number, number]) {
  const s = createSlimeState();
  let x = (range[0] + range[1]) / 2;
  const shots: Shot[] = [];
  const dt = 1000 / hz;
  let minX = x;
  let maxX = x;
  for (let t = 0; t < seconds * 1000 - 1e-6; t += dt) {
    const out = stepSlime(s, dt, x, range, normal);
    x += (out.vx * dt) / 1000;
    shots.push(...out.shots);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  return { x, shots: shots.length, minX, maxX };
}

function runUltra(hz: number, seconds: number, player: { x: number; y: number } | undefined, tuning = normal) {
  const s = createUltraState();
  let x = 100;
  const range: [number, number] = [40, 200];
  let shots = 0;
  let mega = 0;
  let warned = 0;
  const dt = 1000 / hz;
  for (let t = 0; t < seconds * 1000 - 1e-6; t += dt) {
    const out = stepUltraSlime(s, dt, { x, y: 50 }, player, range, tuning);
    x += (out.vx * dt) / 1000;
    shots += out.shots.length;
    mega += out.shots.filter((q) => q.mega).length;
    if (out.warning) warned += dt;
  }
  return { x, shots, mega, warned };
}

describe("patrol ranges", () => {
  it("maps tile spans to centre pixels", () => {
    expect(patrolRangePx([2, 5], 0)).toEqual([40, 88]);
    expect(patrolRangePx(undefined, 77)).toEqual([77, 77]);
  });
});

describe("Slime", () => {
  it("fires at the same rate at 60 Hz and 144 Hz (time-based timers)", () => {
    const a = runSlime(60, 20, [24, 200]);
    const b = runSlime(144, 20, [24, 200]);
    expect(a.shots).toBe(Math.floor((20 * 1000) / SLIME.fireIntervalMs));
    expect(b.shots).toBe(a.shots);
    expect(Math.abs(a.x - b.x)).toBeLessThan(2);
  });

  it("stays inside its patrol span", () => {
    const r = runSlime(60, 30, [24, 120]);
    expect(r.minX).toBeGreaterThanOrEqual(24 - 1);
    expect(r.maxX).toBeLessThanOrEqual(120 + 1);
    expect(r.maxX - r.minX).toBeGreaterThan(80); // it really walks the span
  });

  it("stands still with no floor span and never fires when passive", () => {
    const s = createSlimeState();
    const out = stepSlime(s, 16, 50, [50, 50], normal);
    expect(out.vx).toBe(0);
    const p = createSlimeState();
    let shots = 0;
    for (let i = 0; i < 1000; i++) shots += stepSlime(p, 16, 50, [0, 100], enemyTuning(0)).shots.length;
    expect(shots).toBe(0);
  });

  it("does not queue a volley after a long stall", () => {
    const s = createSlimeState();
    const out = stepSlime(s, 60000, 50, [0, 100], normal);
    expect(out.shots).toHaveLength(1);
    expect(stepSlime(s, 16, 50, [0, 100], normal).shots).toHaveLength(0);
  });
});

describe("UltraSlime (softened)", () => {
  it("behaves the same at 60 Hz and 144 Hz", () => {
    const a = runUltra(60, 30, { x: 150, y: 50 });
    const b = runUltra(144, 30, { x: 150, y: 50 });
    expect(b.shots).toBe(a.shots);
    expect(b.mega).toBe(a.mega);
    expect(Math.abs(a.x - b.x)).toBeLessThan(2);
  });

  it("telegraphs every burst and fires three megas per burst", () => {
    const r = runUltra(60, ULTRA.burstEveryMs / 1000 + 2.5, { x: 150, y: 50 });
    expect(r.mega).toBe(ULTRA.burstShots);
    expect(r.warned).toBeGreaterThanOrEqual(ULTRA.warnMs - 20);
  });

  it("only chases a nearby knight on its level and never leaves its floor", () => {
    const far = runUltra(60, 10, { x: 1000, y: 50 });
    const near = runUltra(60, 10, { x: 190, y: 50 });
    expect(near.x).toBeGreaterThan(180);
    expect(near.x).toBeLessThanOrEqual(200 + 1);
    const chasingAbove = runUltra(60, 3, { x: 190, y: 50 - 5 * 16 });
    // not near vertically: patrols at patrol speed rather than chasing hard
    expect(chasingAbove.x).toBeLessThan(near.x + 1);
    expect(far.x).toBeGreaterThanOrEqual(40 - 1);
  });

  it("is passive at aggression 0", () => {
    const r = runUltra(60, 20, { x: 150, y: 50 }, enemyTuning(0));
    expect(r.shots).toBe(0);
  });
});

describe("isStomp", () => {
  it("counts a falling knight whose feet were above the head", () => {
    expect(isStomp({ bottom: 102, prevBottom: 99, vy: 200 }, 100)).toBe(true);
    expect(isStomp({ bottom: 120, prevBottom: 118, vy: 200 }, 100)).toBe(false);
    expect(isStomp({ bottom: 100, vy: -10 }, 100)).toBe(false);
  });
});
