/**
 * The editor fits the window: nothing is cut off, whatever the window size,
 * and painting still lands on the tile under the mouse when the canvas is shrunk.
 */
import { expect, test, type Page } from "@playwright/test";
import { Editor } from "../support/editor";

const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON();
    const buttons = [...document.querySelectorAll(".pt-toolbar button")].map((b) => b.getBoundingClientRect().toJSON());
    return {
      canvas: box("canvas"),
      panel: box(".pt-chatbox"),
      title: box(".app-title"),
      buttons,
      view: { w: innerWidth, h: innerHeight },
      page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    };
  });

for (const [w, h] of [[1440, 780], [1280, 620], [1024, 640], [800, 500]] as const) {
  test(`everything is on screen at ${w}x${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const ed = await Editor.open(page, { proxy: null });
    const r = await boxes(page);
    for (const b of [r.canvas, r.panel, r.title, ...r.buttons]) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(w);
      expect(b.bottom).toBeLessThanOrEqual(h);
    }
    expect(r.page).toEqual(r.view); // no scrollbars
    expect(r.panel.bottom).toBeLessThanOrEqual(r.canvas.bottom + 1);
    ed.expectNoErrors();
  });
}

test("a big window keeps the full-size canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const ed = await Editor.open(page, { proxy: null });
  const r = await boxes(page);
  expect([r.canvas.width, r.canvas.height]).toEqual([928, 720]);
  ed.expectNoErrors();
});

test("painting lands on the right tile when the canvas is shrunk, and it refits on resize", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  const ed = await Editor.open(page, { proxy: null });
  expect((await boxes(page)).canvas.width).toBeLessThan(928);
  await ed.pick("grass");
  await ed.clickTile(10, 6);
  expect(await ed.tileAt(10, 6)).not.toBe(0);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await boxes(page)).canvas.width).toBe(928);
  await ed.clickTile(14, 6);
  expect(await ed.tileAt(14, 6)).not.toBe(0);
  ed.expectNoErrors();
});

test("zooming with pinch keeps the point under the mouse still when the canvas is shrunk", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  const ed = await Editor.open(page, { proxy: null });
  const p = await ed.screenOf(20, 10);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -40);
  await page.keyboard.up("Control");
  await ed.settle();
  const after = await ed.screenOf(20, 10);
  expect(Math.abs(after.x - p.x)).toBeLessThan(3);
  expect(Math.abs(after.y - p.y)).toBeLessThan(3);
  ed.expectNoErrors();
});
