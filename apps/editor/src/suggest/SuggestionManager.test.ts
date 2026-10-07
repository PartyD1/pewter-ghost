import { describe, expect, it } from "vitest";
import { AUTHOR, TILE, type Suggestion, type VerifiedSuggestion } from "../contracts";
import type { GhostConfig } from "./config";
import { FakeClock } from "./fakeClock";
import { SuggestionManager, type ManagerOptions, type ManagerState } from "./SuggestionManager";
import { erase, makeSuggestion, newStroke, paint, placeEntity, testConfig } from "./testUtils";
import { JevTimer } from "./timers/JevTimer";

const T0 = 10_000;

function setup(over: Partial<GhostConfig> = {}, opts: Partial<ManagerOptions> = {}) {
  const clock = new FakeClock(T0);
  const cfg = testConfig(over);
  const shows: { id: string; because: string; t: number }[] = [];
  const ends: { id: string; outcome: string; dwell: number; acceptedCells?: number }[] = [];
  const drops: { id: string; reason: string }[] = [];
  const applies: { id: string; remaining: number; already: number }[] = [];
  const partials: { id: string; count: number; total: number }[] = [];
  const states: ManagerState[] = [];
  const thresholdChanges: number[] = [];
  const m = new SuggestionManager({
    clock,
    config: cfg,
    listeners: {
      onShow: (s, because, t) => shows.push({ id: s.id, because, t }),
      onEnd: (s, outcome, dwell, acceptedCells) =>
        ends.push({ id: s.id, outcome, dwell, acceptedCells }),
      onDrop: (s, reason) => drops.push({ id: s.id, reason }),
      onAcceptApply: (s, info) =>
        applies.push({ id: s.id, remaining: info.remaining.length, already: info.alreadyAccepted.length }),
      onPartial: (s, _c, count, total) => partials.push({ id: s.id, count, total }),
      onStateChange: (st) => states.push(st),
      onThresholdChange: (ch) => thresholdChanges.push(ch.to),
    },
    ...opts,
  });
  const wait = (ms: number) => {
    clock.advance(ms);
    m.tick();
  };
  const now = () => clock.now();
  return { clock, cfg, m, shows, ends, drops, applies, partials, states, thresholdChanges, wait, now };
}

/** Suggestions on distinct, far-apart structures. */
const at = (x: number, over: Partial<Suggestion> = {}): VerifiedSuggestion =>
  makeSuggestion({
    adds: [
      { x, y: 15, tile: TILE.BLOCK },
      { x: x + 1, y: 15, tile: TILE.BLOCK },
    ],
    ...over,
  });

describe("SuggestionManager — confidence timing", () => {
  it("shows a high-confidence suggestion immediately", () => {
    const { m, shows } = setup();
    const s = at(10, { confidence: 0.9 });
    expect(m.offer(s)).toEqual({ status: "shown", because: "now" });
    expect(m.shown).toBe(s);
    expect(m.state).toBe("showing");
    expect(shows).toEqual([{ id: s.id, because: "now", t: T0 }]);
  });

  it("holds a medium-confidence suggestion until the next pause", () => {
    const { m, shows, wait } = setup();
    const s = at(10, { confidence: 0.6 });
    expect(m.offer(s)).toEqual({ status: "held", when: "pause" });
    expect(m.state).toBe("holding");
    wait(799);
    expect(m.shown).toBeNull();
    wait(1);
    expect(m.shown).toBe(s);
    expect(shows[0]!.because).toBe("pause");
  });

  it("a placement resets the idle timer", () => {
    const { m, wait, now } = setup();
    const s = at(10, { confidence: 0.6 });
    m.offer(s);
    wait(700);
    m.onPlacement(paint(now(), 50, 15));
    wait(700);
    expect(m.shown).toBeNull();
    wait(100);
    expect(m.shown).toBe(s);
  });

  it("shows at once with 'pause' when the person is already paused", () => {
    const { m, wait } = setup();
    wait(1000);
    expect(m.offer(at(10, { confidence: 0.5 }))).toEqual({ status: "shown", because: "pause" });
  });

  it("holds a low-confidence suggestion until a long pause", () => {
    const { m, shows, wait } = setup();
    const s = at(10, { confidence: 0.2 });
    expect(m.offer(s)).toEqual({ status: "held", when: "longPause" });
    wait(2499);
    expect(m.shown).toBeNull();
    wait(1);
    expect(m.shown).toBe(s);
    expect(shows[0]!.because).toBe("longPause");
  });

  it("tick(now) accepts an explicit time", () => {
    const { m, clock } = setup();
    m.offer(at(10, { confidence: 0.6 }));
    clock.advance(900);
    m.tick(clock.now());
    expect(m.shown).not.toBeNull();
  });

  it("a model-initiated fix waits for a pause even at high confidence", () => {
    const { m, shows, wait } = setup();
    const fix = at(10, { kind: "fix", confidence: 0.99, label: "gap 9" });
    expect(m.offer(fix)).toEqual({ status: "held", when: "pause" });
    wait(800);
    expect(m.shown).toBe(fix);
    expect(shows[0]!.because).toBe("pause");
  });

  it("uses an injected Timer", () => {
    const { m } = setup({}, { timer: new JevTimer() });
    expect(() => m.offer(at(10))).toThrow("JevTimer not configured");
  });
});

