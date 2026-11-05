/**
 * Run-length coding for the big arrays of a level snapshot (replay log).
 * `[v, n, v, n, ...]`: value v repeated n times. A 200x20 level is mostly
 * empty, so a snapshot shrinks from ~8k numbers to a few hundred.
 */
import type { LevelSnapshot, PackedSnapshot } from "../contracts";

export function rleEncode(values: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < values.length) {
    const v = values[i];
    let n = 1;
    while (i + n < values.length && values[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return out;
}

export function rleDecode(runs: readonly number[], length?: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const v = runs[i];
    const n = runs[i + 1];
    for (let k = 0; k < n; k++) out.push(v);
  }
  if (length !== undefined && out.length !== length) throw new Error(`rle: expected ${length} values, got ${out.length}`);
  return out;
}

export function packSnapshot(s: LevelSnapshot): PackedSnapshot {
  const { cells, authors, ...rest } = structuredClone(s);
  return { ...rest, cells: rleEncode(cells), authors: rleEncode(authors), packed: true };
}

export function unpackSnapshot(p: PackedSnapshot): LevelSnapshot {
  const { packed: _packed, cells, authors, ...rest } = p;
  const n = p.w * p.h;
  return { ...rest, cells: rleDecode(cells, n), authors: rleDecode(authors, n) };
}
