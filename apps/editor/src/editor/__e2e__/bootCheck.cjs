/**
 * Boot check for the editor shell (G-01/G-03/G-04): drives the real app in
 * Chromium. Start a dev server first, then:
 *
 *   node apps/editor/src/editor/__e2e__/bootCheck.cjs http://localhost:5199/ docs/screens/editor.png
 *
 * Checks: boots without console errors; paints with mouse strokes (one undo
 * step per stroke); a stroke stops when the pointer goes over DOM UI;
 * right-click does nothing; Select mode does not paint; undo/redo keys;
 * Play starts and stops; Save task autosaves. Writes a screenshot.
 * Exits non-zero on failure.
 */
/* eslint-disable */
const fs = require("node:fs");
const path = require("node:path");

function loadPlaywright() {
  const candidates = ["playwright", "/opt/node22/lib/node_modules/playwright"];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {}
  }
  throw new Error("playwright not found");
}

function findChromium() {
  const base = "/opt/pw-browsers";
  if (!fs.existsSync(base)) return undefined;
  for (const d of fs.readdirSync(base).sort().reverse()) {
    if (!/^chromium-\d+$/.test(d)) continue;
    const p = path.join(base, d, "chrome-linux", "chrome");
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const url = process.argv[2] || "http://localhost:5199/";
const shot = process.argv[3] || "docs/screens/editor.png";

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`ok - ${msg}`);
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(url + (url.includes("?") ? "&" : "?") + "fresh=1", { waitUntil: "load" });
    await page.waitForFunction(() => !!(window.__pewter && window.__pewter.api), null, { timeout: 20000 });
    await page.waitForTimeout(300);

    const canvasBox = await page.locator("#pg-stage canvas").boundingBox();
    assert(canvasBox && canvasBox.width > 300 && canvasBox.height > 200, "canvas fills the stage");

    const screenOf = (x, y) =>
      page.evaluate(
        ([x, y]) => {
          const api = window.__pewter.api;
          const p = api.camera.tileToScreen(x + 0.5, y + 0.5);
          const r = api.game.canvas.getBoundingClientRect();
          const sx = r.width / api.game.scale.width;
          const sy = r.height / api.game.scale.height;
          return { x: r.left + p.x * sx, y: r.top + p.y * sy };
        },
        [x, y],
      );
    const tileAt = (x, y) => page.evaluate(([x, y]) => window.__pewter.model.tileAt(x, y), [x, y]);
    const view = await page.evaluate(() => window.__pewter.api.camera.viewTiles());
    const x0 = Math.ceil(view.x) + 6;
    const row = 11;
    assert(view.w > 14, `view shows ${view.w.toFixed(1)} tiles across`);

    // Select mode is the default: clicking does not paint.
    let p = await screenOf(x0, row);
    await page.mouse.click(p.x, p.y);
    assert((await tileAt(x0, row)) === 0, "Select mode click does not paint");

    // Choosing a palette block switches to Paint.
    await page.click('[data-item="grass"]');
    assert((await page.evaluate(() => window.__pewter.modes.mode)) === "paint", "palette pick switches to Paint");

    // Stroke 1: a fast drag along a row.
    p = await screenOf(x0, row);
    const q = await screenOf(x0 + 6, row);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 2 });
    await page.mouse.up();
    for (let x = x0; x <= x0 + 6; x++) assert((await tileAt(x, row)) === 6, `stroke painted (${x},${row})`);
    assert((await page.evaluate(() => window.__pewter.model.undoDepth)) === 1, "one stroke = one undo step");

    // Stroke 2 with dirt, two rows down.
    await page.keyboard.press("2");
    await page.click('[data-item="dirt"]');
    p = await screenOf(x0, row + 2);
    const q2 = await screenOf(x0 + 3, row + 2);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q2.x, q2.y, { steps: 4 });
    await page.mouse.up();
    assert((await tileAt(x0 + 3, row + 2)) === 5, "second stroke painted dirt");

    // Undo removes only stroke 2; redo brings it back; undo again.
    await page.keyboard.press("Control+z");
    assert((await tileAt(x0 + 3, row + 2)) === 0 && (await tileAt(x0 + 3, row)) === 6, "Ctrl+Z undid the last stroke only");
    await page.keyboard.press("Control+Shift+z");
    assert((await tileAt(x0 + 3, row + 2)) === 5, "Ctrl+Shift+Z redid it");
    await page.keyboard.press("Control+z");

    // A stroke stops when the pointer goes over DOM UI (the palette) and comes back.
    p = await screenOf(x0 + 8, row - 3);
    const pal = await page.locator('[data-item="coin"]').boundingBox();
    const back = await screenOf(x0 + 10, row - 3);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(pal.x + pal.width / 2, pal.y + pal.height / 2, { steps: 3 });
    await page.mouse.move(back.x, back.y, { steps: 3 });
    await page.mouse.up();
    assert((await tileAt(x0 + 8, row - 3)) === 5, "stroke painted where it started");
    assert((await tileAt(x0 + 10, row - 3)) === 0, "stroke ended over the palette and did not resume");

    // Right-click never paints or erases.
    p = await screenOf(x0 + 1, row);
    await page.mouse.click(p.x, p.y, { button: "right" });
    assert((await tileAt(x0 + 1, row)) === 6, "right-click is not an eraser");

    // Erase mode (3) erases.
    await page.keyboard.press("3");
    assert((await page.evaluate(() => window.__pewter.modes.mode)) === "erase", "key 3 = Erase");
    p = await screenOf(x0 + 6, row);
    await page.mouse.click(p.x, p.y);
    assert((await tileAt(x0 + 6, row)) === 0, "Erase mode erased a tile");

    // nudgeTo never moves the camera during a stroke; it runs once the stroke ends.
    await page.click('[data-item="grass"]');
    p = await screenOf(x0 + 2, row - 5);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const before = await page.evaluate(() => window.__pewter.scene.camera.centerPx);
    await page.evaluate(() => window.__pewter.api.camera.nudgeTo(150, 10));
    await page.waitForTimeout(600);
    const during = await page.evaluate(() => window.__pewter.scene.camera.centerPx);
    assert(during.x === before.x && during.y === before.y, "camera holds still during a stroke");
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.__pewter.scene.camera.centerPx);
    assert(after.x > before.x + 100, `nudge ran after the stroke (${before.x.toFixed(0)} -> ${after.x.toFixed(0)})`);
    await page.evaluate(() => window.__pewter.scene.camera.home(window.__pewter.model.start));
    await page.keyboard.press("Control+z");

    // Put a coin and a slime down so Play has entities.
    await page.click('[data-item="coin"]');
    p = await screenOf(x0 + 2, row - 1);
    await page.mouse.click(p.x, p.y);
    const ents = await page.evaluate(() => window.__pewter.model.entities.map((e) => e.kind));
    assert(ents.includes("coin") && ents.includes("flag"), "coin placed; starter flag present");
    await page.keyboard.press("1");

    await page.screenshot({ path: shot });
    console.log(`screenshot -> ${shot}`);

    // Play mode.
    await page.keyboard.press("p");
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => window.__pewter.api.isPlaying()), "P starts Play");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(700);
    await page.keyboard.up("ArrowRight");
    const kx = await page.evaluate(() => window.__pewter.scene.play.knightSprite.x);
    const startPx = await page.evaluate(() => window.__pewter.model.start.x * 16 + 8);
    assert(kx > startPx + 32, `knight ran right (${startPx} -> ${kx.toFixed(0)})`);
    await page.screenshot({ path: shot.replace(/\.png$/, "-play.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert(!(await page.evaluate(() => window.__pewter.api.isPlaying())), "Esc stops Play");
    assert((await tileAt(x0, row)) === 6, "level unchanged by Play");

    // Autosave reaches localStorage.
    await page.waitForTimeout(1300);
    const saved = await page.evaluate(() => localStorage.getItem("pewter-ghost:autosave"));
    assert(saved && JSON.parse(saved).version === 2, "autosave v2 in localStorage");

    // Help overlay opens and closes.
    await page.click('[data-cmd="help"]');
    assert(await page.locator("#pg-help").isVisible(), "help overlay opens");
    const helpText = await page.locator("#pg-help").innerText();
    assert(/Tab/.test(helpText) && /Ctrl \+ Space/.test(helpText), "help lists Tab and Ctrl+Space");
    await page.keyboard.press("Escape");

    // Play with enemies; run off the start platform to die; deaths are counted.
    await page.evaluate(() => {
      const m = window.__pewter.model;
      m.placeEntity("slime", 9, 14);
      m.placeEntity("ultraslime", 194, 14);
      window.__pewterEnds = [];
      window.__pewter.api.on("play:end", (r) => window.__pewterEnds.push(r));
    });
    const patrol = await page.evaluate(() => window.__pewter.model.entities.find((e) => e.kind === "slime").patrol);
    assert(Array.isArray(patrol) && patrol[0] === 0 && patrol[1] === 11, `slime patrol span from the model ${JSON.stringify(patrol)}`);
    await page.keyboard.press("p");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(2500);
    await page.keyboard.up("ArrowRight");
    const deaths = await page.evaluate(() => window.__pewter.scene.play.stats.deaths);
    assert(deaths >= 1, `falling off counts a death (${deaths})`);
    await page.keyboard.press("q");
    await page.waitForTimeout(100);
    let ends = await page.evaluate(() => window.__pewterEnds);
    assert(ends.length === 1 && ends[0].reachedGoal === false && ends[0].deaths === deaths, "play.end reports deaths, no goal");

    // Reaching the flag ends Play.
    await page.evaluate(() => {
      const m = window.__pewter.model;
      const flag = m.entities.find((e) => e.kind === "flag");
      m.removeEntity(flag.id);
      m.placeEntity("flag", m.start.x + 5, m.start.y);
    });
    await page.keyboard.press("p");
    await page.keyboard.down("ArrowRight");
    await page.waitForFunction(() => window.__pewterEnds.length === 2, null, { timeout: 5000 });
    await page.keyboard.up("ArrowRight");
    ends = await page.evaluate(() => window.__pewterEnds);
    assert(ends[1].reachedGoal === true, "touching the flag ends Play with reachedGoal");
    assert(!(await page.evaluate(() => window.__pewter.api.isPlaying())), "editor is back after the goal");

    // Play settings dialog changes a stored setting.
    await page.click('[data-cmd="settings"]');
    await page.locator('input[data-setting="gravityScale"]').fill("1.25");
    await page.keyboard.press("Escape");
    assert((await page.evaluate(() => window.__pewter.settings.get().gravityScale)) === 1.25, "gravity setting stored");

    // Save task downloads a v2 file carrying the settings.
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-cmd="save"]')]);
    const file = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
    assert(file.version === 2 && file.playSettings && file.playSettings.gravityScale === 1.25, `Save task file ${dl.suggestedFilename()}`);

    // Share code dialog produces a code.
    await page.click('[data-cmd="share"]');
    await page.waitForFunction(() => (document.querySelector("#pg-share-out") || {}).value?.startsWith("pg1."), null, { timeout: 5000 });
    await page.keyboard.press("Escape");
    assert(true, "share code generated");

    assert(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
    console.log("BOOT CHECK PASSED");
    await browser.close();
  } catch (err) {
    console.error(String(err && err.stack ? err.stack : err));
    if (errors.length) console.error("console errors:", errors);
    try {
      await page.screenshot({ path: shot.replace(/\.png$/, "-failure.png") });
    } catch {}
    await browser.close();
    process.exit(1);
  }
})();
