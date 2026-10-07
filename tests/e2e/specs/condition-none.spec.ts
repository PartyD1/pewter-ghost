/**
 * Condition "none" (G-33): a human-only session. The proxy assigns the token
 * to "none"; the editor makes no /fill calls, runs no patrol and shows no
 * ghost, even for an unbeatable level and Ctrl+Space, and never says why.
 */
import { expect, test } from "@playwright/test";
import { Editor } from "../support/editor";

test("condition none shows nothing and makes no /fill calls", async ({ page }) => {
  const ed = await Editor.open(page, {
    proxy: { condition: "none", fill: () => ({ fixture: "finish-staircase" }) },
  });
  expect(await page.evaluate(() => (window as any).__pewter.app.loop.activeFiller)).toBe("none");

  await ed.pick("grass");
  for (const [x, y] of [
    [12, 14],
    [13, 13],
    [14, 12],
  ] as [number, number][]) {
    await ed.clickTile(x, y);
    await page.waitForTimeout(150);
  }
  // Unbeatable on purpose: patrol would ask for a Fix in the llm condition.
  await ed.drag([26, 27, 28, 29, 30, 31].map((x) => [x, 15]));
  await page.keyboard.press("Control+Space");
  // Past fillDebounceMs, pauseMs, longPauseMs and patrolIdleMs.
  await page.waitForTimeout(5000);

  expect(ed.proxy!.fills).toHaveLength(0);
  expect(await ed.ghost()).toBeNull();
  expect((await ed.layer()).visible).toBe(false);
  const ev = await ed.events();
  expect(ev[0]).toMatchObject({ type: "session", filler: "none" });
  expect(ev.filter((e) => e.type === "place").length).toBeGreaterThanOrEqual(9);
  expect(ev.filter((e) => ["fill.call", "ghost.show", "ghost.end", "patrol"].includes(e.type))).toEqual([]);
  // The status strip says nothing about a ghost or the condition.
  const status = await page.locator("#ghost-status").innerText();
  expect(status).not.toMatch(/ghost|asked|stub|llm|algo|none/i);
  ed.expectNoErrors();
});
