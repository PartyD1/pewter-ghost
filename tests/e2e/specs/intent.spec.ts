/**
 * Level goal: the question at the start of a level, the presets, and Help > Level goal.
 */
import { expect, test } from "@playwright/test";
import { Editor } from "../support/editor";

const intentOf = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__pewter.app.loop.intent as string);

test("a fresh level with the AI on asks for a goal; a preset fills the box and Start applies it", async ({ page }) => {
  // The helper skips the question; opening the page without ?intent= brings it back.
  await Editor.open(page, { proxy: { fill: () => ({ fixture: "decline" }) }, params: {} });
  const url = new URL(page.url());
  url.searchParams.delete("intent");
  await page.goto(url.toString(), { waitUntil: "load" });
  const dialog = page.locator("#pg-intent");
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-preset="maze"]').click();
  await expect(page.locator("#pg-intent-text")).toHaveValue(/maze/i);
  await page.locator("#pg-intent-start").click();
  await expect(dialog).toHaveCount(0);
  expect(await intentOf(page)).toMatch(/maze/i);
});

test("Help > Level goal edits the goal and Clear removes it", async ({ page }) => {
  await Editor.open(page, { proxy: { fill: () => ({ fixture: "decline" }) } });
  expect(await intentOf(page)).toBe("");
  await page.keyboard.press("?");
  await page.locator('#pg-help [data-cmd="intent"], [data-cmd="intent"]').first().click();
  await page.locator("#pg-intent-text").fill("a  parkour course");
  await page.locator("#pg-intent-start").click();
  expect(await intentOf(page)).toBe("a parkour course");

  await page.keyboard.press("?");
  await page.locator('[data-cmd="intent"]').first().click();
  await page.locator("#pg-intent-skip").click(); // "Clear goal" while one is set
  expect(await intentOf(page)).toBe("");
});
