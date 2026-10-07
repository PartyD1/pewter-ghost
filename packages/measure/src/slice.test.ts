import { describe, expect, it } from "vitest";
import { FLAT, GAP_RUN, REFERENCE_ROWS, joinRows } from "./__fixtures__/levels";
import { parseAscii, snapshotFromAscii } from "./grid";
import { measureWindow } from "./measures";
import { findRests, formatChunk, measuredDistance, nearestChunks, restCuts, sliceLevel } from "./slice";

const level = snapshotFromAscii(REFERENCE_ROWS);
const chunks = sliceLevel(level, { source: "ref" });

describe("rests and cuts", () => {
  it("finds the flat stretches", () => {
    const rests = findRests(level, level.entities);
    expect(rests.length).toBeGreaterThanOrEqual(4);
    for (const r of rests) expect(r.x1 - r.x0 + 1).toBeGreaterThanOrEqual(4);
  });

  it("cuts long rests near both ends and short ones in the middle", () => {
    const { grid, entities } = parseAscii(joinRows([["......", "######"], ["...", "..."], [".....", "#####"]]));
    // rests: 0..5 (6 wide > 7? no -> middle) and 9..13 (5 wide -> middle)
    expect(restCuts(grid, entities)).toEqual([2, 11]);
    const long = parseAscii(["....................", "####################"]);
    expect(restCuts(long.grid, long.entities)).toEqual([2, 17]);
    expect(restCuts(long.grid, long.entities, { margin: 5 })).toEqual([4, 15]);
  });
});

describe("sliceLevel", () => {
  it("produces chunks in order with ids, rows and tags", () => {
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].rect.x).toBeGreaterThanOrEqual(chunks[i - 1].rect.x + chunks[i - 1].rect.w - 1);
    for (const c of chunks) {
      expect(c.id).toBe(`ref:${c.rect.x}-${c.rect.x + c.rect.w - 1}`);
      expect(c.rows).toHaveLength(c.rect.h);
      for (const r of c.rows) expect(r).toHaveLength(c.rect.w);
      expect(c.rect.w).toBeGreaterThanOrEqual(8);
      expect(c.rect.w).toBeLessThanOrEqual(32);
      expect(c.numbers).toEqual(measureWindow(level, level.entities, c.rect));
      expect(c.tags).toEqual(c.numbers.patterns);
    }
  });

  it("keeps each structure whole inside one chunk", () => {
    const withTag = (t: string) => chunks.filter((c) => c.tags.includes(t as never));
    expect(withTag("gap-run")).toHaveLength(1);
    expect(withTag("staircase")).toHaveLength(1);
    expect(withTag("enemy-gate")).toHaveLength(1);
    const gate = withTag("enemy-gate")[0];
    expect(gate.entities).toEqual([{ kind: "slime", x: expect.any(Number), y: expect.any(Number) }]);
    const s = gate.entities[0];
    expect(gate.rows[s.y][s.x]).toBe("s");
  });

  it("chunks start and end on rests", () => {
    for (const c of chunks) {
      expect(c.startsAtRest).toBe(true);
      expect(c.endsAtRest).toBe(true);
    }
  });

  it("drops plain flat chunks unless asked", () => {
    const plain = sliceLevel(snapshotFromAscii(FLAT.rows));
    expect(plain).toHaveLength(0);
    const kept = sliceLevel(snapshotFromAscii(FLAT.rows), { keepPlain: true });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((c) => c.tags.length <= 1)).toBe(true);
  });

  it("splits long stretches with no rest", () => {
    const row = "##" + "...##".repeat(20);
    const { grid, entities } = parseAscii([".".repeat(row.length), row, row]);
    const parts = sliceLevel(grid, entities, { maxWidth: 20 });
    expect(parts.length).toBeGreaterThanOrEqual(Math.ceil(row.length / 20));
    for (const c of parts) expect(c.rect.w).toBeLessThanOrEqual(20);
    expect(parts[1].startsAtRest).toBe(false);
  });

  it("an empty level has no chunks", () => {
    expect(sliceLevel(snapshotFromAscii(["...."]))).toEqual([]);
  });

  it("trims rows to the content with one row of headroom", () => {
    const gap = chunks.find((c) => c.tags.includes("gap-run"))!;
    expect(gap.rows[0]).toMatch(/^\.+$/);
    expect(gap.rect.y + gap.rect.h).toBe(level.h);
  });
});

describe("retrieval helpers", () => {
  it("measuredDistance is 0 for equal numbers and symmetric", () => {
    const a = chunks[0].numbers;
    const b = chunks[chunks.length - 1].numbers;
    expect(measuredDistance(a, a)).toBe(0);
    expect(measuredDistance(a, b)).toBe(measuredDistance(b, a));
    expect(measuredDistance(a, b)).toBeGreaterThan(0);
    expect(measuredDistance(a, b)).toBeLessThanOrEqual(1);
  });

  it("nearestChunks finds the gap run for a gap-run window", () => {
    const { grid, entities } = parseAscii(GAP_RUN.rows);
    const target = measureWindow(grid, entities, { x: 0, y: 0, w: grid.w, h: grid.h });
    const best = nearestChunks(chunks, target, 2);
    expect(best).toHaveLength(2);
    expect(best[0].tags).toContain("gap-run");
    expect(nearestChunks(chunks, target, 0)).toEqual([]);
  });

  it("formatChunk prints a header and the rows", () => {
    const text = formatChunk(chunks[0]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^\[.*\] \d+x\d+ density/);
    expect(lines.slice(1)).toEqual(chunks[0].rows);
  });
});
