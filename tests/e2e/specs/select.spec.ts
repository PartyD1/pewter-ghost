/**
 * Select tool: drag a box, move it, Alt-drag to copy, Delete, copy / paste, undo.
 * Human-only session (?filler=none): no calls, no ghosts.
 */
import { expect, test } from "@playwright/test";
import { Editor, T } from "../support/editor";

test.describe("select tool", () => {
  let ed: Editor;
  const row = 10;
  const x0 = 14;

  test.beforeEach(async ({ page }) => {
    ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
    // Three grass tiles with a dirt tile under the first, in open sky.
    await ed.pick("grass");
    await ed.drag([0, 1, 2].map((i) => [x0 + i, row]));
    await ed.pick("dirt");
    await ed.clickTile(x0, row + 1);
    await page.keyboard.press("1");
  });

  test.afterEach(() => ed.expectNoErrors());

  /** Box-select (x0-1, row-1) to (x0+3, row+2) and return the model's undo depth before any edit. */
  async function selectBlock(): Promise<number> {
    const depth = await ed.undoDepth();
    await ed.drag([
      [x0 - 1, row - 1],
      [x0 + 3, row + 2],
    ]);
    return depth;
  }

  test("dragging a box selects without changing the level", async () => {
    const depth = await selectBlock();
    expect(await ed.undoDepth()).toBe(depth);
    expect(await ed.page.evaluate(() => (window as any).__pewter.scene.selection.rect)).toEqual({ x: x0 - 1, y: row - 1, w: 5, h: 4 });
  });

  test("dragging inside the box moves everything as one undo step", async () => {
    const depth = await selectBlock();
    await ed.drag([
      [x0, row],
      [x0 + 8, row - 3],
    ]);
    expect(await ed.tileAt(x0, row)).toBe(T.EMPTY);
    expect(await ed.tileAt(x0 + 8, row - 3)).toBe(T.GRASS);
    expect(await ed.tileAt(x0 + 10, row - 3)).toBe(T.GRASS);
    expect(await ed.tileAt(x0 + 8, row - 2)).toBe(T.DIRT);
    expect(await ed.undoDepth()).toBe(depth + 1);
    await ed.page.keyboard.press("Control+z");
    expect(await ed.tileAt(x0, row)).toBe(T.GRASS);
    expect(await ed.tileAt(x0 + 8, row - 3)).toBe(T.EMPTY);
  });

  test("Alt-drag copies and leaves the original", async ({ page }) => {
    await selectBlock();
    await page.keyboard.down("Alt");
    await ed.drag([
      [x0, row],
      [x0 + 8, row],
    ]);
    await page.keyboard.up("Alt");
    expect(await ed.tileAt(x0, row)).toBe(T.GRASS);
    expect(await ed.tileAt(x0 + 8, row)).toBe(T.GRASS);
    expect(await ed.tileAt(x0 + 8, row + 1)).toBe(T.DIRT);
  });

  test("Delete clears the box, and undo brings it back", async ({ page }) => {
    await selectBlock();
    await page.keyboard.press("Delete");
    for (let i = 0; i < 3; i++) expect(await ed.tileAt(x0 + i, row)).toBe(T.EMPTY);
    expect(await ed.tileAt(x0, row + 1)).toBe(T.EMPTY);
    await page.keyboard.press("Control+z");
    expect(await ed.tileAt(x0 + 2, row)).toBe(T.GRASS);
    expect(await ed.tileAt(x0, row + 1)).toBe(T.DIRT);
  });

  test("copy and paste puts the block down at the pointer", async ({ page }) => {
    await selectBlock();
    await page.keyboard.press("Control+c");
    const p = await ed.screenOf(x0 + 8, row - 3);
    await page.mouse.move(p.x, p.y, { steps: 2 });
    await page.keyboard.press("Control+v");
    // The box's top-left is (x0-1, row-1), so grass (x0, row) lands one right and down of the pointer.
    expect(await ed.tileAt(x0 + 9, row - 2)).toBe(T.GRASS);
    expect(await ed.tileAt(x0, row)).toBe(T.GRASS);
  });

  test("switching to Paint drops the box", async ({ page }) => {
    await selectBlock();
    await page.keyboard.press("2");
    expect(await page.evaluate(() => (window as any).__pewter.scene.selection.rect)).toBeNull();
  });
});
