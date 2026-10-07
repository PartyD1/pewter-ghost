/**
 * Research event log (G-18).
 *
 * - `log(event)` appends to a local buffer and to the "pending" queue. Never throws.
 * - Pending events are POSTed to `<proxyUrl>/log` every `flushIntervalMs` (5 s)
 *   and whenever `flush()` is called (the editor calls it on save and at session end).
 * - A failed POST keeps the events pending; they go with the next batch. Offline
 *   (no proxy, no token, or navigator.onLine === false) the log just keeps buffering.
 * - `download()` returns every event of the session as a JSONL Blob.
 *
 * Pure logic, no Phaser. Timers and fetch are injectable for tests.
 */
import type { LogEvent, ProxyLogBody } from "../contracts";
import { validateEvent } from "./schema";

export interface EventLogOptions {
  sessionId: string;
  /** Proxy base URL, e.g. http://localhost:8787. null/undefined = offline only. */
  proxyUrl?: string | null;
  /** Bearer session token. Without one the log stays local. */
  token?: string | null;
  /** Batch interval (default 5000 ms). */
  flushIntervalMs?: number;
  /** Max events per POST (default 500). Larger backlogs go in several requests. */
  maxBatch?: number;
  /**
   * Max events kept for download (default 200 000). When exceeded, the oldest
   * events that were already delivered are dropped first; `droppedCount` tracks it.
   */
  maxBuffer?: number;
  /** POST timeout (default 8000 ms). */
  requestTimeoutMs?: number;
  /** Validate events on log() (default true). Invalid events are still kept. */
  validate?: boolean;
  /** Called for invalid events (dev aid). Exceptions inside are swallowed. */
  onInvalid?: (event: unknown, error: string) => void;
  /** Called when a POST fails. Exceptions inside are swallowed. */
  onError?: (error: string) => void;
  fetch?: typeof fetch;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Start the interval timer immediately (default true). */
  autoStart?: boolean;
}

export interface EventLogStats {
  logged: number;
  pending: number;
  sent: number;
  failedPosts: number;
  invalid: number;
  dropped: number;
  lastError?: string;
}

export class EventLog {
  readonly sessionId: string;
  private proxyUrl: string | null;
  private token: string | null;
  private readonly flushIntervalMs: number;
  private readonly maxBatch: number;
  private readonly maxBuffer: number;
  private readonly requestTimeoutMs: number;
  private readonly validate: boolean;
  private readonly onInvalid?: (event: unknown, error: string) => void;
  private readonly onError?: (error: string) => void;
  private readonly fetchImpl?: typeof fetch;
  private readonly setIntervalImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;

  /** Every event of the session (minus overflow drops), in log order. */
  private buffer: LogEvent[] = [];
  /** Index into `buffer` of the first event not yet delivered. */
  private sentUpTo = 0;
  private timer: unknown = null;
  private inflight: Promise<boolean> | null = null;
  private stats: EventLogStats = { logged: 0, pending: 0, sent: 0, failedPosts: 0, invalid: 0, dropped: 0 };

  constructor(opts: EventLogOptions) {
    this.sessionId = opts.sessionId;
    this.proxyUrl = normaliseBase(opts.proxyUrl);
    this.token = opts.token ?? null;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.maxBatch = Math.max(1, opts.maxBatch ?? 500);
    this.maxBuffer = Math.max(1, opts.maxBuffer ?? 200_000);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 8000;
    this.validate = opts.validate ?? true;
    this.onInvalid = opts.onInvalid;
    this.onError = opts.onError;
    this.fetchImpl = opts.fetch;
    this.setIntervalImpl = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.clearIntervalImpl = opts.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
    if (opts.autoStart ?? true) this.start();
  }

  /** Append an event. Never throws. */
  log(event: LogEvent): void {
    try {
      if (this.validate) {
        const v = validateEvent(event);
        if (!v.ok) {
          this.stats.invalid++;
          safeCall(this.onInvalid, event, v.error);
        }
      }
      // Copy so later mutation by the caller does not change the record.
      this.buffer.push(cloneEvent(event));
      this.stats.logged++;
      this.trim();
    } catch (e) {
      // Swallow: logging must never break the editor.
      this.stats.lastError = errText(e);
    }
  }

  /** Start the periodic flush (idempotent). */
  start(): void {
    if (this.timer !== null) return;
    try {
      this.timer = this.setIntervalImpl(() => {
        if (this.pendingCount() > 0) void this.flush();
      }, this.flushIntervalMs);
      // Do not keep a Node process alive just for the log.
      const t = this.timer as { unref?: () => void } | null;
      if (t && typeof t.unref === "function") t.unref();
    } catch (e) {
      this.timer = null;
      this.stats.lastError = errText(e);
    }
  }

  /** Stop the periodic flush. Pending events stay buffered. */
  stop(): void {
    if (this.timer === null) return;
    try {
      this.clearIntervalImpl(this.timer);
    } catch {
      /* ignore */
    }
    this.timer = null;
  }

  /** Point the log at a (new) proxy/token, e.g. after GET /session resolves. */
  connect(proxyUrl: string | null | undefined, token: string | null | undefined): void {
    this.proxyUrl = normaliseBase(proxyUrl);
    this.token = token ?? null;
  }

  get online(): boolean {
    if (!this.proxyUrl || !this.token) return false;
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    return !(nav && nav.onLine === false);
  }

  pendingCount(): number {
    return this.buffer.length - this.sentUpTo;
  }

