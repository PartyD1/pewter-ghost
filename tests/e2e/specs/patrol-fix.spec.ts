/**
 * Whole-level patrol and Fix (G-23, G-24): when the level stops being
 * beatable, idle patrol finds where the knight is stuck, asks the model for a
 * Fix, verifies it, and shows it; a Fix with removals is applied by Tab and
 * taken back exactly by one undo.
 */
import { expect, test } from "@playwright/test";
import type { LogEvent, ProxyFillBody } from "../../../apps/editor/src/contracts";
import { A, Editor, T } from "../support/editor";
import type { FillReply } from "../support/proxyMock";

type PatrolEvent = Extract<LogEvent, { type: "patrol" }>;

/** Patrol requests get `fixture`; speculative ones are declined. */
const patrolReply =
  (fixture: string) =>
  (b: ProxyFillBody): FillReply =>
    b.request.mode === "patrol" ? { fixture } : { fixture: "decline" };

test.describe("patrol and fix", () => {
  test("an unbeatable level gets a Fix ghost after idle", async ({ page }) => {
    const ed = await Editor.open(page, { proxy: { condition: "llm", fill: patrolReply("patrol-bridge-fix") }, starter: "platforms" });
    await ed.pick("grass");
    // A platform across a 14-wide pit from the start platform: the knight cannot get there.
    await ed.drag([26, 27, 28, 29, 30, 31].map((x) => [x, 15]));
    const drawnAt = Date.now();

    const g = await ed.waitForGhost(20_000);
    // Patrol waits for patrolIdleMs (3 s) of quiet.
    expect(Date.now() - drawnAt).toBeGreaterThanOrEqual(2500);
    expect(g.kind).toBe("fix");
    expect(g.shownBecause).toBe("patrol");
    expect(g.mode).toBe("patrol");
    expect(g.adds.map((a) => [a.x, a.y])).toEqual([
      [15, 15],
      [16, 15],
      [17, 15],
      [20, 15],
      [21, 15],
      [22, 15],
    ]);

    const ev = await ed.events();
    const blocked = ev.find((e): e is PatrolEvent => e.type === "patrol" && !e.beatable);
    expect(blocked?.blockedAt).toEqual({ x: 11, y: 14 });
    // The patrol request names where the knight got stuck and why.
    const asked = ed.proxy!.fills.find((c) => c.body.request.mode === "patrol")!;
    expect(asked).toBeTruthy();
    const req = asked.body.request;
    expect({ x: req.blockedAt!.x + req.origin.x, y: req.blockedAt!.y + req.origin.y }).toEqual({ x: 11, y: 14 });
    expect(req.previousFailure?.reason).toBeTruthy();
    expect((await ed.fillCalls()).find((c) => c.mode === "patrol")).toMatchObject({ kind: "fix", verdictStage: "ok" });

    // Accept; the next patrol finds the level beatable.
    await page.keyboard.press("Tab");
    for (const a of g.adds) expect(await ed.authorAt(a.x, a.y)).toBe(A.GHOST);
    await expect
      .poll(async () => (await ed.events()).some((e) => e.type === "patrol" && e.beatable), { timeout: 15_000 })
      .toBe(true);
    ed.expectNoErrors();
  });

  test("Fix with removals: Tab applies both, one undo restores the level exactly", async ({ page }) => {
    const ed = await Editor.open(page, { proxy: { condition: "llm", fill: patrolReply("patrol-lower-ledge-fix") }, starter: "platforms" });
    await ed.pick("grass");
    // A ledge 7 tiles above the ground: too high to reach.
    await ed.drag([16, 17, 18, 19, 20, 21, 22].map((x) => [x, 8]));

    const g = await ed.waitForGhost(20_000);
    expect(g.kind).toBe("fix");
    expect(g.removes).toEqual([
      { x: 16, y: 8 },
      { x: 17, y: 8 },
      { x: 18, y: 8 },
    ]);
    await expect.poll(async () => (await ed.layer()).removes).toBe(3);
    const L = await ed.layer();
    expect(L.kind).toBe("fix");
    expect(L.adds).toBe(3);
    // Nothing changes before Tab.
    expect(await ed.tileAt(16, 8)).toBe(T.GRASS);
    expect(await ed.tileAt(16, 10)).toBe(T.EMPTY);

    const before = await ed.snapshotJson();
    const depth = await ed.undoDepth();
    await page.keyboard.press("Tab");
    for (const r of g.removes) expect(await ed.tileAt(r.x, r.y)).toBe(T.EMPTY);
    for (const a of g.adds) {
      expect(await ed.tileAt(a.x, a.y)).toBe(T.GRASS);
      expect(await ed.authorAt(a.x, a.y)).toBe(A.GHOST);
    }
    // The untouched rest of the person's ledge is still theirs.
    expect(await ed.authorAt(19, 8)).toBe(A.PERSON);
    expect(await ed.undoDepth()).toBe(depth + 1);

    await page.keyboard.press("Control+z");
    expect(await ed.snapshotJson()).toBe(before);
    expect((await ed.events()).find((e) => e.type === "ghost.end" && e.suggestionId === g.id)).toMatchObject({ outcome: "accepted" });
    ed.expectNoErrors();
  });
});