describe("SuggestionManager — request (Ctrl+Space)", () => {
  it("shows the held suggestion now", () => {
    const { m, shows } = setup();
    const s = at(10, { confidence: 0.1 });
    m.offer(s);
    expect(m.requestNow()).toBe("shown");
    expect(m.shown).toBe(s);
    expect(shows[0]!.because).toBe("requested");
  });

  it("onRequest is an alias", () => {
    const { m } = setup();
    m.offer(at(10, { confidence: 0.1 }));
    expect(m.onRequest()).toBe("shown");
  });

  it("reports already-showing", () => {
    const { m } = setup();
    m.offer(at(10));
    expect(m.requestNow()).toBe("already-showing");
  });

  it("with nothing held, the next suggestion within the window shows as requested", () => {
    const { m, wait, shows } = setup();
    expect(m.requestNow()).toBe("pending");
    expect(m.requestPending).toBe(true);
    wait(500);
    expect(m.offer(at(10, { confidence: 0.1 }))).toEqual({ status: "shown", because: "requested" });
    expect(m.requestPending).toBe(false);
    expect(shows).toHaveLength(1);
  });

  it("the pending request expires after requestWindowMs", () => {
    const { m, wait, now } = setup();
    m.requestNow();
    wait(3001);
    expect(m.requestPending).toBe(false);
    m.onPlacement(paint(now(), 90, 15)); // the person is drawing again
    expect(m.offer(at(10, { confidence: 0.1 }))).toEqual({ status: "held", when: "longPause" });
  });

  it("Esc cancels a pending request", () => {
    const { m } = setup();
    m.requestNow();
    expect(m.dismiss()).toBe(false);
    expect(m.requestPending).toBe(false);
  });

  it("mode 'requested' shows immediately", () => {
    const { m } = setup();
    expect(m.offer(at(10, { mode: "requested", confidence: 0.05 }))).toEqual({
      status: "shown",
      because: "requested",
    });
  });
});

describe("SuggestionManager — admission", () => {
  it("drops a suggestion without the verified brand at runtime", () => {
    const { m, drops } = setup();
    const fake = { ...at(10), verified: false } as unknown as VerifiedSuggestion;
    expect(m.offer(fake)).toEqual({ status: "dropped", reason: "unverified" });
    expect(drops).toEqual([{ id: fake.id, reason: "unverified" }]);
  });

  it("respects config.kinds", () => {
    const { m, cfg } = setup();
    cfg.kinds.extend = false;
    expect(m.offer(at(10, { kind: "extend" }))).toEqual({ status: "dropped", reason: "kind-disabled" });
    cfg.kinds.fix = false;
    expect(m.offer(at(10, { kind: "fix", mode: "patrol" })).status).toBe("dropped");
    expect(m.offer(at(10, { kind: "finish" })).status).toBe("shown");
  });

  it("reads a live config getter", () => {
    const clock = new FakeClock(0);
    let cfg = testConfig();
    const m = new SuggestionManager({ clock, config: () => cfg });
    cfg = testConfig({ showNowAbove: 0.95, adaptThresholds: false });
    expect(m.offer(at(10, { confidence: 0.9 })).status).toBe("held");
  });
});

