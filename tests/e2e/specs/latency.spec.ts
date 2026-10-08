/**
 * The three latency-budget contracts (build plan §24 "Latency budget as a
 * test", G-32). These are the contract behind "verified or not shown" and
 * "instant small, one second big". All times are read from the page's own
 * research log (performance.now() base), so harness overhead does not count.
 *
 *  1. A staircase painted at 300 ms per tile with recorded answers delayed by
 *     500 ms: the high-confidence Finish ghost is on screen within 200 ms of
 *     the answer to the third placement's request.
 *
 *     How "within 200 ms of the third placement" is read: the loop is
 *     speculative with newest-wins (§ "Timing budget": one call in flight,
 *     a newer placement supersedes it), so at 300 ms per tile the calls for
 *     placements 1 and 2 are superseded and the third placement's call is
 *     the one that can answer. Its answer cannot arrive before
 *     fillDebounceMs + 500 ms. The 200 ms is the client's whole budget on top
 *     of the model: request building, the debounce, the validator, the rule
 *     check, the playtest agent and the manager. The test asserts
 *       show.t - place3.t <= fillDebounceMs + modelRoundTrip + 200
 *     where modelRoundTrip is the call's measured latency (>= 500 ms), and
 *     that the earlier calls were superseded rather than shown.
 *  2. An answer delayed by 1,200 ms (> callTimeoutMs 900) is dropped and
 *     logged (fill.call with a timeout error) and nothing is shown.
 *  3. An unplayable recorded answer: nothing is shown and the send-back (one
 *     more call carrying the failure reason) is logged.
 */
import { expect, test } from "@playwright/test";
import type { LogEvent, PlacementEvent, ProxyFillBody } from "../../../apps/editor/src/contracts";
import { Editor, type FillCallEvent } from "../support/editor";
import { requestHasPlaced, type FillReply } from "../support/proxyMock";

type Place = PlacementEvent & { type: "place" };
type Show = Extract<LogEvent, { type: "ghost.show" }>;

const STEPS: [number, number][] = [
  [12, 14],
  [13, 13],
  [14, 12],
];
const CADENCE_MS = 300;
const CLIENT_BUDGET_MS = 200;

async function config(ed: Editor): Promise<{ fillDebounceMs: number; callTimeoutMs: number; showNowAbove: number; sendBackIfUnderMs: number }> {
  return ed.page.evaluate(() => {
    const c = (window as any).__pewter.config;
    return { fillDebounceMs: c.fillDebounceMs, callTimeoutMs: c.callTimeoutMs, showNowAbove: c.showNowAbove, sendBackIfUnderMs: c.sendBackIfUnderMs };
  });
}

/** The person's three placements, from the log, in order. */
async function placements(ed: Editor): Promise<Place[]> {
  const places = (await ed.events()).filter((e): e is Place => e.type === "place");
  const want = STEPS.map(([x, y]) => places.find((p) => p.x === x && p.y === y));
  for (const p of want) expect(p, "every step logged as a place event").toBeTruthy();
  return want as Place[];
}

