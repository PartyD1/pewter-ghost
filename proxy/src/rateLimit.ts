/**
 * Per-key token bucket. In the Worker this is per isolate (best effort); in the
 * dev server it is exact. Default for /fill: 120 calls per minute, burst 120.
 */
export interface RateLimitConfig {
  /** Bucket size (max burst). */
  capacity: number;
  /** Tokens added per minute. */
  perMinute: number;
}

export interface TakeResult {
  ok: boolean;
  /** Tokens left after this take. */
  remaining: number;
  /** When !ok: ms until one token is available. */
  retryAfterMs: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly ratePerMs: number;

  constructor(
    private readonly cfg: RateLimitConfig,
    private readonly maxKeys = 10_000,
  ) {
    if (!(cfg.capacity > 0) || !(cfg.perMinute > 0)) throw new Error("rate limit: capacity and perMinute must be > 0");
    this.ratePerMs = cfg.perMinute / 60_000;
  }

  take(key: string, nowMs: number, cost = 1): TakeResult {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict(nowMs);
      b = { tokens: this.cfg.capacity, last: nowMs };
      this.buckets.set(key, b);
    }
    const elapsed = Math.max(0, nowMs - b.last);
    b.tokens = Math.min(this.cfg.capacity, b.tokens + elapsed * this.ratePerMs);
    b.last = nowMs;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    const need = cost - b.tokens;
    return { ok: false, remaining: 0, retryAfterMs: Math.ceil(need / this.ratePerMs) };
  }

  /** Drop full (idle) buckets; if none are full, drop the oldest. */
  private evict(nowMs: number): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, b] of this.buckets) {
      const tokens = Math.min(this.cfg.capacity, b.tokens + (nowMs - b.last) * this.ratePerMs);
      if (tokens >= this.cfg.capacity) this.buckets.delete(k);
      else if (b.last < oldest) {
        oldest = b.last;
        oldestKey = k;
      }
    }
    if (this.buckets.size >= this.maxKeys && oldestKey) this.buckets.delete(oldestKey);
  }
}