describe("SuggestionManager — reconciliation", () => {
  it("drops a suggestion whose cells were drawn since its request", () => {
    const { m, wait, now, drops } = setup();
    const requestedAt = now();
    wait(100);
    m.onPlacement(paint(now(), 11, 15, TILE.DIRT));
    const s = at(10);
    expect(m.offer(s, { requestedAt })).toEqual({ status: "dropped", reason: "stale" });
    expect(drops[0]).toEqual({ id: s.id, reason: "stale" });
  });

  it("uses latencyMs to infer the request time", () => {
    const { m, wait, now } = setup();
    wait(100);
    m.onPlacement(paint(now(), 11, 15));
    wait(100);
    expect(m.offer(at(10, { latencyMs: 300 })).status).toBe("dropped");
    expect(m.offer(at(10, { latencyMs: 50 })).status).toBe("shown");
  });

  it("keeps a suggestion whose cells were drawn before its request", () => {
    const { m, wait, now } = setup();
    m.onPlacement(paint(now(), 11, 15));
    wait(10);
    expect(m.offer(at(10), { requestedAt: now() }).status).toBe("shown");
  });

  it("drops a held suggestion when the person draws on its cells", () => {
    const { m, now, drops } = setup();
    const s = at(10, { confidence: 0.5 });
    m.offer(s);
    m.onPlacement(paint(now(), 40, 15)); // elsewhere: still held
    expect(m.waiting).toBe(s);
    m.onPlacement(paint(now(), 10, 15)); // even the same tile: the person got there first
    expect(m.waiting).toBeNull();
    expect(drops).toEqual([{ id: s.id, reason: "stale" }]);
    expect(m.state).toBe("idle");
  });

  it("ignores placements by the ghost itself", () => {
    const { m, now } = setup();
    const s = at(10);
    m.offer(s);
    m.onPlacement(paint(now(), 60, 15, TILE.BLOCK, newStroke(), AUTHOR.GHOST));
    expect(m.shown).toBe(s);
  });

  it("onCellsChanged (undo/redo) drops a held one and ends a shown one", () => {
    const { m, now, ends, drops } = setup();
    const held = at(10, { confidence: 0.5 });
    m.offer(held);
    m.onCellsChanged([{ x: 11, y: 15 }]);
    expect(drops).toEqual([{ id: held.id, reason: "stale" }]);
    const shown = at(30);
    m.offer(shown);
    m.onCellsChanged([{ x: 90, y: 2 }]); // elsewhere: nothing
    expect(m.shown).toBe(shown);
    m.onCellsChanged([{ x: 31, y: 15 }], now());
    expect(ends.at(-1)).toMatchObject({ id: shown.id, outcome: "drawn-over" });
  });
});

describe("SuggestionManager — draw-to-dismiss and paint-on-ghost", () => {
  it("painting the proposed tile on a ghost cell is a one-cell partial accept", () => {
    const { m, now, partials, ends } = setup();
    const s = at(10);
    m.offer(s);
    const k = newStroke();
    m.onPlacement(paint(now(), 10, 15, TILE.BLOCK, k));
    expect(partials).toEqual([{ id: s.id, count: 1, total: 2 }]);
    expect(m.shown).toBe(s);
    expect(m.remainingCells).toEqual([{ x: 11, y: 15, type: "add", tile: TILE.BLOCK }]);
    m.onPlacement(paint(now(), 10, 15, TILE.BLOCK, k)); // repaint: no double count
    expect(partials).toHaveLength(1);
    m.onPlacement(paint(now(), 11, 15, TILE.BLOCK, k));
    expect(ends).toEqual([{ id: s.id, outcome: "partial", dwell: 0, acceptedCells: 2 }]);
    expect(m.shown).toBeNull();
  });

  it("a dismissal after some painted cells reports partial with the count", () => {
    const { m, now, ends, wait } = setup();
    const s = at(10);
    m.offer(s);
    m.onPlacement(paint(now(), 10, 15));
    wait(200);
    m.dismiss();
    expect(ends).toEqual([{ id: s.id, outcome: "partial", dwell: 200, acceptedCells: 1 }]);
    expect(m.streak).toBe(0);
  });

  it("painting a different tile on a ghost cell is drawn-over", () => {
    const { m, now, ends } = setup();
    const s = at(10);
    m.offer(s);
    m.onPlacement(paint(now(), 11, 15, TILE.DIRT));
    expect(ends).toEqual([{ id: s.id, outcome: "drawn-over", dwell: 0, acceptedCells: undefined }]);
    expect(m.streak).toBe(1);
  });

  it("erasing on an add cell is drawn-over", () => {
    const { m, now, ends } = setup();
    m.offer(at(10));
    m.onPlacement(erase(now(), 10, 15));
    expect(ends[0]!.outcome).toBe("drawn-over");
  });

  it("painting anywhere else dismisses the ghost (drawn-over)", () => {
    const { m, now, ends } = setup();
    m.offer(at(10));
    m.onPlacement(paint(now(), 80, 3));
    expect(ends[0]!.outcome).toBe("drawn-over");
  });

  it("painting elsewhere keeps the ghost when dismissOnDrawElsewhere is off", () => {
    const { m, now } = setup({ dismissOnDrawElsewhere: false });
    const s = at(10);
    m.offer(s);
    m.onPlacement(paint(now(), 80, 3));
    expect(m.shown).toBe(s);
  });

  it("erasing a proposed removal and placing a proposed entity are partial accepts", () => {
    const { m, now, wait, partials, ends } = setup();
    wait(5000); // outside fix grace
    const fix = makeSuggestion({
      kind: "fix",
      adds: [],
      removes: [{ x: 20, y: 10 }],
      entities: [{ kind: "coin", x: 21, y: 9 }],
      anchor: { x: 20, y: 10 },
      label: "coins",
    });
    m.offer(fix);
    expect(m.shown).toBe(fix);
    m.onPlacement(erase(now(), 20, 10));
    m.onPlacement(placeEntity(now(), 21, 9, "coin"));
    expect(partials.map((p) => p.count)).toEqual([1, 2]);
    expect(ends[0]).toMatchObject({ outcome: "partial", acceptedCells: 2 });
  });
});

