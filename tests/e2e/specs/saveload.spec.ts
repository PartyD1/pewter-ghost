/**
 * Saving a level (G-08): Save writes a v2 file and logs a save event.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Editor } from "../support/editor";

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
  await ed.pick("question");
  await ed.drag([20, 21].map((x) => [x, 10]));
  await ed.pick("coin");
  await ed.clickTile(15, 10);
}

test.describe("save", () => {
  let ed: Editor;
  test.beforeEach(async ({ page }) => {
    ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  });
  test.afterEach(() => ed.expectNoErrors());

  test("Save writes a v2 file", async ({ page }) => {
    await drawSomething(ed);
    const saved = await levelView(ed);
    expect(saved.entities.some((e) => e.kind === "coin" && e.x === 15 && e.y === 10)).toBe(true);

    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-cmd="save"]')]);
    const file = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(file.version).toBe(2);
    expect(dl.suggestedFilename()).toMatch(/\.json$/);
    expect((await ed.events()).some((e) => e.type === "save")).toBe(true);
  });
});
