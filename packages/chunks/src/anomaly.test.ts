import { describe, expect, it } from "vitest";
import { detectAnomalies } from "./anomaly";
import type { DetectGrid, DetectPlacement } from "./detect";

const TILES: Record<string, number> = { grass: 6, dirt: 7 };
const W = 40;
const H = 16;
const FLOOR = 13;

function gridOf(solid: [number, number][], tile: string): DetectGrid {
  const tiles = new Uint8Array(W * H);
  for (let y = FLOOR; y < H; y++) for (let x = 0; x < W; x++) tiles[y * W + x] = TILES.dirt;
  for (const [x, y] of solid) tiles[y * W + x] = TILES[tile];
  return { w: W, h: H, tiles, blocked: new Uint8Array(W * H), entities: [] };
}

const paint = (pts: [number, number][], tile: string): DetectPlacement[] =>
  pts.map(([x, y]) => ({ x, y, tile, tool: "paint" as const }));

describe("detectAnomalies", () => {
  it("suggests removing one cell that breaks a staircase repeat", () => {
    const tread = (x: number, y: number) =>
      [
        [x, y],
        [x + 1, y],
      ] as [number, number][];
    const steps = [...tread(4, FLOOR - 1), ...tread(6, FLOOR - 2), ...tread(8, FLOOR - 3), [10, FLOOR - 3]];
    const grid = gridOf(steps, "grass");
    const recent = paint(steps, "grass");
    const a = detectAnomalies(grid, recent);
    expect(a).toBeDefined();
    expect(a!.removes).toEqual([{ x: 10, y: FLOOR - 3 }]);
    expect(["staircase", "platforms", "repeat"]).toContain(a!.pattern);
  });

  it("returns null when the stroke is a clean staircase", () => {
    const steps: [number, number][] = [
      [4, FLOOR - 1],
      [5, FLOOR - 2],
      [6, FLOOR - 3],
      [7, FLOOR - 4],
    ];
    const grid = gridOf(steps, "grass");
    const recent = paint(steps, "grass");
    expect(detectAnomalies(grid, recent)).toBeNull();
  });
});