describe("SuggestionManager — accept and dismiss", () => {
  it("Tab applies via onAcceptApply then ends accepted with all cells", () => {
    const { m, applies, ends, wait, now } = setup();
    const s = at(10);
    m.offer(s);
    m.onPlacement(paint(now(), 10, 15));
    wait(300);
    expect(m.accept()).toBe(true);
    expect(applies).toEqual([{ id: s.id, remaining: 1, already: 1 }]);
    expect(ends).toEqual([{ id: s.id, outcome: "accepted", dwell: 300, acceptedCells: 2 }]);
    expect(m.state).toBe("idle");
  });

  it("Tab and Esc do nothing without a shown ghost", () => {
    const { m } = setup();
    m.offer(at(10, { confidence: 0.1 }));
    expect(m.accept()).toBe(false);
    expect(m.dismiss()).toBe(false);
    expect(m.waiting).not.toBeNull();
  });

  it("Esc ends esc, starts a cool-down and the state goes cooling -> idle", () => {
    const { m, ends, states, wait } = setup();
    const s = at(10);
    m.offer(s);
    wait(50);
    expect(m.dismiss()).toBe(true);
    expect(ends).toEqual([{ id: s.id, outcome: "esc", dwell: 50, acceptedCells: undefined }]);
    expect(m.state).toBe("cooling");
    wait(4000);
    expect(m.state).toBe("idle");
    expect(states).toEqual(["showing", "cooling", "idle"]); // a confident offer goes straight to showing
  });

  it("a shown ghost times out", () => {
    const { m, ends, wait } = setup({ ghostTimeoutMs: 5000 });
    m.offer(at(10));
    wait(4999);
    expect(m.shown).not.toBeNull();
    wait(1);
    expect(ends[0]).toMatchObject({ outcome: "timeout", dwell: 5000 });
    expect(m.streak).toBe(0); // a timeout is not a dismissal
  });

  it("ghostTimeoutMs 0 means never", () => {
    const { m, wait } = setup({ ghostTimeoutMs: 0 });
    m.offer(at(10));
    wait(10 * 60_000);
    expect(m.shown).not.toBeNull();
  });

  it("reset ends a shown ghost as pending and clears rules", () => {
    const { m, ends, drops } = setup();
    m.offer(at(10));
    m.reset();
    expect(ends[0]!.outcome).toBe("pending");
    m.offer(at(10, { confidence: 0.1 }));
    m.reset({ thresholds: true });
    expect(drops.at(-1)!.reason).toBe("reset");
    expect(m.state).toBe("idle");
  });
});

