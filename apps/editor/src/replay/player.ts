/**
 * Playback clock for the replay viewer (pure; the page drives it from
 * requestAnimationFrame). Holds the playhead, speed and the optional
 * "skip quiet stretches" behaviour.
 */
import type { Tracks } from "../research/replay/tracks";

export interface Gap {
  start: number;
  end: number;
}

/**
 * Stretches where nothing is happening on any track (no segment, marker or
 * input, `pad` ms of margin each side) and that last at least `minMs`.
 * Away time counts as quiet: nobody is there.
 */
export function quietGaps(tracks: Tracks, minMs = 3000, pad = 500): Gap[] {
  const busy: Gap[] = [];
  for (const s of tracks.segments) if (s.track !== "away") busy.push({ start: s.start - pad, end: s.end + pad });
  for (const m of tracks.markers) busy.push({ start: m.t - pad, end: m.t + pad });
  busy.sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const b of busy) {
    if (b.start - cursor >= minMs) gaps.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (tracks.duration - cursor >= minMs) gaps.push({ start: cursor, end: tracks.duration });
  return gaps;
}

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export class Player {
  t = 0;
  playing = false;
  speed = 1;
  skipQuiet = false;
  private gaps: Gap[] = [];
  private onEnd?: () => void;

  constructor(
    public duration: number,
    opts: { gaps?: Gap[]; onEnd?: () => void } = {},
  ) {
    this.gaps = opts.gaps ?? [];
    this.onEnd = opts.onEnd;
  }

  setGaps(g: Gap[]): void {
    this.gaps = g;
  }

  seek(t: number): void {
    this.t = Math.max(0, Math.min(this.duration, t));
  }

  play(): void {
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(s: number): void {
    this.speed = Math.max(0.05, Math.min(32, s));
  }

  /** Advance by `dtMs` of wall-clock time. Returns the new playhead. */
  tick(dtMs: number): number {
    if (!this.playing) return this.t;
    let t = this.t + dtMs * this.speed;
    if (this.skipQuiet) {
      for (const g of this.gaps) {
        // Entering a quiet stretch: hop to its end.
        if (t > g.start && t < g.end && this.t < g.end) {
          t = g.end;
          break;
        }
      }
    }
    if (t >= this.duration) {
      this.t = this.duration;
      this.playing = false;
      this.onEnd?.();
    } else this.t = t;
    return this.t;
  }
}
