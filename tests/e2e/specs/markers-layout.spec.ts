/**
 * Fixes from the lab's review:
 * - nothing covers the drawing area (panel and toolbar sit beside/below the canvas);
 * - the Start pennant can be erased and dragged; the Goal flag can be dragged;
 * - in development a plain reload starts fresh, Save task reloads into what it saved.
 */
import { expect, test, type Page } from "@playwright/test";
import { Editor } from "../support/editor";

const markers = (page: Page) =>
  page.evaluate(() => {
    const m = (window as any).__pewter.model;
    return { start: m.start, flags: m.entities.filter((e: any) => e.kind === "flag").map((e: any) => [e.x, e.y]) };
  });

test("the panel and toolbar do not overlap the canvas", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null });
  const r = await page.evaluate(() => {
    const box = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON();
    return { canvas: box("canvas"), panel: box(".pt-chatbox"), toolbar: box(".pt-toolbar") };
  });
  const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  expect(overlaps(r.canvas, r.panel)).toBe(false);
  expect(overlaps(r.canvas, r.toolbar)).toBe(false);
  ed.expectNoErrors();
});

test("the Start pennant can be erased (back to the default start) and dragged in Select mode", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null });
  const def = (await markers(page)).start;
  await ed.pick("start");
  await ed.clickTile(10, 10);
  expect((await markers(page)).start).toEqual({ x: 10, y: 10 });

  await page.keyboard.press("1"); // Select
  await ed.drag([[10, 10], [12, 9], [14, 8]]);
  expect((await markers(page)).start).toEqual({ x: 14, y: 8 });
  await page.keyboard.press("Control+z");
  expect((await markers(page)).start).toEqual({ x: 10, y: 10 });

  await ed.pick("eraser");
  await ed.clickTile(10, 10);
  expect((await markers(page)).start).toEqual(def);
  ed.expectNoErrors();
});

test("the Goal flag can be dragged in Select mode, but not into the ground", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null });
  await ed.pick("flag");
  await ed.clickTile(12, 10);
  expect((await markers(page)).flags).toEqual([[12, 10]]);
  await page.keyboard.press("1");
  await ed.drag([[12, 10], [16, 9]]);
  expect((await markers(page)).flags).toEqual([[16, 9]]);
  // The starter map's ground: dropping there is refused and the ground stays.
  const groundY = await page.evaluate(() => { const m = (window as any).__pewter.model; for (let y = 0; y < m.h; y++) if (m.isSolid(16, y)) return y; return -1; });
  expect(groundY).toBeGreaterThan(0);
  await ed.drag([[16, 9], [16, groundY + 1]]);
  expect((await markers(page)).flags).toEqual([[16, 9]]);
  expect(await page.evaluate((y) => (window as any).__pewter.model.isSolid(16, y + 1), groundY)).toBe(true);
  ed.expectNoErrors();
});

test("development: a plain reload starts fresh; Save task reloads into what it saved", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null });
  await ed.pick("grass");
  await ed.clickTile(10, 6);
  expect(await ed.tileAt(10, 6)).not.toBe(0);
  // Plain reload, no ?fresh: the starter level again.
  await page.goto("./", { waitUntil: "load" });
  await page.waitForFunction(() => (window as any).__pewter?.app);
  await page.evaluate(() => (window as any).__pewter.app.ready);
  expect(await page.evaluate(() => (window as any).__pewter.model.tileAt(10, 6))).toBe(0);
  // Paint, Save task (saves and reloads): the tile comes back.
  const ed2 = await Editor.open(page, { proxy: null, fresh: false });
  await ed2.pick("grass");
  await ed2.clickTile(10, 6);
  const nav = page.waitForEvent("load");
  await page.click('[data-cmd="reload"]');
  await nav;
  await page.waitForFunction(() => (window as any).__pewter?.app);
  await page.evaluate(() => (window as any).__pewter.app.ready);
  expect(await page.evaluate(() => (window as any).__pewter.model.tileAt(10, 6))).not.toBe(0);
});
