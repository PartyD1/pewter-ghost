import { describe, expect, it } from "vitest";
import type { Tracks } from "../research/replay/tracks";
import { Player, quietGaps } from "./player";

const tracks = (segs: [number, number][], markers: number[], duration: number): Tracks => ({
  duration,
  segments: segs.map(([start, end], i) => ({ id: `s${i}`, track: "edits", start, end, label: "", kind: "person" })),
  markers: markers.map((t, i) => ({ id: `m${i}`, track: "edits", t, label: "", kind: "undo" })),
});

describe("quietGaps", () => {
  it("finds long stretches with nothing going on", () => {
    const g = quietGaps(tracks([[0, 1000], [10_000, 11_000]], [], 20_000), 3000, 500);
    expect(g).toEqual([
      { start: 1500, end: 9500 },
      { start: 11_500, end: 20_000 },
    ]);
  });

  it("counts markers as activity and ignores short gaps", () => {
    const g = quietGaps(tracks([[0, 1000]], [4000, 8000], 12_000), 3000, 500);
    // 1500 -> 3500 is only 2 s, so it is skipped; 4500 -> 7500 is exactly 3 s, so it counts.
    expect(g).toEqual([
      { start: 4500, end: 7500 },
      { start: 8500, end: 12_000 },
    ]);
    expect(quietGaps(tracks([[0, 1000]], [3000], 4000), 3000, 500)).toEqual([]);
  });

  it("treats a log with no activity as one quiet stretch", () => {
    expect(quietGaps(tracks([], [], 9000))).toEqual([{ start: 0, end: 9000 }]);
  });

  it("does not count away time as activity", () => {
    const t = tracks([[0, 1000]], [], 20_000);
    t.segments.push({ id: "a", track: "away", start: 2000, end: 15_000, label: "", kind: "away" });
    expect(quietGaps(t, 3000, 500)).toEqual([{ start: 1500, end: 20_000 }]);
  });
});

describe("Player", () => {
  it("advances with speed and stops at the end", () => {
    let ended = 0;
    const p = new Player(1000, { onEnd: () => ended++ });
    p.play();
    p.setSpeed(2);
    expect(p.tick(100)).toBe(200);
    expect(p.tick(1000)).toBe(1000);
    expect(p.playing).toBe(false);
    expect(ended).toBe(1);
  });

  it("does not move while paused", () => {
    const p = new Player(1000);
    expect(p.tick(500)).toBe(0);
  });

  it("restarts from the top when played at the end", () => {
    const p = new Player(1000);
    p.seek(1000);
    p.play();
    expect(p.t).toBe(0);
  });

  it("clamps seeks", () => {
    const p = new Player(1000);
    p.seek(-5);
    expect(p.t).toBe(0);
    p.seek(5000);
    expect(p.t).toBe(1000);
  });

  it("hops over quiet stretches only when asked", () => {
    const p = new Player(20_000, { gaps: [{ start: 2000, end: 9000 }] });
    p.play();
    p.seek(1900);
    p.tick(200);
    expect(p.t).toBe(2100);
    p.seek(1900);
    p.skipQuiet = true;
    p.tick(200);
    expect(p.t).toBe(9000);
  });

  it("clamps absurd speeds", () => {
    const p = new Player(1000);
    p.setSpeed(1000);
    expect(p.speed).toBe(32);
    p.setSpeed(0);
    expect(p.speed).toBe(0.05);
  });
});