describe("SuggestionManager — one ghost at a time", () => {
  it("a newer suggestion replaces the shown one", () => {
    const { m, ends } = setup();
    const a = at(10);
    const b = at(30);
    m.offer(a);
    expect(m.offer(b).status).toBe("shown");
    expect(ends).toEqual([{ id: a.id, outcome: "replaced", dwell: 0, acceptedCells: undefined }]);
    expect(m.shown).toBe(b);
    expect(m.streak).toBe(0);
  });

  it("a newer suggestion replaces the shown one even when it must wait", () => {
    const { m, ends } = setup();
    const a = at(10);
    m.offer(a);
    expect(m.offer(at(30, { confidence: 0.5 })).status).toBe("held");
    expect(ends[0]!.outcome).toBe("replaced");
    expect(m.shown).toBeNull();
  });

  it("a newer suggestion supersedes the held one", () => {
    const { m, drops } = setup();
    const a = at(10, { confidence: 0.5 });
    const b = at(30, { confidence: 0.5 });
    m.offer(a);
    m.offer(b);
    expect(drops).toEqual([{ id: a.id, reason: "superseded" }]);
    expect(m.waiting).toBe(b);
  });

  it("an identical suggestion does not replace the shown one", () => {
    const { m, ends } = setup();
    const a = at(10);
    m.offer(a);
    expect(m.offer(at(10))).toEqual({ status: "dropped", reason: "duplicate" });
    expect(m.shown).toBe(a);
    expect(ends).toHaveLength(0);
  });

  it("a patrol fix interrupts a shown Finish immediately", () => {
    const { m, ends, shows } = setup();
    const finish = at(10);
    m.offer(finish);
    const fix = at(30, { kind: "fix", mode: "patrol", confidence: 0.3, label: "unbeatable" });
    expect(m.offer(fix)).toEqual({ status: "shown", because: "patrol" });
    expect(ends[0]).toMatchObject({ id: finish.id, outcome: "replaced" });
    expect(shows.at(-1)).toMatchObject({ id: fix.id, because: "patrol" });
  });

  it("a shown patrol fix is not replaced by an automatic suggestion", () => {
    const { m } = setup();
    const fix = at(30, { kind: "fix", mode: "patrol", label: "unbeatable" });
    m.offer(fix);
    expect(m.offer(at(10))).toEqual({ status: "dropped", reason: "blocked" });
    expect(m.offer(at(60, { kind: "fix", label: "gap" }))).toEqual({ status: "dropped", reason: "blocked" });
    expect(m.shown).toBe(fix);
    expect(m.offer(at(10, { mode: "requested" })).status).toBe("shown");
  });

  it("a newer patrol fix replaces a shown patrol fix", () => {
    const { m } = setup();
    m.offer(at(30, { kind: "fix", mode: "patrol", label: "a" }));
    const b = at(60, { kind: "fix", mode: "patrol", label: "b" });
    expect(m.offer(b).status).toBe("shown");
    expect(m.shown).toBe(b);
  });
});

describe("SuggestionManager — cool-downs", () => {
  it("after a dismissal, no ghost overlapping the same structure for cooldownAfterDismissMs", () => {
    const { m, wait } = setup();
    m.offer(at(10));
    m.dismiss();
    wait(1000);
    expect(m.offer(at(11))).toEqual({ status: "dropped", reason: "cooldown" });
    expect(m.offer(at(12))).toEqual({ status: "dropped", reason: "cooldown" }); // adjacent: margin 1
    expect(m.offer(at(14)).status).toBe("shown"); // a different structure
  });

  it("the cool-down lapses", () => {
    const { m, wait } = setup();
    m.offer(at(10));
    m.dismiss();
    wait(3999);
    expect(m.offer(at(10)).status).toBe("dropped");
    wait(1);
    expect(m.offer(at(10)).status).toBe("shown");
  });

  it("drawn-over also starts a cool-down", () => {
    const { m, now } = setup();
    m.offer(at(10));
    m.onPlacement(paint(now(), 70, 15));
    expect(m.offer(at(10)).status).toBe("dropped");
  });

  it("an accept does not start a cool-down", () => {
    const { m } = setup();
    m.offer(at(10));
    m.accept();
    expect(m.offer(at(12)).status).toBe("shown");
  });

  it("a request bypasses the cool-down", () => {
    const { m } = setup();
    m.offer(at(10));
    m.dismiss();
    m.requestNow();
    expect(m.offer(at(10)).status).toBe("shown");
  });

  it("honours cooldownMarginTiles", () => {
    const { m } = setup({ cooldownMarginTiles: 0 });
    m.offer(at(10));
    m.dismiss();
    expect(m.offer(at(12)).status).toBe("shown");
  });
});

