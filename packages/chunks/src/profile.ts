/**
 * Style profiles from measured numbers: turn what the person has drawn
 * (MeasuredNumbers of the window, KnightLimits) into generator parameters,
 * so Extend continues in the drawing's style (gap widths, rise, density,
 * reward spacing, enemy pressure).
 */
import type { KnightLimits, MeasuredNumbers } from "../../../apps/editor/src/contracts";
import { THEMES, type PieceKind, type StyleProfile } from "./generator";

export interface ProfileOptions {
  /** Solid rows under the surface (default 2: a surface and one row of fill). */
  fillDepth?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Bin centres of the 5-bin gap histogram, as fractions of maxGapRun. */
const BIN_CENTRES = [0.1, 0.3, 0.5, 0.7, 0.9];

/** Typical gap (tiles) from a gap histogram, or null when the drawing has no gaps. */
export function typicalGap(gapHist: readonly number[], maxGapRun: number): number | null {
  const total = gapHist.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (!(total > 0)) return null;
  let f = 0;
  gapHist.forEach((b, i) => (f += (Number.isFinite(b) ? b : 0) * (BIN_CENTRES[i] ?? 0.9)));
  return Math.max(1, Math.round((f / total) * maxGapRun));
}

/** Lower edge of the highest non-empty gap-histogram bin (0 when there are no gaps). */
export function widestGapRatio(gapHist: readonly number[]): number {
  for (let i = gapHist.length - 1; i >= 0; i--) if ((gapHist[i] ?? 0) > 0) return i * 0.2;
  return 0;
}

/** A profile that continues the measured style. Neutral (chunkgen difficulty 2, "mixed") when nothing is measured. */
export function profileFromMeasured(m: MeasuredNumbers, knight: KnightLimits, opts: ProfileOptions = {}): StyleProfile {
  const fillDepth = opts.fillDepth ?? 2;
  const g = typicalGap(m.gapHist ?? [], knight.maxGapRun);
  const hard = (m.difficulty ?? 0) > 0.6;
  // Pits stay within a standing jump unless the drawing already asks for more.
  const gapCap = Math.max(2, hard ? knight.maxGapRun - 1 : knight.maxGapStand);
  // The validator's style band: gaps up to max(60%, widest drawn + 40%) of a
  // full-run jump. The widest drawn gap is read (conservatively) as the lower
  // edge of the highest non-empty histogram bin.
  const bandCap = Math.max(2, Math.floor(Math.max(0.6, widestGapRatio(m.gapHist ?? []) + 0.4) * knight.maxGapRun + 1e-9));
  const cap = Math.min(gapCap, bandCap);
  const gap: [number, number] =
    g === null ? [2, Math.min(4, cap)] : [clamp(g - 1, 2, cap), clamp(g + 1 + (hard ? 1 : 0), 2, cap)];
  // A platform over a pit reads as one wide gap to the measures: keep the pit inside the band too.
  const platformWidth: [number, number] = [5, clamp(bandCap, 5, 9)];

  const vert = clamp(m.verticality ?? 0, 0, 1);
  const riseCap = Math.max(1, knight.maxRise - 1);
  const rise: [number, number] = vert < 0.1 ? [1, 1] : vert < 0.3 ? [1, 2] : [1, Math.min(3, riseCap)];

  const kinds: PieceKind[] = [...THEMES.mixed];
  if (vert >= 0.3) kinds.push("step");
  if (g !== null) kinds.push("pit");
  if ((m.density ?? 0) > 0.35) kinds.push("flat", "flat");
  const rewards = (m.rewardSpacing ?? 0) > 0;
  if (rewards) kinds.push("coin_row");
  else kinds.splice(kinds.indexOf("coin_row"), 1);

  const pressure = clamp(m.pressure ?? 0, 0, 1);
  return {
    name: "measured",
    kinds,
    gap,
    rise,
    enemyP: pressure > 0 ? Math.min(0.45, 0.15 + pressure * 0.6) : 0,
    coinP: rewards ? 0.7 : 0.25,
    coinEvery: (m.rewardSpacing ?? 0) >= 4 ? 2 : 1,
    fillDepth,
    platformWidth,
  };
}