test.describe("latency budget (§24)", () => {
  test("1: staircase at 300 ms/tile, answers delayed 500 ms: Finish on screen within 200 ms of its answer", async ({ page }) => {
    const reply = (b: ProxyFillBody): FillReply =>
      // The recording answers the full staircase; earlier (partial) requests get a decline, equally slow.
      requestHasPlaced(b.request, STEPS) ? { fixture: "finish-staircase", delayMs: 500 } : { fixture: "decline", delayMs: 500 };
    const ed = await Editor.open(page, { proxy: { condition: "llm", fill: reply } });
    const cfg = await config(ed);
    expect(cfg.callTimeoutMs).toBeGreaterThan(500);
    await ed.pick("grass");

    const clicks = await ed.paintTimed(STEPS, CADENCE_MS);
    expect(clicks[2] - clicks[0]).toBeLessThan(2 * CADENCE_MS + 150);

    const g = await ed.waitForGhost(5000);
    // On screen: the layer draws it.
    await expect.poll(async () => (await ed.layer()).visible).toBe(true);
    expect(g.kind).toBe("finish");
    expect(g.confidence).toBeGreaterThanOrEqual(cfg.showNowAbove);
    expect(g.shownBecause).toBe("now");

    const [p1, p2, p3] = await placements(ed);
    // The person really drew at the contract's pace (page clock).
    expect(p2.t - p1.t).toBeGreaterThan(CADENCE_MS - 100);
    expect(p3.t - p2.t).toBeGreaterThan(CADENCE_MS - 100);
    expect(p3.t - p1.t).toBeLessThan(2 * CADENCE_MS + 200);

    const ev = await ed.events();
    const show = ev.find((e): e is Show => e.type === "ghost.show" && e.suggestionId === g.id)!;
    expect(show).toBeTruthy();
    const calls = ev.filter((e): e is FillCallEvent => e.type === "fill.call");
    const winner = calls.find((c) => c.verdictStage === "ok" && !c.superseded && c.t >= p3.t);
    expect(winner, `a verified call after the third placement (${JSON.stringify(calls)})`).toBeTruthy();
    // The model wait was honoured...
    expect(winner!.latencyMs).toBeGreaterThanOrEqual(500);
    // ...and everything the client adds stays within the budget.
    const elapsed = show.t - p3.t;
    const budget = cfg.fillDebounceMs + winner!.latencyMs + CLIENT_BUDGET_MS;
    const note = `ghost.show ${Math.round(elapsed)} ms after the third placement; model round trip ${winner!.latencyMs} ms; client overhead ${Math.round(elapsed - winner!.latencyMs)} ms (budget ${cfg.fillDebounceMs + CLIENT_BUDGET_MS})`;
    test.info().annotations.push({ type: "latency", description: note });
    console.log(`[latency 1] ${note}`);
    expect(elapsed).toBeLessThanOrEqual(budget);
    // Placements 1 and 2 were superseded by newer ones, never shown.
    expect(calls.filter((c) => c.superseded && c.t <= winner!.t).length).toBeGreaterThanOrEqual(2);
    expect(ev.filter((e) => e.type === "ghost.show")).toHaveLength(1);
    ed.expectNoErrors();
  });

  test("2: an answer delayed 1,200 ms is dropped and logged, nothing shown", async ({ page }) => {
    const ed = await Editor.open(page, {
      proxy: { condition: "llm", fill: () => ({ fixture: "finish-staircase", delayMs: 1200 }) },
    });
    const cfg = await config(ed);
    expect(cfg.callTimeoutMs).toBeLessThan(1200);
    await ed.pick("grass");
    await ed.paintTimed(STEPS, CADENCE_MS);
    const [, , p3] = await placements(ed);

    // Wait until the last call has timed out, then past the answer's arrival.
    await expect
      .poll(async () => (await ed.fillCalls()).filter((c) => c.t > p3.t && !c.superseded && /timeout/.test(c.error ?? "")).length, {
        timeout: 5000,
      })
      .toBe(1);
    await page.waitForTimeout(1200 - cfg.callTimeoutMs + 600);

    const calls = await ed.fillCalls();
    const last = calls.filter((c) => c.t > p3.t && !c.superseded);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ mode: "auto", act: null, error: `timeout after ${cfg.callTimeoutMs} ms` });
    expect(last[0].latencyMs).toBeGreaterThanOrEqual(cfg.callTimeoutMs - 5);
    expect(last[0].latencyMs).toBeLessThan(1200);
    // A timed-out call is not sent back.
    expect(calls.some((c) => c.sendBack)).toBe(false);
    // Earlier calls ended superseded or timed out; none reached the verifier.
    expect(calls.every((c) => c.superseded || /timeout/.test(c.error ?? ""))).toBe(true);
    expect(calls.some((c) => c.verdictStage !== undefined)).toBe(false);

    expect(await ed.ghost()).toBeNull();
    expect((await ed.layer()).visible).toBe(false);
    expect((await ed.events()).some((e) => e.type === "ghost.show")).toBe(false);
    ed.expectNoErrors();
  });

  test("3: an unplayable recorded answer is not shown; the send-back is logged", async ({ page }) => {
    const reply = (b: ProxyFillBody): FillReply =>
      requestHasPlaced(b.request, STEPS) ? { fixture: "unplayable-walled-ledge" } : { fixture: "decline" };
    const ed = await Editor.open(page, { proxy: { condition: "llm", fill: reply } });
    const cfg = await config(ed);
    await ed.pick("grass");
    await ed.paintTimed(STEPS, CADENCE_MS);
    const [, , p3] = await placements(ed);

    await expect
      .poll(async () => (await ed.fillCalls()).filter((c) => c.t > p3.t && c.sendBack).length, { timeout: 8000 })
      .toBe(2);
    await page.waitForTimeout(800);

    const calls = (await ed.fillCalls()).filter((c) => c.t > p3.t && !c.superseded);
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    // First answer: well-formed, arrived under sendBackIfUnderMs, failed playability, sent back.
    expect(first).toMatchObject({ act: true, kind: "finish", sendBack: true });
    expect(first.latencyMs).toBeLessThan(cfg.sendBackIfUnderMs);
    expect(["rules", "agent"]).toContain(first.verdictStage);
    expect(first.reason).toBeTruthy();
    // The send-back: one more call, logged as such, also failing.
    expect(second).toMatchObject({ sendBack: true });
    expect(["rules", "agent"]).toContain(second.verdictStage);

    // The proxy got the send-back with the failure reason for the model.
    const sent = ed.proxy!.fills.filter((c) => c.body.request.previousFailure);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.request.previousFailure).toMatchObject({ stage: first.verdictStage, reason: first.reason });

    // Verified or not shown.
    expect(await ed.ghost()).toBeNull();
    expect((await ed.layer()).visible).toBe(false);
    expect((await ed.events()).some((e) => e.type === "ghost.show")).toBe(false);
    for (const [x, y] of [
      [15, 6],
      [16, 9],
    ] as [number, number][])
      expect(await ed.tileAt(x, y)).toBe(0);
    ed.expectNoErrors();
  });
});
