/**
 * Session replay with a suggestion: the person paints, a ghost appears, they
 * accept it with Tab and undo it. The replay must show the ghost's cells while
 * it was up, apply the accept and the undo exactly, and the viewer must list
 * the suggestion with how long they took to react.
 */
import { expect, test } from "@playwright/test";
import type { ProxyFillBody } from "../../../apps/editor/src/contracts";
import { Replay } from "../../../apps/editor/src/research/replay/replay";
import { A, Editor, T } from "../support/editor";
import { requestHasPlaced, type FillReply } from "../support/proxyMock";

const STEPS: [number, number][] = [
  [12, 14],
  [13, 13],
  [14, 12],
];
/** Level cells of fixtures/finish-staircase.json. */
const FINISH: [number, number][] = [
  [15, 11],
  [16, 10],
  [17, 9],
  [18, 9],
  [19, 9],
  [20, 9],
  [21, 9],
];
const idx = (x: number, y: number, w: number) => y * w + x;

const reply = (b: ProxyFillBody): FillReply =>
  b.request.mode === "auto" && requestHasPlaced(b.request, STEPS) ? { fixture: "finish-staircase" } : { fixture: "decline" };

test("a ghost is shown, accepted and undone, and the replay follows it exactly", async ({ page, browser }, info) => {
  const ed = await Editor.open(page, { proxy: { condition: "llm", fill: reply } });
  await ed.pick("grass");
  for (const [x, y] of STEPS) {
    await ed.clickTile(x, y);
    await page.waitForTimeout(120);
  }
  const g = await ed.waitForGhost();
  await page.waitForTimeout(400);
  await page.mouse.move(500, 250, { steps: 6 }); // the person looks around before deciding
  await page.waitForTimeout(300);
  await page.keyboard.press("Tab");
  expect(await ed.tileAt(15, 11)).toBe(T.GRASS);
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+z"); // undo the accept
  expect(await ed.tileAt(15, 11)).toBe(T.EMPTY);
  await page.waitForTimeout(300);

  const events = await ed.events();
  const replay = new Replay(events);
  expect(replay.skipped).toEqual([]);
  const { w } = replay.stateAt(0).level!;

  // The ghost event carries the proposed cells.
  const show = events.find((e) => e.type === "ghost.show" && e.suggestionId === g.id) as Extract<(typeof events)[number], { type: "ghost.show" }>;
  expect(show.adds!.map(([x, y]) => [x, y])).toEqual(FINISH);

  // While the ghost was up: shown on the stage, not yet in the level.
  const [summary] = replay.ghostSummaries();
  expect(summary).toMatchObject({ id: g.id, kind: "finish", outcome: "accepted" });
  const mid = replay.stateAt(summary.startT + 50);
  expect(mid.ghost?.id).toBe(g.id);
  expect(mid.ghost!.adds.map(([x, y]) => [x, y])).toEqual(FINISH);
  expect(mid.level!.cells[idx(15, 11, w)]).toBe(T.EMPTY);

  // After Tab: Ghost's tiles. After undo: gone again.
  const accepted = replay.stateAt(summary.endT + 10);
  expect(accepted.ghost).toBeNull();
  for (const [x, y] of FINISH) {
    expect(accepted.level!.cells[idx(x, y, w)]).toBe(T.GRASS);
    expect(accepted.level!.authors[idx(x, y, w)]).toBe(A.GHOST);
  }
  const final = replay.stateAt(replay.duration).level!;
  for (const [x, y] of FINISH) expect(final.cells[idx(x, y, w)]).toBe(T.EMPTY);
  const actual = JSON.parse(await ed.snapshotJson()) as { cells: number[]; authors: number[] };
  expect(final.cells).toEqual(actual.cells);
  expect(final.authors).toEqual(actual.authors);

  // Response timing: the pointer moved after the ghost appeared, and they decided within a few seconds.
  expect(summary.firstMoveMs).not.toBeNull();
  expect(summary.firstMoveMs!).toBeGreaterThan(0);
  expect(summary.decisionMs).toBeGreaterThan(summary.firstMoveMs!);

  // The API track has the model call that produced it; the suggestions track has the ghost.
  const tracks = replay.tracks();
  expect(tracks.segments.some((s) => s.track === "api" && s.label.startsWith("fill auto"))).toBe(true);
  expect(tracks.segments.some((s) => s.track === "suggestions" && s.kind === "accepted")).toBe(true);
  expect(tracks.markers.some((m) => m.kind === "ghost-accept")).toBe(true);

  // The viewer lists it and draws the ghost (dashed purple outline pixels) at that moment.
  const viewer = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  const errors: string[] = [];
  viewer.on("pageerror", (e) => errors.push(String(e)));
  await viewer.goto("./replay.html");
  await viewer.setInputFiles('input[type="file"]', {
    name: "ghost.jsonl",
    mimeType: "text/plain",
    buffer: Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"),
  });
  await expect(viewer.locator(".rp-ghost")).toHaveCount(1);
  await expect(viewer.locator(".rp-ghost")).toContainText("accepted");
  await expect(viewer.locator(".rp-ghost")).toContainText("moved after");
  await viewer.locator(".rp-ghost").click(); // jump to when it appeared
  await expect(viewer.locator(".rp-hud")).toContainText("Ghost:");
  const ghostPixels = await viewer.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".rp-stage canvas")!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 90 && d[i] < 130 && d[i + 1] > 60 && d[i + 1] < 85 && d[i + 2] > 220) n++; // rgb(112,72,232)
    return n;
  });
  expect(ghostPixels).toBeGreaterThan(50);
  await viewer.screenshot({ path: info.outputPath("replay-viewer-ghost.png") });
  expect(errors).toEqual([]);
  await viewer.close();
  ed.expectNoErrors();
});
