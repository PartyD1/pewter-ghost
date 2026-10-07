/**
 * Worker protocol, the worker entry and AgentClient (G-16 worker part).
 * The Worker is simulated with a fake that runs the real worker entry
 * (attachAgentWorker) behind an async, structured-clone message boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient, type WorkerLike } from "./client";
import { flatLevel, gapLevel, staircaseLevel, wallLevel } from "./fixtures";
import { AgentRunner, runRequest, validateRequest, type AgentReply, type AgentRequest } from "./protocol";
import { attachAgentWorker, type WorkerScopeLike } from "./worker";

const IMPOSSIBLE = gapLevel(7, 13);
const BEATABLE = staircaseLevel();
const endOf = (g: { w: number }) => ({ x0: g.w - 1 });

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  const g = BEATABLE;
  return {
    id: 1,
    type: "verify",
    grid: g.solid,
    w: g.w,
    h: g.h,
    from: { x: 0, y: 7 },
    to: endOf(g),
    capMs: 5000,
    ...over,
  };
}

/** Runs the real worker entry behind an async message boundary. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent | Event) => void) | null = null;
  terminated = false;
  received: unknown[] = [];
  private listeners: ((e: MessageEvent) => void)[] = [];

  constructor() {
    const scope: WorkerScopeLike = {
      postMessage: (msg) => {
        if (this.terminated) return;
        const data = structuredClone(msg);
        setTimeout(() => !this.terminated && this.onmessage?.({ data } as MessageEvent), 0);
      },
      addEventListener: (_type, fn) => this.listeners.push(fn as (e: MessageEvent) => void),
    };
    attachAgentWorker(scope, 5);
  }

  postMessage(msg: unknown): void {
    if (this.terminated) return;
    const data = structuredClone(msg);
    this.received.push(data);
    setTimeout(() => {
      if (!this.terminated) for (const fn of this.listeners) fn({ data } as MessageEvent);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A worker that accepts messages and never answers. */
class HungWorker implements WorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent | Event) => void) | null = null;
  received: unknown[] = [];
  terminated = false;
  postMessage(msg: unknown): void {
    this.received.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
}

const clients: AgentClient[] = [];
function client(...a: ConstructorParameters<typeof AgentClient>): AgentClient {
  const c = new AgentClient(...a);
  clients.push(c);
  return c;
}
afterEach(() => {
  while (clients.length) clients.pop()!.dispose();
});

// ---------------------------------------------------------------------------

