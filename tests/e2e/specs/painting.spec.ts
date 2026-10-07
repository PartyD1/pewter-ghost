/**
 * Painting (G-04): strokes, tool modes, strokes stop over the UI, undo / redo.
 * Human-only session (?filler=none): no calls, no ghosts.
 */
import { expect, test } from "@playwright/test";
import { A, Editor, T } from "../support/editor";

test.describe("painting", () => {
  let ed: Editor;
  const row = 10;
  const x0 = 14;

  test.beforeEach(async ({ page }) => {
    ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  });

  test.afterEach(() => ed.expectNoErrors());

  test("a stroke paints every cell it crosses and is one undo step", async ({ page }) => {
    expect(await ed.mode()).toBe("select");
    await ed.pick("grass");
    expect(await ed.mode()).toBe("paint");
    await ed.drag([0, 1, 2, 3, 4, 5, 6].map((i) => [x0 + i, row]));
    for (let x = x0; x <= x0 + 6; x++) {
      expect(await ed.tileAt(x, row)).toBe(T.GRASS);
      expect(await ed.authorAt(x, row)).toBe(A.PERSON);
    }
    expect(await ed.undoDepth()).toBe(1);
    const places = (await ed.events()).filter((e) => e.type === "place");
    expect(places).toHaveLength(7);
    expect(new Set(places.map((e) => (e as { stroke: string }).stroke)).size).toBe(1);

    // Select mode never paints.
    await page.keyboard.press("1");
    expect(await ed.mode()).toBe("select");
    await ed.clickTile(x0, row - 2);
    expect(await ed.tileAt(x0, row - 2)).toBe(T.EMPTY);
  });

  test("modes: keys and toolbar switch Select / Paint / Erase; right-click is not an eraser", async ({ page }) => {
    await ed.pick("dirt");
    await ed.drag([0, 1, 2, 3].map((i) => [x0 + i, row]));
    expect(await ed.tileAt(x0 + 3, row)).toBe(T.DIRT);

    await ed.clickTile(x0 + 1, row, { button: "right" });
    expect(await ed.tileAt(x0 + 1, row)).toBe(T.DIRT);

    await page.keyboard.press("3");
    expect(await ed.mode()).toBe("erase");
    await ed.clickTile(x0 + 3, row);
    expect(await ed.tileAt(x0 + 3, row)).toBe(T.EMPTY);
    expect((await ed.events()).some((e) => e.type === "erase")).toBe(true);

    await page.click('[data-mode="paint"]');
    expect(await ed.mode()).toBe("paint");
    await ed.clickTile(x0 + 3, row);
    expect(await ed.tileAt(x0 + 3, row)).toBe(T.DIRT);

    await page.click('[data-mode="select"]');
    expect(await ed.mode()).toBe("select");
    await page.keyboard.press("2");
    expect(await ed.mode()).toBe("paint");
  });

  test("painting over the UI does nothing; a stroke that crosses the palette stops", async ({ page }) => {
    await ed.pick("block");
    const before = await ed.snapshotJson();
    // Clicks on DOM chrome (palette, toolbar) never reach the canvas.
    await page.click('[data-item="dirt"]');
    await page.click('[data-item="block"]');
    await page.click(".pg-brand");
    await page.click('[data-mode="paint"]');
    expect(await ed.snapshotJson()).toBe(before);
    expect(await ed.undoDepth()).toBe(0);

    const p = await ed.screenOf(x0, row - 3);
    const pal = (await page.locator('[data-item="coin"]').boundingBox())!;
    const back = await ed.screenOf(x0 + 3, row - 3);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(pal.x + pal.width / 2, pal.y + pal.height / 2, { steps: 4 });
    await page.mouse.move(back.x, back.y, { steps: 4 });
    await page.mouse.up();
    expect(await ed.tileAt(x0, row - 3)).toBe(T.BLOCK);
    expect(await ed.tileAt(x0 + 3, row - 3)).toBe(T.EMPTY);
  });

  test("undo and redo by keys and toolbar, one stroke at a time", async ({ page }) => {
    await ed.pick("grass");
    await ed.drag([0, 1, 2].map((i) => [x0 + i, row]));
    const afterOne = await ed.snapshotJson();
    await ed.pick("dirt");
    await ed.drag([0, 1, 2].map((i) => [x0 + i, row + 2]));
    const afterTwo = await ed.snapshotJson();
    expect(await ed.undoDepth()).toBe(2);

    await page.keyboard.press("Control+z");
    expect(await ed.snapshotJson()).toBe(afterOne);
    await page.keyboard.press("Control+Shift+z");
    expect(await ed.snapshotJson()).toBe(afterTwo);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
    expect(await ed.snapshotJson()).toBe(afterTwo);

    await page.click('[data-cmd="undo"]');
    expect(await ed.snapshotJson()).toBe(afterOne);
    await page.click('[data-cmd="undo"]');
    expect(await ed.tileAt(x0, row)).toBe(T.EMPTY);
    await expect(page.locator('[data-cmd="undo"]')).toBeDisabled();
    await page.click('[data-cmd="redo"]');
    await page.click('[data-cmd="redo"]');
    expect(await ed.snapshotJson()).toBe(afterTwo);

    const ev = await ed.events();
    expect(ev.filter((e) => e.type === "undo").length).toBe(4);
    expect(ev.filter((e) => e.type === "redo").length).toBe(4);
    expect(ev.filter((e) => e.type === "undo").every((e) => (e as { what: string }).what === "own")).toBe(true);
  });
});
