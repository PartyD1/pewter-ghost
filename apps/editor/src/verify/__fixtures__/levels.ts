/**
 * Test levels and suggestion builders for the verify tests.
 * Small levels (48 x 12 by default): ground at rows 8..11, start at (1, 7).
 */
import { snapshotFromAscii } from "@measure";
import { TILE, type EntityKind, type FillRequest, type LevelSnapshot, type Point, type Suggestion, type TileId } from "../../contracts";
import { LevelModel } from "../../level/LevelModel";

export const W = 48;
export const H = 12;
export const GROUND = 8;

/** Rows from a per-cell function returning an ASCII glyph. */
export function rowsOf(w: number, h: number, f: (x: number, y: number) => string): string[] {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => f(x, y)).join(""));
}

export function snapshotFrom(rows: string[]): LevelSnapshot {
  return snapshotFromAscii(rows, { w: rows[0].length, h: rows.length, offsetY: 0 });
}

export function modelFrom(rows: string[]): LevelModel {
  return LevelModel.fromSnapshot(snapshotFrom(rows));
}

/** Ground (rows GROUND..H-1) on the given inclusive column ranges; P at (1, GROUND-1). */
export function groundRows(ranges: [number, number][], w = W, h = H, extra?: (x: number, y: number) => string | undefined): string[] {
  return rowsOf(w, h, (x, y) => {
    const e = extra?.(x, y);
    if (e) return e;
    if (x === 1 && y === GROUND - 1) return "P";
    if (y >= GROUND && ranges.some(([a, b]) => x >= a && x <= b)) return "#";
    return ".";
  });
}

/** Cells of a filled rectangle (inclusive). */
export function rect(x0: number, x1: number, y0: number, y1: number, tile: TileId = TILE.GRASS) {
  const out: { x: number; y: number; tile: TileId }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y, tile });
  return out;
}

let n = 0;

export function sugg(p: Partial<Suggestion> & { adds?: Suggestion["adds"] }): Suggestion {
  const adds = p.adds ?? [];
  const removes = p.removes ?? [];
  const entities = p.entities ?? [];
  const first: Point = adds[0] ?? removes[0] ?? entities[0] ?? { x: 0, y: 0 };
  return {
    id: p.id ?? `s${++n}`,
    kind: p.kind ?? "extend",
    adds,
    removes,
    entities,
    confidence: p.confidence ?? 0.8,
    label: p.label ?? "test",
    anchor: p.anchor ?? { x: first.x, y: first.y },
    requestHash: p.requestHash ?? "hash",
    filler: p.filler ?? "stub",
    latencyMs: p.latencyMs ?? 100,
    mode: p.mode ?? "auto",
    verified: false,
    attempts: p.attempts ?? 1,
  };
}

export const ents = (kind: EntityKind, pts: [number, number][]) => pts.map(([x, y]) => ({ kind, x, y }));

export function fillRequest(over: Partial<FillRequest> = {}): FillRequest {
  return {
    grid: "",
    origin: { x: 0, y: 0 },
    size: { w: 24, h: 12 },
    recent: [],
    frontier: { x: 19, y: 7, idleMs: 0 },
    knight: { maxGapStand: 8, maxGapRun: 11, maxRise: 6 },
    measured: { density: 0, gapHist: [0, 0, 0, 0, 0], verticality: 0, rewardSpacing: 0, pressure: 0 },
    brief: "",
    briefVersion: "test",
    lastGhosts: [],
    mode: "auto",
    ...over,
  };
}
