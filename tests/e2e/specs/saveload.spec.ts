/**
 * Saving and opening levels (G-08, G-37): Save task writes a v2 file that Load
 * reads back exactly; an old Pewter (v1) save is converted; a share code
 * round-trips the level.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { A, Editor, T } from "../support/editor";

const here = path.dirname(fileURLToPath(import.meta.url));
const V1_FILE = path.resolve(here, "../fixtures/levels/v1-small.json");

interface LevelView {
  cells: number[];
  authors: number[];
  start: { x: number; y: number };
  entities: { kind: string; x: number; y: number }[];
}

async function levelView(ed: Editor): Promise<LevelView> {
  return ed.page.evaluate(() => {
    const s = (window as any).__pewter.model.snapshot();
    return {
      cells: s.cells,
      authors: s.authors,
      start: s.start,
      entities: s.entities
        .map((e: any) => ({ kind: e.kind, x: e.x, y: e.y }))
        .sort((a: any, b: any) => a.x - b.x || a.y - b.y || a.kind.localeCompare(b.kind)),
    };
  });
}

async function drawSomething(ed: Editor): Promise<void> {
  await ed.pick("grass");
  await ed.drag([14, 15, 16, 17].map((x) => [x, 12]));
  await ed.pick("block");
  await ed.drag([20, 21].map((x) => [x, 10]));
  await ed.pick("coin");
  await ed.clickTile(15, 10);
}

test.describe("save and load", () => {
  let ed: Editor;
  test.beforeEach(async ({ page }) => {
    ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  });
  test.afterEach(() => ed.expectNoErrors());

  test("Save task writes a v2 file and Load restores it exactly", async ({ page }) => {
    await drawSomething(ed);
    const saved = await levelView(ed);
    expect(saved.entities.some((e) => e.kind === "coin" && e.x === 15 && e.y === 10)).toBe(true);

    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-cmd="save"]')]);
    const file = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(file.version).toBe(2);
    expect(dl.suggestedFilename()).toMatch(/\.json$/);
    expect((await ed.events()).some((e) => e.type === "save")).toBe(true);

    // Change the level, then load the file back.
    await ed.pick("dirt");
    await ed.drag([30, 31, 32].map((x) => [x, 8]));
    await page.keyboard.press("3");
    await ed.clickTile(14, 12);
    expect(await ed.tileAt(14, 12)).toBe(T.EMPTY);

    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-cmd="load"]')]);
    await chooser.setFiles((await dl.path())!);
    await expect(page.locator(".pg-toast").filter({ hasText: "Loaded" })).toBeVisible();
    expect(await levelView(ed)).toEqual(saved);
    // Loading clears the history: nothing to undo into the old level.
    expect(await ed.undoDepth()).toBe(0);
  });

  test("an old Pewter (v1) save is converted on load", async ({ page }) => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-cmd="load"]')]);
    await chooser.setFiles(V1_FILE);
    await expect(page.locator(".pg-toast").filter({ hasText: "converted from an old Pewter save" })).toBeVisible();

    const v = await levelView(ed);
    const at = (x: number, y: number) => v.cells[y * 200 + x];
    expect(at(0, 15)).toBe(T.GRASS);
    expect(at(8, 15)).toBe(T.BLOCK);
    expect(at(9, 15)).toBe(T.QUESTION);
    expect(at(0, 16)).toBe(T.DIRT);
    expect(at(6, 7)).toBe(T.GRASS);
    expect(v.authors[15 * 200 + 8]).toBe(A.PERSON);
    // v1 starts at (6,6); collectables and enemies become entities.
    expect(v.start).toEqual({ x: 6, y: 6 });
    expect(v.entities).toEqual([
      { kind: "coin", x: 3, y: 12 },
      { kind: "fruit", x: 4, y: 12 },
      { kind: "slime", x: 6, y: 14 },
    ]);
  });

  test("a broken file changes nothing", async ({ page }) => {
    await drawSomething(ed);
    const before = await ed.snapshotJson();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-cmd="load"]')]);
    await chooser.setFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from('{"version": 2, "cells": "nope"') });
    await expect(page.locator(".pg-toast-error")).toBeVisible();
    expect(await ed.snapshotJson()).toBe(before);
    // The error toast is expected UI, not a console error.
  });

  test("share code round trip", async ({ page }) => {
    await drawSomething(ed);
    const original = await levelView(ed);

    await page.click('[data-cmd="share"]');
    await page.waitForFunction(() => ((document.querySelector("#pg-share-out") as HTMLTextAreaElement | null)?.value ?? "").startsWith("pg1."));
    const code = await page.locator("#pg-share-out").inputValue();
    expect(code.length).toBeGreaterThan(10);
    await page.keyboard.press("Escape");

    // Change the level, then open the code.
    await ed.pick("dirt");
    await ed.drag([40, 41, 42].map((x) => [x, 6]));
    expect((await levelView(ed)).cells).not.toEqual(original.cells);

    await page.click('[data-cmd="share"]');
    await page.locator("#pg-share-in").fill(code);
    await page.getByRole("button", { name: "Open this level" }).click();
    await expect(page.locator(".pg-toast").filter({ hasText: "Opened the shared level" })).toBeVisible();
    const opened = await levelView(ed);
    expect(opened.cells).toEqual(original.cells);
    expect(opened.entities).toEqual(original.entities);
    expect(opened.start).toEqual(original.start);

    // A damaged code is refused and changes nothing.
    const before = await ed.snapshotJson();
    await page.click('[data-cmd="share"]');
    await page.locator("#pg-share-in").fill("pg1.this-is-not-a-level");
    await page.getByRole("button", { name: "Open this level" }).click();
    await expect(page.locator("#pg-share .pg-share-status.pg-error")).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await ed.snapshotJson()).toBe(before);
  });
});
