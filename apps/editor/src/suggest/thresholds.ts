/**
 * Per-session ("per-person") adaptation of the show-now threshold
 * (plan §12: "two drawn-over dismissals in a row raise showNowAbove for that
 * session, two accepts lower it, within bounds").
 *
 * Rules
 *  - `adaptRun` drawn-over dismissals in a row raise showNowAbove by `adaptStep`.
 *  - `adaptRun` accepts in a row (full or partial) lower it by `adaptStep`.
 *  - The value is clamped to [adaptMin, adaptMax] (default [0.5, 0.95]).
 *  - An Esc dismissal breaks both runs (it is neither drawn-over nor accept).
 *    "replaced", "timeout" and "pending" are neutral: they do not break runs.
 *  - After a step fires, its run starts again from zero (so four drawn-overs
 *    in a row give two steps).
 *  - `reset()` returns to the configured base value and clears the runs.
 *  - With `adaptThresholds: false` the value always equals config.showNowAbove.
 */
import type { GhostOutcome } from "../contracts";
import { config as globalConfig, type GhostConfig } from "./config";

export type ThresholdChangeReason = "drawn-over-run" | "accept-run" | "reset";

export interface ThresholdChange {
  from: number;
  to: number;
  reason: ThresholdChangeReason;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

export class SessionThresholds {
  private value: number;
  private drawnOverRun = 0;
  private acceptRun = 0;
  /** Offset from the base applied by adaptation (kept so config edits to the base still apply). */
  private offset = 0;

  constructor(
    private readonly cfg: () => GhostConfig = () => globalConfig,
    private readonly onChange?: (c: ThresholdChange) => void,
  ) {
    this.value = this.clamp(this.cfg().showNowAbove);
  }

  private bounds(): [number, number] {
    const c = this.cfg();
    const lo = Math.min(c.adaptMin, c.adaptMax);
    const hi = Math.max(c.adaptMin, c.adaptMax);
    return [lo, hi];
  }

  private clamp(v: number): number {
    const [lo, hi] = this.bounds();
    return round(Math.min(hi, Math.max(lo, v)));
  }

  /** Current show-now threshold for this session. */
  get showNowAbove(): number {
    const c = this.cfg();
    if (!c.adaptThresholds) {
      this.value = c.showNowAbove;
      return this.value;
    }
    // Re-derive from the (possibly overridden) base so a config change is honoured.
    this.value = this.clamp(c.showNowAbove + this.offset);
    return this.value;
  }

  /** Current runs, for the status strip / debugging. */
  get runs(): { drawnOver: number; accept: number } {
    return { drawnOver: this.drawnOverRun, accept: this.acceptRun };
  }

  /**
   * Record a ghost outcome. Returns the change when the threshold moved,
   * null otherwise.
   */
  record(outcome: GhostOutcome): ThresholdChange | null {
    const c = this.cfg();
    const run = Math.max(1, Math.floor(c.adaptRun));
    switch (outcome) {
      case "drawn-over":
        this.drawnOverRun++;
        this.acceptRun = 0;
        if (this.drawnOverRun >= run) {
          this.drawnOverRun = 0;
          return this.step(+c.adaptStep, "drawn-over-run");
        }
        return null;
      case "accepted":
      case "partial":
        this.acceptRun++;
        this.drawnOverRun = 0;
        if (this.acceptRun >= run) {
          this.acceptRun = 0;
          return this.step(-c.adaptStep, "accept-run");
        }
        return null;
      case "esc":
        this.drawnOverRun = 0;
        this.acceptRun = 0;
        return null;
      default:
        return null;
    }
  }

  private step(delta: number, reason: ThresholdChangeReason): ThresholdChange | null {
    const c = this.cfg();
    if (!c.adaptThresholds) return null;
    const from = this.showNowAbove;
    const to = this.clamp(from + delta);
    if (to === from) return null;
    this.offset = round(to - c.showNowAbove);
    this.value = to;
    const change = { from, to, reason };
    this.onChange?.(change);
    return change;
  }

  /** Back to the configured base; clears runs. */
  reset(): ThresholdChange | null {
    const from = this.value;
    this.offset = 0;
    this.drawnOverRun = 0;
    this.acceptRun = 0;
    const to = this.showNowAbove;
    if (to === from) return null;
    const change = { from, to, reason: "reset" as const };
    this.onChange?.(change);
    return change;
  }
}