describe("SuggestionManager — dismiss streak", () => {
  /** Show and Esc three ghosts on structures near x = 10..20. */
  function dismissThree(h: ReturnType<typeof setup>) {
    for (const x of [10, 14, 18]) {
      h.m.offer(at(x));
      h.m.dismiss();
    }
  }

  it("after maxDismissStreak dismissals, automatic ghosts wait", () => {
    const h = setup();
    dismissThree(h);
    expect(h.m.locked).toBe(true);
    expect(h.m.state).toBe("cooling");
    const s = at(40, { confidence: 0.99 });
    expect(h.m.offer(s)).toEqual({ status: "held", when: "locked" });
    h.wait(10_000);
    expect(h.m.shown).toBeNull();
    expect(h.m.state).toBe("holding");
  });

  it("…until asked", () => {
    const h = setup();
    dismissThree(h);
    const s = at(40);
    h.m.offer(s);
    expect(h.m.requestNow()).toBe("shown");
    expect(h.shows.at(-1)).toMatchObject({ id: s.id, because: "requested" });
  });

  it("…or until a placement starts a new structure far away", () => {
    const h = setup();
    dismissThree(h);
    const old = at(40, { confidence: 0.99 });
    h.m.offer(old);
    h.m.onPlacement(paint(h.now(), 22, 15)); // near the dismissed ones: still locked
    expect(h.m.locked).toBe(true);
    h.m.onPlacement(paint(h.now(), 100, 15)); // far: a new structure
    expect(h.m.locked).toBe(false);
    expect(h.m.streak).toBe(0);
    expect(h.drops.at(-1)).toEqual({ id: old.id, reason: "superseded" });
    expect(h.m.offer(at(101, { confidence: 0.99, latencyMs: 0 }), { requestedAt: h.now() }).status).toBe(
      "shown",
    );
  });

  it("an accept resets the streak", () => {
    const h = setup();
    h.m.offer(at(10));
    h.m.dismiss();
    h.m.offer(at(14));
    h.m.dismiss();
    h.m.offer(at(18));
    h.m.accept();
    expect(h.m.streak).toBe(0);
    h.m.offer(at(30));
    h.m.dismiss();
    expect(h.m.locked).toBe(false);
  });

  it("patrol fixes are exempt from the streak", () => {
    const h = setup();
    dismissThree(h);
    expect(h.m.offer(at(60, { kind: "fix", mode: "patrol", label: "x" })).status).toBe("shown");
  });

  it("maxDismissStreak 0 disables the lock", () => {
    const h = setup({ maxDismissStreak: 0 });
    dismissThree(h);
    expect(h.m.offer(at(60)).status).toBe("shown");
  });
});

