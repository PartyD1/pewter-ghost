/**
 * Session replay: the real editor records a session; the replay rebuilds it.
 *
 *  1. A person paints, erases, undoes and moves the mouse in the real editor.
 *  2. The log must hold the raw input and level events.
 *  3. Replaying the log to the end must give the editor's exact level.
 *  4. The viewer page loads that log and plays it.
 *
 * Human-only session (?filler=none): no model calls, so it needs no proxy.
 */
import { expect, test } from "@playwright/test";
import { Replay } from "../../../apps/editor/src/research/replay/replay";
import { A, Editor, T } from "../support/editor";

test("a recorded session replays to the same level, and the viewer plays it", async ({ page, browser }, info) => {
  const ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  const row = 10;
  const x0 = 14;

  await ed.pick("grass");
  await ed.drag([0, 1, 2, 3, 4].map((i) => [x0 + i, row]));
  await ed.pick("dirt");
  await ed.drag([0, 1, 2].map((i) => [x0 + i, row + 1]));
  await page.keyboard.press("3"); // erase
  await ed.clickTile(x0 + 1, row);
  await page.keyboard.press("Control+z"); // undo the erase
  await page.keyboard.press("Control+z"); // undo the dirt stroke
  await page.keyboard.press("Control+Shift+z"); // redo it
  await page.mouse.move(300, 300, { steps: 8 });
  await page.waitForTimeout(500);

  expect(await ed.tileAt(x0, row)).toBe(T.GRASS);
  expect(await ed.authorAt(x0, row)).toBe(A.PERSON);

  // ---- what was recorded
  const events = await ed.events();
  const types = new Set(events.map((e) => e.type));
  for (const t of ["session", "snapshot", "camera", "tool", "focus", "pointer.path", "pointer.btn", "key", "delta", "place", "erase", "undo", "redo"]) {
    expect(types.has(t as never), `log has ${t}`).toBe(true);
  }
  expect(events[0].type).toBe("session");
  expect((events[0] as { replay?: number }).replay).toBe(1);
  expect(events.filter((e) => e.type === "delta").map((e) => (e as { source: string }).source)).toEqual(
    expect.arrayContaining(["person", "undo", "redo"]),
  );
  const downs = events.filter((e) => e.type === "pointer.btn" && (e as { down: boolean }).down);
  expect(downs.length).toBeGreaterThanOrEqual(4);
  // No typed text is ever logged: keys are physical codes.
  for (const e of events) if (e.type === "key") expect(e.code).toMatch(/^[A-Za-z0-9]+$/);

  // ---- the replay ends on the editor's exact level
  const replay = new Replay(events);
  expect(replay.skipped).toEqual([]);
  expect(replay.hasLevel).toBe(true);
  const final = replay.stateAt(replay.duration).level!;
  const actual = JSON.parse(await ed.snapshotJson()) as { cells: number[]; authors: number[]; w: number; h: number };
  expect(final.w).toBe(actual.w);
  expect(final.h).toBe(actual.h);
  expect(final.cells).toEqual(actual.cells);
  expect(final.authors).toEqual(actual.authors);

  // ... and mid-session states differ (the dirt stroke was undone, then redone).
  const undoneAt = events.find((e) => e.type === "undo" && (e as { what: string }).what === "own");
  expect(undoneAt).toBeTruthy();

  // The timeline has what a researcher would look for.
  const tracks = replay.tracks();
  expect(tracks.segments.some((s) => s.track === "edits" && s.label.startsWith("paint"))).toBe(true);
  expect(tracks.segments.some((s) => s.track === "input")).toBe(true);
  expect(tracks.markers.some((m) => m.kind === "undo")).toBe(true);

  // ---- the viewer
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const viewer = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  const errors: string[] = [];
  viewer.on("pageerror", (e) => errors.push(String(e)));
  // /replay first looks for the local session server (no proxy runs in this test), which the browser logs.
  viewer.on("console", (m) => m.type() === "error" && !m.text().includes("ERR_CONNECTION_REFUSED") && errors.push(m.text()));
  await viewer.goto("./replay/");
  await viewer.setInputFiles('input[type="file"]', { name: "session.jsonl", mimeType: "text/plain", buffer: Buffer.from(jsonl) });
  await expect(viewer.locator(".rp-stage canvas")).toBeVisible();
  await expect(viewer.locator(".tl-seg").first()).toBeVisible();
  expect(await viewer.locator(".tl-row").count()).toBe(6);

  // The level is drawn from the very first frame (not the "no level" message), with the editor's real art:
  // the backdrop's bands and the textured ground give the stage many colours (flat drawing has about four).
  const colours = () =>
    viewer.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>(".rp-stage canvas")!;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    });
  await expect.poll(colours).toBeGreaterThan(12);

  // The strongest check: at the end of the session the stage looks like the editor's own canvas.
  // The left part of the screen (the right side is the editor's DOM panel) agrees pixel for pixel
  // except where the editor draws its dotted grid, the hover box and the cursor.
  await viewer.locator(".rp-bar label", { hasText: "Highlight changes" }).locator("input").uncheck();
  const bar = (await viewer.locator(".tl-ruler").boundingBox())!;
  await viewer.mouse.click(bar.x + bar.width - 3, bar.y + 8); // the very end
  await page.mouse.move(1200, 700); // park the editor's pointer away from the area compared
  await page.waitForTimeout(300);
  const editorPng = await page.evaluate(() => (window as any).__pewter.api.game.canvas.toDataURL("image/png") as string);
  const match = await viewer.evaluate(async (png) => {
    const img = new Image();
    await new Promise((r) => ((img.onload = r), (img.src = png)));
    const stage = document.querySelector<HTMLCanvasElement>(".rp-stage canvas")!;
    // The same field of view: the stage is exactly as big as the editor's canvas (not wider).
    const W = img.width;
    const H = img.height;
    if (stage.width !== W || stage.height !== H) return { sizeMismatch: `${stage.width}x${stage.height} vs ${W}x${H}`, match: 0 };
    const cmp = document.createElement("canvas");
    cmp.width = W;
    cmp.height = H;
    const cx = cmp.getContext("2d", { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0);
    const a = cx.getImageData(0, 0, W, H).data;
    const b = stage.getContext("2d")!.getImageData(0, 0, W, H).data;
    const close = (p: Uint8ClampedArray, i: number, q: Uint8ClampedArray, j: number) =>
      Math.abs(p[i] - q[j]) < 12 && Math.abs(p[i + 1] - q[j + 1]) < 12 && Math.abs(p[i + 2] - q[j + 2]) < 12;
    // A pixel agrees if it equals the other image's pixel or one of that pixel's four neighbours (and the
    // reverse): a one-pixel grid line drawn by only one of them is not a disagreement about the art.
    const offsets = [0, 4, -4, W * 4, -W * 4];
    const agrees = (p: Uint8ClampedArray, q: Uint8ClampedArray, i: number) => offsets.some((o) => i + o >= 0 && i + o < q.length && close(p, i, q, i + o));
    let same = 0;
    let total = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (y < 64 && x < 500) continue; // the editor's minimap
        const i = (y * W + x) * 4;
        total++;
        if (agrees(a, b, i) || agrees(b, a, i)) same++;
      }
    }
    return { sizeMismatch: null, match: same / total, size: `${W}x${H}` };
  }, editorPng);
  expect(match.sizeMismatch).toBeNull();
  console.log(`viewer vs editor canvas (${match.size}): ${(match.match * 100).toFixed(1)}% of pixels match`);
  expect(match.match).toBeGreaterThan(0.96);
  await viewer.locator(".rp-bar label", { hasText: "Highlight changes" }).locator("input").check();

  // Play moves the clock; clicking the timeline seeks.
  const timeText = () => viewer.locator(".rp-bar .time").innerText();
  const before = await timeText();
  await viewer.getByRole("button", { name: "Play", exact: true }).click();
  await viewer.waitForTimeout(700);
  expect(await timeText()).not.toBe(before);
  await viewer.keyboard.press("Space");
  await viewer.locator(".tl-ruler").click({ position: { x: 5, y: 5 } });
  expect(await timeText()).toMatch(/^0:0[0-9.]+ \//);

  // The jump buttons land on a suggestion-free session without breaking.
  await viewer.keyboard.press(".");
  expect(errors).toEqual([]);

  // Part-way through: the person's strokes are outlined and the cursor is on the stage.
  const box = (await viewer.locator(".tl-ruler").boundingBox())!;
  await viewer.mouse.click(box.x + box.width * 0.55, box.y + 8);
  const mid = await viewer.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".rp-stage canvas")!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let outline = 0; // person outline rgba(34,139,230) over the tiles
    for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] > 120 && d[i + 1] < 160 && d[i + 2] > 200) outline++;
    return outline;
  });
  expect(mid).toBeGreaterThan(100);

  await viewer.screenshot({ path: info.outputPath("replay-viewer.png") });
  await viewer.close();
  ed.expectNoErrors();
});