describe("protocol", () => {
  it("validates request shape", () => {
    expect(validateRequest(req())).toBeNull();
    expect(validateRequest(req({ w: 3 }))).toMatch(/grid length/);
    expect(validateRequest(req({ type: "nope" as "verify" }))).toMatch(/unknown request type/);
    expect(validateRequest(req({ from: undefined as never }))).toBe("bad from");
    const r = runRequest(req({ w: 0 }));
    expect(r.ok).toBe(false);
  });

  it("runs a verify request to a verdict with the rule check alongside", () => {
    const r = runRequest(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe(1);
    expect(r.type).toBe("verify");
    expect(r.found).toBe(true);
    expect(r.path.length).toBeGreaterThan(5);
    expect(r.inputs!.length).toBe(r.frames);
    expect(r.rules?.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("gives a reason the model can act on when blocked", () => {
    const g = wallLevel(7);
    const r = runRequest(req({ grid: g.solid, w: g.w, h: g.h, to: endOf(g), capMs: 60_000 }));
    expect(r.ok && r.found).toBe(false);
    if (!r.ok) return;
    expect(r.exhausted).toBe(true);
    expect(r.blockedAt).toEqual({ x: 7, y: 7 });
    expect(r.reason).toContain("cannot get from (0,7) to column 15");
    expect(r.reason).toContain("Rule check: blocked at (7,7)");
    expect(r.reason).toContain("climbs at most 6");
  }, 60_000);

  it("over cap is a fail with timedOut", () => {
    const g = IMPOSSIBLE;
    const r = runRequest(req({ grid: g.solid, w: g.w, h: g.h, to: endOf(g), capMs: 30 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.found).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(200);
    expect(r.reason).toContain("within 30 ms");
  });

  it("rulesGate skips the agent when the rule check fails", () => {
    const g = IMPOSSIBLE;
    const r = runRequest(req({ grid: g.solid, w: g.w, h: g.h, to: endOf(g), rulesGate: true }));
    expect(r.ok && r.gated).toBe(true);
    if (!r.ok) return;
    expect(r.found).toBe(false);
    expect(r.nodes).toBe(0);
    expect(r.reason).toContain("13 empty tiles");
  });

  it("rules: false skips the rule check; rules options pass through", () => {
    const off = runRequest(req({ rules: false }));
    expect(off.ok && off.rules).toBeUndefined();
    const g = gapLevel(7, 12);
    const ultra = runRequest(req({ grid: g.solid, w: g.w, h: g.h, to: endOf(g), rules: { tier: "ULTRA" } }));
    expect(ultra.ok && ultra.rules?.ok).toBe(true);
  });

  it("settles start and point goals onto the ground", () => {
    const g = flatLevel(20);
    const r = runRequest(req({ grid: g.solid, w: g.w, h: g.h, from: { x: 1, y: 0 }, to: { x: 15, y: 2 } }));
    expect(r.ok && r.found).toBe(true);
    if (!r.ok) return;
    expect(r.start).toEqual({ x: 1, y: 7 });
    expect(r.path[r.path.length - 1]).toEqual({ x: 15, y: 7 });
  });

  it("fails cleanly when the start has no ground", () => {
    const g = gapLevel(0, 4);
    const r = runRequest(req({ grid: g.solid, w: g.w, h: g.h, from: { x: 2, y: 3 }, to: endOf(g) }));
    expect(r.ok && r.found).toBe(false);
    if (r.ok) expect(r.reason).toContain("no ground");
  });

  it("the runner works FIFO in slices and cancels queued and running jobs", async () => {
    const replies: AgentReply[] = [];
    const runner = new AgentRunner((r) => replies.push(r), 2);
    const g = IMPOSSIBLE;
    const slow = req({ id: "slow", grid: g.solid, w: g.w, h: g.h, to: endOf(g), capMs: 10_000 });
    runner.submit(slow);
    runner.submit(req({ id: "queued" }));
    runner.submit(req({ id: "fast" }));
    runner.cancel("queued");
    expect(replies).toEqual([{ id: "queued", type: "verify", ok: false, error: "cancelled", cancelled: true }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.busy).toBe(true);
    runner.handle({ id: "slow", type: "cancel" });
    expect(replies[1]).toMatchObject({ id: "slow", ok: false, cancelled: true });
    await vi.waitFor(() => expect(replies.length).toBe(3));
    expect(replies[2]).toMatchObject({ id: "fast", ok: true, found: true });
    expect(runner.busy).toBe(false);
  });
});

describe("worker entry", () => {
  it("answers requests posted to its scope and ignores junk", async () => {
    const out: AgentReply[] = [];
    let listener: ((e: MessageEvent) => void) | null = null;
    attachAgentWorker({
      postMessage: (m) => out.push(m as AgentReply),
      addEventListener: (_t, fn) => (listener = fn as (e: MessageEvent) => void),
    });
    listener!({ data: null } as MessageEvent);
    listener!({ data: 42 } as MessageEvent);
    listener!({ data: req({ id: 9 }) } as MessageEvent);
    await vi.waitFor(() => expect(out.length).toBe(1));
    expect(out[0]).toMatchObject({ id: 9, ok: true, found: true });
  });
});

describe("AgentClient in process (no Worker)", () => {
  it("uses the in-process fallback when Workers are unavailable", async () => {
    expect(typeof Worker).toBe("undefined");
    const c = client();
    expect(c.mode).toBe("inprocess");
    const r = await c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) });
    expect(r.found).toBe(true);
    expect(r.path.length).toBeGreaterThan(0);
    expect(c.inFlight).toBe(0);
  });

  it("applies the config caps by default and over cap is a fail", async () => {
    const c = client({ worker: null });
    const t0 = performance.now();
    const r = await c.verify({ grid: IMPOSSIBLE, from: { x: 0, y: 7 }, to: endOf(IMPOSSIBLE), rules: false });
    expect(r.found).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toContain("within 300 ms");
    expect(performance.now() - t0).toBeLessThan(300 + 250);
  });

  it("patrol: start to frontier, reports where it got stuck", async () => {
    const c = client({ worker: null });
    const g = wallLevel(7);
    const r = await c.patrol({ grid: g, from: { x: 0, y: 7 }, to: { x0: 12 }, capMs: 400 });
    expect(r.found).toBe(false);
    expect(r.blockedAt).toEqual({ x: 7, y: 7 });
  });

  it("answers concurrent requests each with its own result", async () => {
    const c = client({ worker: null });
    const [a, b, d] = await Promise.all([
      c.verify({ grid: IMPOSSIBLE, from: { x: 0, y: 7 }, to: endOf(IMPOSSIBLE), capMs: 50 }),
      c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) }),
      c.verify({ grid: gapLevel(0, 4), from: { x: 0, y: 7 }, to: { x: 7, y: 7 } }),
    ]);
    expect(a.found).toBe(false);
    expect(b.found).toBe(true);
    expect(d.found).toBe(true);
    expect(d.path[d.path.length - 1]).toEqual({ x: 7, y: 7 });
  });

  it("cancels via AbortSignal and keeps serving later requests", async () => {
    const c = client({ worker: null });
    const ac = new AbortController();
    const p = c.patrol(
      { grid: IMPOSSIBLE, from: { x: 0, y: 7 }, to: endOf(IMPOSSIBLE), capMs: 10_000 },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(c.inFlight).toBe(0);
    const t0 = performance.now();
    const r = await c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) });
    expect(r.found).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500); // the cancelled search stopped
  });

  it("rejects at once on an already-aborted signal, and after dispose", async () => {
    const c = client({ worker: null });
    const ac = new AbortController();
    ac.abort();
    await expect(c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) }, { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    c.dispose();
    await expect(c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) })).rejects.toThrow(/disposed/);
  });

  it("cancelAll rejects everything in flight", async () => {
    const c = client({ worker: null });
    const q = { grid: IMPOSSIBLE, from: { x: 0, y: 7 }, to: endOf(IMPOSSIBLE), capMs: 10_000 };
    const ps = [c.patrol(q), c.patrol(q)];
    expect(c.inFlight).toBe(2);
    c.cancelAll();
    for (const p of ps) await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(c.inFlight).toBe(0);
  });
});

