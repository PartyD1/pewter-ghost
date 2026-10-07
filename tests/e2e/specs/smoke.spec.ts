/**
 * Smoke (G-07 harness): the editor boots with the replayed proxy, the session
 * resolves, the research log starts with the session event and reaches the
 * proxy, and nothing is written to the console as an error.
 */
import { expect, test } from "@playwright/test";
import { Editor } from "../support/editor";

test("boots with the replayed proxy and no console errors", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: { condition: "llm", sessionId: "e2e-smoke" } });

  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.locator('[data-cmd="save"]')).toBeVisible();
  await expect(page.locator('[data-item="grass"]')).toBeVisible();
  await expect(page.locator("#ghost-status")).toBeVisible();

  const info = await page.evaluate(() => {
    const a = (window as any).__pewter.app;
    return { filler: a.loop.activeFiller, fromProxy: a.session.fromProxy, sessionId: a.session.sessionId };
  });
  expect(info).toEqual({ filler: "llm", fromProxy: true, sessionId: "e2e-smoke" });
  expect(ed.proxy!.sessions).toEqual(["e2e-token"]);

  const strip = await ed.strip();
  expect(strip?.main).toBe("quiet · Ctrl+Space to ask");
  // The condition is never shown to the person.
  expect(await page.locator("#ghost-status").innerText()).not.toMatch(/stub|llm|algo|jev/i);

  const events = await ed.events();
  expect(events[0]).toMatchObject({ type: "session", sessionId: "e2e-smoke", filler: "llm" });
  // The session event copies the config, never the token.
  expect(JSON.stringify(events[0])).not.toContain("e2e-token");

  // The research log reaches POST /log.
  expect(await page.evaluate(() => (window as any).__pewter.app.flushLog())).toBe(true);
  expect(ed.proxy!.loggedEvents[0]).toMatchObject({ type: "session", sessionId: "e2e-smoke" });
  expect(ed.proxy!.logBatches.every((b) => b.sessionId === "e2e-smoke")).toBe(true);

  await page.waitForTimeout(1000);
  ed.expectNoErrors();
});

test("boots without a proxy (local session, no token) and no console errors", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null, params: { filler: "stub" } });
  const info = await page.evaluate(() => {
    const a = (window as any).__pewter.app;
    return { filler: a.loop.activeFiller, fromProxy: a.session.fromProxy };
  });
  expect(info).toEqual({ filler: "stub", fromProxy: false });
  const events = await ed.events();
  expect(events[0]).toMatchObject({ type: "session", filler: "stub" });
  await page.waitForTimeout(1000);
  ed.expectNoErrors();
});
