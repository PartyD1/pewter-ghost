/**
 * Clock abstraction for the suggestion manager. Times are ms on the same base
 * as `PlacementEvent.t` (performance.now() since session start).
 */
export interface Clock {
  now(): number;
}

/** The real clock. */
export const performanceClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

/** A manually advanced clock for tests and offline replays. */
export class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  /** Move forward by `ms` (negative values are ignored). Returns the new time. */
  advance(ms: number): number {
    if (ms > 0) this.t += ms;
    return this.t;
  }
  /** Jump to an absolute time (never backwards). Returns the new time. */
  set(t: number): number {
    if (t > this.t) this.t = t;
    return this.t;
  }
}
