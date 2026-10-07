/**
 * Ghost keys through the whole loop (G-11, G-17, G-19): a replayed model
 * answer goes through the verifier and the manager onto the canvas, then
 * Tab / Esc / Ctrl+Space / painting decide what happens to it.
 *
 * The person paints three grass steps up from the start platform; the
 * recorded answer (fixtures/finish-staircase.json) finishes the climb.
 */
import { expect, test } from "@playwright/test";
import type { ProxyFillBody } from "../../../apps/editor/src/contracts";
import { A, Editor, T, type GhostCurrentLite } from "../support/editor";
import type { FillReply } from "../support/proxyMock";

const STEPS: [number, number][] = [
  [12, 14],
  [13, 13],
  [14, 12],
];
/** Level cells of fixtures/finish-staircase.json. */
const FINISH = [
  [15, 11],
  [16, 10],
  [17, 9],
  [18, 9],
  [19, 9],
  [20, 9],
  [21, 9],
];

/** Which modes get the finish answer; everything else is declined. */
let answerModes: Set<string>;
const reply = (b: ProxyFillBody): FillReply | null =>
  answerModes.has(b.request.mode) ? { fixture: "finish-staircase" } : { fixture: "decline" };

async function paintSteps(ed: Editor): Promise<void> {
  await ed.pick("grass");
  for (const [x, y] of STEPS) {
    await ed.clickTile(x, y);
    await ed.page.waitForTimeout(120);
  }
  for (const [x, y] of STEPS) expect(await ed.tileAt(x, y)).toBe(T.GRASS);
}

async function finishGhost(ed: Editor): Promise<GhostCurrentLite> {
  const g = await ed.waitForGhost();
  expect(g.kind).toBe("finish");
  expect(g.filler).toBe("llm");
  expect(g.adds.map((a) => [a.x, a.y])).toEqual(FINISH);
  for (const [x, y] of FINISH) expect(await ed.tileAt(x, y)).toBe(T.EMPTY);
  await expect.poll(async () => (await ed.layer()).adds).toBe(FINISH.length);
  expect((await ed.layer()).visible).toBe(true);
  return g;
}

test.describe("ghost keys", () => {
  let ed: Editor;
  test.beforeEach(async ({ page }) => {
    answerModes = new Set(["auto", "requested"]);
    ed = await Editor.open(page, { proxy: { condition: "llm", fill: reply } });
  });
  test.afterEach(() => ed.expectNoErrors());

  test("Tab accepts the whole ghost as Ghost's tiles; one undo takes it back", async ({ page }) => {
    await paintSteps(ed);
    const g = await finishGhost(ed);
    expect(g.shownBecause).toBe("now");
    const strip = await ed.strip();
    expect(strip?.main).toMatch(/^ghost: staircase up to a ledge/);
    expect(strip?.guess).toBe("Ghost thinks: climbing");

    answerModes.clear();
    const depth = await ed.undoDepth();
    await page.keyboard.press("Tab");
    for (const [x, y] of FINISH) {
      expect(await ed.tileAt(x, y)).toBe(T.GRASS);
      expect(await ed.authorAt(x, y)).toBe(A.GHOST);
    }
    expect(await ed.ghost()).toBeNull();
    expect(await ed.undoDepth()).toBe(depth + 1);
    expect(await page.evaluate((x) => (window as any).__pewter.model.provenanceAt(x, 11), 15)).toBe(g.id);

    const ev = await ed.events();
    expect(ev.find((e) => e.type === "ghost.show" && e.suggestionId === g.id)).toMatchObject({ kind: "finish", shownBecause: "now", cells: 7 });
    expect(ev.find((e) => e.type === "ghost.end" && e.suggestionId === g.id)).toMatchObject({ outcome: "accepted" });

    await page.keyboard.press("Control+z");
    for (const [x, y] of FINISH) expect(await ed.tileAt(x, y)).toBe(T.EMPTY);
    for (const [x, y] of STEPS) expect(await ed.tileAt(x, y)).toBe(T.GRASS);
    expect((await ed.events()).some((e) => e.type === "undo" && e.what === "ghost")).toBe(true);
  });

  test("Esc dismisses and applies nothing", async ({ page }) => {
    await paintSteps(ed);
    const g = await finishGhost(ed);
    answerModes.clear();
    const before = await ed.snapshotJson();
    await page.keyboard.press("Escape");
    expect(await ed.ghost()).toBeNull();
    await expect.poll(async () => (await ed.layer()).visible).toBe(false);
    expect(await ed.snapshotJson()).toBe(before);
    expect((await ed.events()).find((e) => e.type === "ghost.end" && e.suggestionId === g.id)).toMatchObject({ outcome: "esc" });
    expect((await ed.strip())?.main).toBe("quiet · Ctrl+Space to ask");
  });

  test("Ctrl+Space asks now and shows the answer as requested", async ({ page }) => {
    answerModes = new Set(["requested"]);
    await paintSteps(ed);
    // The speculative calls are all declined: nothing shows.
    await expect.poll(() => ed.proxy!.fills.filter((c) => c.repliedAt !== null).length).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(600);
    expect(await ed.ghost()).toBeNull();

    await page.keyboard.press("Control+Space");
    const g = await finishGhost(ed);
    expect(g.shownBecause).toBe("requested");
    expect(g.mode).toBe("requested");
    const asked = ed.proxy!.fills.filter((c) => c.body.request.mode === "requested");
    expect(asked).toHaveLength(1);
    expect((await ed.fillCalls()).some((c) => c.mode === "requested" && c.verdictStage === "ok")).toBe(true);

    // Ctrl+Space then Esc with nothing coming back cancels the request.
    answerModes.clear();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Space");
    await expect.poll(async () => (await ed.strip())?.main ?? "").toMatch(/^asked/);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await ed.strip())?.main).toBe("quiet · Ctrl+Space to ask");
  });

  test("painting a ghost cell keeps that cell; drawing elsewhere dismisses the rest", async ({ page }) => {
    await paintSteps(ed);
    const g = await finishGhost(ed);
    answerModes.clear();

    // Paint the first ghost cell with what the ghost proposes: partial accept, the ghost stays.
    await ed.clickTile(15, 11);
    expect(await ed.tileAt(15, 11)).toBe(T.GRASS);
    expect(await ed.authorAt(15, 11)).toBe(A.PERSON);
    const cur = await ed.ghost();
    expect(cur?.id).toBe(g.id);
    expect(cur?.remaining).toBe(FINISH.length - 1);
    await expect.poll(async () => (await ed.layer()).adds).toBe(FINISH.length - 1);
    expect((await ed.strip())?.main).toMatch(/6 of 7 left/);

    // Paint somewhere else: the ghost ends, the remaining cells are not applied.
    await ed.clickTile(26, 6);
    expect(await ed.ghost()).toBeNull();
    for (const [x, y] of FINISH.slice(1)) expect(await ed.tileAt(x, y)).toBe(T.EMPTY);
    const end = (await ed.events()).find((e) => e.type === "ghost.end" && e.suggestionId === g.id);
    expect(end).toMatchObject({ outcome: "partial", acceptedCells: 1 });
  });
});