describe("SuggestionManager — Fix rules", () => {
  const fixAt = (x: number, over: Partial<Suggestion> = {}) =>
    makeSuggestion({
      kind: "fix",
      adds: [{ x, y: 15, tile: TILE.GRASS }],
      removes: [{ x: x + 1, y: 14 }],
      anchor: { x: x + 1, y: 14 },
      label: "gap 9 · knight clears 6",
      ...over,
    });

  it("never a fix touching cells placed within fixGraceMs", () => {
    const { m, wait, now } = setup();
    m.onPlacement(paint(now(), 11, 14)); // a removal cell of the fix
    wait(2999);
    expect(m.offer(fixAt(10), { requestedAt: now() })).toEqual({ status: "dropped", reason: "grace" });
    wait(1);
    // Outside the grace; the person has been idle long enough, so it shows at the pause.
    expect(m.offer(fixAt(10), { requestedAt: now() })).toEqual({ status: "shown", because: "pause" });
  });

  it("grace applies to patrol and requested fixes too", () => {
    const { m, now } = setup();
    m.onPlacement(paint(now(), 10, 15, TILE.DIRT));
    expect(m.offer(fixAt(10, { mode: "patrol" }), { requestedAt: now() })).toEqual({
      status: "dropped",
      reason: "grace",
    });
    expect(m.offer(fixAt(10, { mode: "requested" }), { requestedAt: now() })).toEqual({
      status: "dropped",
      reason: "grace",
    });
  });

  it("a finish/extend touching recent cells is not subject to grace", () => {
    const { m, now } = setup();
    m.onPlacement(paint(now(), 10, 15));
    expect(m.offer(at(10, { confidence: 0.9 }), { requestedAt: now() }).status).toBe("shown");
  });

  it("one fix per problem per fixPerProblemMs", () => {
    const { m, wait } = setup();
    wait(5000);
    m.offer(fixAt(10));
    wait(800);
    expect(m.shown).not.toBeNull();
    m.accept();
    expect(m.offer(fixAt(10))).toEqual({ status: "dropped", reason: "rate-limited" });
    // Same caption elsewhere is a different problem.
    expect(m.offer(fixAt(40)).status).toBe("shown");
    m.accept();
    wait(60_000);
    expect(m.offer(fixAt(10)).status).toBe("shown");
  });

  it("a drawn-over fix mutes its problem until its cells change", () => {
    const { m, wait, now, drops } = setup({ fixPerProblemMs: 0 });
    wait(5000);
    m.offer(fixAt(10));
    wait(800);
    expect(m.shown).not.toBeNull();
    const k = newStroke();
    m.onPlacement(paint(now(), 70, 15, TILE.BLOCK, k)); // draw elsewhere: drawn-over
    expect(m.isMuted(fixAt(10))).toBe(true);
    wait(5000);
    expect(m.offer(fixAt(10)).status).toBe("dropped");
    expect(drops.at(-1)!.reason).toBe("muted");
    // The same stroke crossing the fix's cells does not count as a change.
    m.onPlacement(paint(now(), 10, 15, TILE.BLOCK, k));
    expect(m.isMuted(fixAt(10))).toBe(true);
    // A later stroke on one of its cells does.
    m.onPlacement(paint(now(), 11, 14, TILE.BLOCK));
    expect(m.isMuted(fixAt(10))).toBe(false);
    wait(5000);
    expect(m.offer(fixAt(10)).status).toBe("shown");
  });

  it("an Esc'd fix is not muted (only drawn-over mutes)", () => {
    const { m, wait } = setup({ fixPerProblemMs: 0 });
    wait(5000);
    m.offer(fixAt(10));
    wait(800);
    m.dismiss();
    expect(m.isMuted(fixAt(10))).toBe(false);
  });

  it("undo/redo changes unmute a problem", () => {
    const { m, wait, now } = setup({ fixPerProblemMs: 0 });
    wait(5000);
    m.offer(fixAt(10));
    wait(800);
    m.onPlacement(paint(now(), 10, 15, TILE.DIRT)); // conflict on its add cell
    expect(m.isMuted(fixAt(10))).toBe(true);
    m.onCellsChanged([{ x: 10, y: 15 }]);
    expect(m.isMuted(fixAt(10))).toBe(false);
  });

  it("a requested fix bypasses mute and rate limit", () => {
    const { m, wait, now } = setup();
    wait(5000);
    m.offer(fixAt(10));
    wait(800);
    m.onPlacement(paint(now(), 70, 15));
    wait(5000);
    expect(m.offer(fixAt(10, { mode: "requested" })).status).toBe("shown");
  });
});

describe("SuggestionManager — per-person thresholds", () => {
  it("two drawn-over dismissals raise showNowAbove so a 0.78 ghost waits", () => {
    const { m, now, wait, thresholdChanges } = setup();
    m.offer(at(10, { confidence: 0.78 }));
    m.onPlacement(paint(now(), 100, 2));
    wait(5000);
    m.offer(at(30, { confidence: 0.78 }));
    m.onPlacement(paint(now(), 100, 2));
    expect(m.showNowAbove).toBe(0.8);
    expect(thresholdChanges).toEqual([0.8]);
    wait(5000);
    m.onPlacement(paint(now(), 50, 2));
    expect(m.offer(at(60, { confidence: 0.78 }))).toEqual({ status: "held", when: "pause" });
  });

  it("two accepts lower it so a 0.72 ghost shows now", () => {
    const { m } = setup();
    m.offer(at(10));
    m.accept();
    m.offer(at(30));
    m.accept();
    expect(m.showNowAbove).toBe(0.7);
    expect(m.offer(at(60, { confidence: 0.72 })).status).toBe("shown");
  });
});

describe("SuggestionManager — state machine", () => {
  it("idle -> holding -> showing -> cooling -> idle", () => {
    const { m, states, wait } = setup();
    expect(m.state).toBe("idle");
    m.offer(at(10, { confidence: 0.5 }));
    wait(800);
    m.dismiss();
    wait(4000);
    expect(states).toEqual(["holding", "showing", "cooling", "idle"]);
  });
});