  getStats(): EventLogStats {
    return { ...this.stats, pending: this.pendingCount() };
  }

  /** All buffered events, oldest first (a copy). */
  events(): LogEvent[] {
    return this.buffer.slice();
  }

  /**
   * Send everything pending. Resolves true when nothing is left pending,
   * false when offline or a POST failed (events are kept). Never rejects.
   */
  flush(): Promise<boolean> {
    if (this.inflight) {
      // Chain: wait for the current send, then send whatever arrived meanwhile.
      return this.inflight.then(() => (this.pendingCount() > 0 ? this.flush() : true));
    }
    if (this.pendingCount() === 0) return Promise.resolve(true);
    if (!this.online) return Promise.resolve(false);
    const p = this.sendAll().catch((e) => {
      this.noteError(errText(e));
      return false;
    });
    this.inflight = p;
    void p.finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    return p;
  }

  /**
   * Best-effort delivery when the page is going away: sendBeacon with the token
   * in the query string (beacons cannot set headers). Marks events as sent only
   * when the browser accepted the beacon. Never throws.
   */
  flushOnUnload(): boolean {
    try {
      if (!this.online || this.pendingCount() === 0) return this.pendingCount() === 0;
      const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, data: BodyInit) => boolean } }).navigator;
      if (!nav || typeof nav.sendBeacon !== "function") return false;
      const events = this.buffer.slice(this.sentUpTo);
      const body: ProxyLogBody = { sessionId: this.sessionId, events };
      const url = `${this.proxyUrl}/log?token=${encodeURIComponent(this.token!)}`;
      const ok = nav.sendBeacon(url, new Blob([JSON.stringify(body)], { type: "text/plain" }));
      if (ok) this.markSent(events.length);
      return ok;
    } catch (e) {
      this.stats.lastError = errText(e);
      return false;
    }
  }

  /** Every event of the session as JSONL (one JSON object per line). */
  toJsonl(): string {
    let out = "";
    for (const e of this.buffer) {
      try {
        out += JSON.stringify(e) + "\n";
      } catch {
        /* unserialisable event: skip */
      }
    }
    return out;
  }

  /** JSONL Blob of every buffered event. */
  download(): Blob {
    return new Blob([this.toJsonl()], { type: "application/x-ndjson" });
  }

  /**
   * Browser convenience: trigger a file download of `download()`.
   * Returns false outside a DOM. Never throws.
   */
  saveFile(filename = `pewter-ghost-${this.sessionId}.jsonl`): boolean {
    try {
      const doc = (globalThis as { document?: Document }).document;
      if (!doc || typeof URL.createObjectURL !== "function") return false;
      const url = URL.createObjectURL(this.download());
      const a = doc.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      this.stats.lastError = errText(e);
      return false;
    }
  }

  /** Stop the timer and try one last flush. */
  async close(): Promise<boolean> {
    this.stop();
    return this.flush();
  }

  // -------------------------------------------------------------------------

  private async sendAll(): Promise<boolean> {
    while (this.pendingCount() > 0) {
      const n = Math.min(this.maxBatch, this.pendingCount());
      const events = this.buffer.slice(this.sentUpTo, this.sentUpTo + n);
      const ok = await this.post(events);
      if (!ok) return false;
      this.markSent(events.length);
    }
    return true;
  }

  private markSent(n: number): void {
    this.sentUpTo = Math.min(this.buffer.length, this.sentUpTo + n);
    this.stats.sent += n;
    this.trim();
  }

  private async post(events: LogEvent[]): Promise<boolean> {
    const f = this.fetchImpl ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!f) {
      this.noteError("no fetch available");
      return false;
    }
    const body: ProxyLogBody = { sessionId: this.sessionId, events };
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.requestTimeoutMs) : null;
    try {
      const res = await f(`${this.proxyUrl}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: ctrl?.signal,
        keepalive: false,
      });
      if (!res.ok) {
        this.noteError(`POST /log ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      this.noteError(`POST /log failed: ${errText(e)}`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private noteError(msg: string): void {
    this.stats.failedPosts++;
    this.stats.lastError = msg;
    safeCall(this.onError, msg);
  }

  /** Enforce maxBuffer: drop delivered events first, then the oldest pending. */
  private trim(): void {
    const over = this.buffer.length - this.maxBuffer;
    if (over <= 0) return;
    this.buffer.splice(0, over);
    this.sentUpTo = Math.max(0, this.sentUpTo - over);
    this.stats.dropped += over;
  }
}

// ---------------------------------------------------------------------------
// Active-log helpers so hooks across the editor can log without plumbing.
// ---------------------------------------------------------------------------

let active: EventLog | null = null;

export function setActiveLog(log: EventLog | null): void {
  active = log;
}

export function getActiveLog(): EventLog | null {
  return active;
}

/** Log to the active log if there is one. Never throws. */
export function logEvent(event: LogEvent): void {
  try {
    active?.log(event);
  } catch {
    /* never throw into callers */
  }
}

// ---------------------------------------------------------------------------

function normaliseBase(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

function cloneEvent(e: LogEvent): LogEvent {
  try {
    return structuredClone(e);
  } catch {
    return { ...e } as LogEvent;
  }
}

function safeCall<A extends unknown[]>(fn: ((...a: A) => void) | undefined, ...args: A): void {
  if (!fn) return;
  try {
    fn(...args);
  } catch {
    /* ignore */
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" ? "timeout" : e.message;
  return String(e);
}