describe("AgentClient with a Worker", () => {
  it("round-trips through the worker", async () => {
    const w = new FakeWorker();
    const c = client({ worker: w });
    expect(c.mode).toBe("worker");
    const r = await c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE), xRange: [0, 23] });
    expect(r.found).toBe(true);
    expect(r.inputs!.length).toBeGreaterThan(0);
    const sent = w.received[0] as AgentRequest;
    expect(sent).toMatchObject({ type: "verify", w: BEATABLE.w, h: BEATABLE.h, capMs: 300, xRange: [0, 23] });
    expect(sent.grid).toBeInstanceOf(Uint8Array);
  });

  it("forwards cancellation to the worker", async () => {
    const w = new FakeWorker();
    const c = client({ worker: w });
    const ac = new AbortController();
    const p = c.patrol({ grid: IMPOSSIBLE, from: { x: 0, y: 7 }, to: endOf(IMPOSSIBLE), capMs: 10_000 }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(w.received.at(-1)).toMatchObject({ type: "cancel" });
    const r = await c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) });
    expect(r.found).toBe(true);
  });

  it("a hung worker is failed by the watchdog and replaced; queued requests are re-sent", async () => {
    const made: HungWorker[] = [];
    const c = client({
      worker: () => {
        const w = new HungWorker();
        made.push(w);
        return w;
      },
      slackMs: 20,
    });
    const q = { grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) };
    const first = c.verify({ ...q, capMs: 30 });
    const second = c.verify({ ...q, capMs: 5000 }).catch((e) => e);
    const r = await first;
    expect(r.found).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toContain("did not answer within 30 ms");
    expect(made).toHaveLength(2);
    expect(made[0].terminated).toBe(true);
    expect(made[1].received).toHaveLength(1); // the second request, re-sent
    c.dispose();
    expect(await second).toMatchObject({ name: "AbortError" });
  });

  it("a crashing worker rejects its requests and is respawned", async () => {
    let n = 0;
    const c = client({
      worker: () => {
        n++;
        const w = new HungWorker();
        w.postMessage = () => setTimeout(() => w.onerror?.({ message: "boom", preventDefault() {} } as unknown as ErrorEvent), 0);
        return w;
      },
    });
    await expect(c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) })).rejects.toThrow(
      /agent worker crashed: boom/,
    );
    expect(n).toBe(2);
    expect(c.mode).toBe("worker");
  });

  it("falls back to in-process when the factory cannot make a worker", async () => {
    const c = client({
      worker: () => {
        throw new Error("no workers here");
      },
    });
    expect(c.mode).toBe("inprocess");
    expect((await c.verify({ grid: BEATABLE, from: { x: 0, y: 7 }, to: endOf(BEATABLE) })).found).toBe(true);
  });
});
