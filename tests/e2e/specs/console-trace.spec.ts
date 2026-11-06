/**
 * Console trace: with ?trace=1 the real editor prints the keys, mouse buttons
 * and hovers it records to the browser console, and window.pewterLog lets a
 * person (or a script) read, trace and download the log from the console.
 */
import { expect, test } from "@playwright/test";
import { Editor } from "../support/editor";

test("?trace=1 prints keys, mouse buttons and hovers to the console", async ({ page }) => {
  const lines: string[] = [];
  page.on("console", (m) => m.text().startsWith("[pewter") && lines.push(m.text()));
  const ed = await Editor.open(page, { proxy: null, params: { filler: "none", trace: "1" } });

  await ed.pick("grass");
  await ed.clickTile(14, 10);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("2");
  await page.waitForTimeout(700); // the recorder batches pointer input for up to half a second

  const text = lines.join("\n");
  expect(text).toContain("trace on");
  expect(text).toMatch(/hover tile \(\d+, \d+\)/);
  expect(text).toMatch(/mouse left down at px \(\d+, \d+\) tile \(14, 10\)/);
  expect(text).toMatch(/mouse left up at px/);
  expect(text).toContain("key KeyZ down");
  expect(text).toContain("key KeyZ up");
  expect(text).toContain("key Digit2 down");
  expect(text).toMatch(/edit by person: 1 cell/);
  expect(text).toMatch(/undo \(own\)/);
  // Every line carries a running clock.
  for (const l of lines.filter((l) => !l.includes("trace on"))) expect(l).toMatch(/^\[pewter \+\d+\.\d\ds\] /);
  ed.expectNoErrors();
});

test("pewterLog in the console: switch the trace on and off, read and download the log", async ({ page }) => {
  const lines: string[] = [];
  page.on("console", (m) => m.text().startsWith("[pewter") && lines.push(m.text()));
  const ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });

  // Off by default: nothing is printed.
  await page.keyboard.press("Shift+KeyA");
  await page.waitForTimeout(200);
  expect(lines).toEqual([]);

  // Turned on from the console.
  expect(await page.evaluate(() => (window as any).pewterLog.trace())).toBe(true);
  await page.keyboard.press("KeyB");
  await expect.poll(() => lines.some((l) => l.includes("key KeyB down"))).toBe(true);

  // ... and off again.
  await page.evaluate(() => (window as any).pewterLog.trace(false));
  const before = lines.length;
  await page.keyboard.press("KeyC");
  await page.waitForTimeout(200);
  expect(lines.length).toBe(before);

  // The recorded events are readable from the console.
  const keys = await page.evaluate(() =>
    (window as any).pewterLog.events().filter((e: { type: string }) => e.type === "key").map((e: { code: string; down: boolean }) => `${e.code}:${e.down}`),
  );
  expect(keys).toEqual(expect.arrayContaining(["KeyA:true", "KeyB:true", "KeyC:true"]));
  expect(await page.evaluate(() => (window as any).pewterLog.tail(3).length)).toBe(3);
  const stats = await page.evaluate(() => (window as any).pewterLog.stats());
  expect(stats).toMatchObject({ failedPosts: 0, invalid: 0 });
  expect((stats as { logged: number }).logged).toBeGreaterThan(5);

  // download() hands the person the session log as a .jsonl file.
  const [file] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => (window as any).pewterLog.download())]);
  expect(file.suggestedFilename()).toMatch(/\.jsonl$/);
  ed.expectNoErrors();
});

test("the trace choice is remembered across reloads", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  await page.evaluate(() => (window as any).pewterLog.trace(true));
  expect(await page.evaluate(() => localStorage.getItem("pewter.trace"))).toBe("1");
  await page.evaluate(() => (window as any).pewterLog.trace(false));
  expect(await page.evaluate(() => localStorage.getItem("pewter.trace"))).toBe("0");
  ed.expectNoErrors();
});
