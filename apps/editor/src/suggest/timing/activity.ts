/**
 * What the person is doing right now, for the timing policies (CDHF features,
 * the Jev's activity line). Pure: placements and ghost outcomes come in, a
 * snapshot at any time comes out.
 *
 * This is the editor's analogue of the telemetry Mozannar et al. (2023) feed
 * their acceptance model: recent actions and how the last few suggestions went.
 */
import { AUTHOR, type GhostOutcome, type PlacementEvent, type Point } from "../../contracts";

export interface ActivitySnapshot {
  now: number;
  /** ms since the person's last placement (since the tracker started when none). */
  idleMs: number;
  /** Person placements in the last 2 s / 10 s. */
  placements2s: number;
  placements10s: number;
  /** Share of the last 10 s of placements that were erases (0 when none). */
  eraseShare: number;
  /** Dismissals (Esc, drawn over, timeout) since the last accept. */
  dismissRun: number;
  /** Smoothed accept share of the last 5 decided ghosts (0.5 with none). */
  acceptRate5: number;
  /** ms since the last ghost ended (Infinity when none yet). */
  sinceGhostMs: number;
  /** A ghost is on screen. */
  ghostShowing: boolean;
  lastPlacement?: Point;
}

/** Ghost outcome as an acceptance label: 1 kept, 0 rejected, null not a decision ("replaced", "pending"). */
export function acceptLabel(outcome: GhostOutcome): 0 | 1 | null {
  if (outcome === "accepted" || outcome === "partial") return 1;
  if (outcome === "esc" || outcome === "drawn-over" || outcome === "timeout") return 0;
  return null;
}

const KEEP_PLACEMENTS = 256;
const KEEP_OUTCOMES = 5;

export class ActivityTracker {
  private placed: { t: number; erase: boolean; x: number; y: number }[] = [];
  private outcomes: (0 | 1)[] = [];
  private dismissRun = 0;
  private lastEnd = -Infinity;
  private showing = 0;
  private start: number;

  constructor(private readonly clock: () => number) {
    this.start = clock();
  }

  /** A placement by anyone; only the person's count. */
  placement(ev: PlacementEvent): void {
    if (ev.author !== AUTHOR.PERSON) return;
    this.placed.push({ t: ev.t, erase: ev.tool === "erase", x: ev.x, y: ev.y });
    if (this.placed.length > KEEP_PLACEMENTS) this.placed.splice(0, this.placed.length - KEEP_PLACEMENTS);
  }

  ghostShown(): void {
    this.showing++;
  }

  ghostEnded(outcome: GhostOutcome, t = this.clock()): void {
    this.showing = Math.max(0, this.showing - 1);
    this.lastEnd = t;
    const y = acceptLabel(outcome);
    if (y === null) return;
    this.outcomes.push(y);
    if (this.outcomes.length > KEEP_OUTCOMES) this.outcomes.shift();
    this.dismissRun = y === 1 ? 0 : this.dismissRun + 1;
  }

  /** New level: forget everything. */
  reset(): void {
    this.placed = [];
    this.outcomes = [];
    this.dismissRun = 0;
    this.lastEnd = -Infinity;
    this.showing = 0;
    this.start = this.clock();
  }

  snapshot(now = this.clock()): ActivitySnapshot {
    const last = this.placed[this.placed.length - 1];
    let n2 = 0;
    let n10 = 0;
    let erases = 0;
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      const age = now - p.t;
      if (age > 10_000) break;
      if (age < 0) continue;
      n10++;
      if (p.erase) erases++;
      if (age <= 2000) n2++;
    }
    const k = this.outcomes.length;
    const accepts = this.outcomes.reduce<number>((a, y) => a + y, 0);
    const snap: ActivitySnapshot = {
      now,
      idleMs: Math.max(0, now - (last?.t ?? this.start)),
      placements2s: n2,
      placements10s: n10,
      eraseShare: n10 ? erases / n10 : 0,
      dismissRun: this.dismissRun,
      acceptRate5: (accepts + 0.5) / (k + 1),
      sinceGhostMs: Math.max(0, now - this.lastEnd),
      ghostShowing: this.showing > 0,
    };
    if (last) snap.lastPlacement = { x: last.x, y: last.y };
    return snap;
  }
}
