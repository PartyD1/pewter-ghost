/**
 * Ghost layer check (G-11, G-19, G-24 rendering, Extend scroll): drives the
 * real editor in Chromium.
 *
 *   node apps/editor/src/ghost/__e2e__/ghostCheck.cjs [docs/screens/ghost.png]
 *
 * Starts its own Vite dev server on port 5198 (killed by PID at the end),
 * loads the ghost (src/ghost/boot.ts) if main.ts does not start it yet, and
 * checks with hand-made verified suggestions through window.__pewter.ghost:
 *   show → faint tiles + caption + status strip; screenshot;
 *   Tab → tiles applied with author GHOST, focus did not move, route drawn; Ctrl+Z restores;
 *   Esc dismisses; painting a ghost cell keeps that cell; painting elsewhere ends it "partial";
 *   Ctrl+Space shows "asked" and Esc cancels;
 *   Fix: removals crossed out, Tab applies both, undo restores the level exactly; screenshot;
 *   Extend: the camera brings the first third into view; edge arrow when it reaches past the screen;
 *   Play: R shows the route for the current section.
 * Exits non-zero on failure.
 */
/* eslint-disable */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../../../../..");
const PORT = 5198;
const URL0 = `http://localhost:${PORT}/`;
const shot = path.resolve(ROOT, process.argv[2] || "docs/screens/ghost.png");

function loadPlaywright() {
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
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

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`ok - ${msg}`);
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(0);
    });
  });
}

async function startServer() {
  const child = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (child.exitCode !== null) throw new Error(`vite exited early:\n${out}`);
    if ((await get(URL0)) === 200) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite did not start on ${PORT}:\n${out}`);
}

function killServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM"); // the whole group (npx → vite)
  } catch {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
  }
}

/** A hand-made verified suggestion (the brand the verifier would set). */
function sugg(id, over) {
  const adds = over.adds || [];
  const first = adds[0] || (over.removes || [])[0] || (over.entities || [])[0] || { x: 0, y: 0 };
  return {
    id,
    kind: "finish",
    adds: [],
    removes: [],
    entities: [],
    confidence: 0.9,
    label: "staircase",
    anchor: { x: first.x, y: first.y },
    requestHash: `e2e-${id}`,
    filler: "stub",
    latencyMs: 0,
    mode: "auto",
    verified: true,
    __verified: true,
    attempts: 1,
    ...over,
  };
}

(async () => {
  let server;
  let browser;
  const errors = [];
  try {
    server = await startServer();
    console.log(`vite pid ${server.pid} on ${URL0}`);
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));

    // filler=stub turns the ghost UI on; the fill loop is then suspended so only
    // this script's hand-made suggestions reach the manager (see session.ts).
    await page.goto(URL0 + "?fresh=1&dev=1&filler=stub", { waitUntil: "load" });
    await page.waitForFunction(() => !!(window.__pewter && window.__pewter.api), null, { timeout: 30000 });
    await page.evaluate(async () => {
      const app = window.__pewter.app;
      if (!app) return;
      await app.ready;
      app.loop.setSuspended(true);
    });
    const started = await page.evaluate(() => !!window.__pewter.ghost);
    if (!started) await page.addScriptTag({ type: "module", content: 'import "/src/ghost/boot.ts";' });
    await page.waitForFunction(() => !!(window.__pewter && window.__pewter.ghost), null, { timeout: 15000 });
    assert(true, started ? "ghost started by main.ts" : "ghost started via src/ghost/boot.ts");
    await page.waitForTimeout(200);

    // The editor starts on the old Pewter default map (full ground floor).
    // This check needs open air between two 12-tile platforms, as in
    // tests/e2e/support/editor.ts useTwoPlatformStarter: empty every column
    // between them, all cells template (author NONE), history cleared.
    await page.evaluate((platform) => {
      const m = window.__pewter.model;
      const s = m.snapshot();
      const keep = (x) => x < platform || x >= s.w - platform;
      for (let y = 0; y < s.h; y++)
        for (let x = 0; x < s.w; x++) {
          const i = y * s.w + x;
          if (!keep(x)) s.cells[i] = 0;
          s.authors[i] = 0;
        }
      s.provenance = {};
      s.entities = s.entities.filter((e) => keep(e.x));
      for (const id of Object.keys(s.entityAuthors)) if (!s.entities.some((e) => e.id === id)) delete s.entityAuthors[id];
      m.load(s);
    }, 12);

    const G = (fn, arg) => page.evaluate(fn, arg);
    const tileAt = (x, y) => G(([x, y]) => window.__pewter.model.tileAt(x, y), [x, y]);
    const authorAt = (x, y) => G(([x, y]) => window.__pewter.model.authorAt(x, y), [x, y]);
    const strip = () => G(() => window.__pewter.ghost.strip());
    const layer = () => G(() => window.__pewter.ghost.layer());
    const show = (s) => G((s) => window.__pewter.ghost.show(s), s);
    const screenOf = (x, y) =>
      G(
        ([x, y]) => {
          const api = window.__pewter.api;
          const p = api.camera.tileToScreen(x + 0.5, y + 0.5);
          const r = api.game.canvas.getBoundingClientRect();
          return { x: r.left + (p.x * r.width) / api.game.scale.width, y: r.top + (p.y * r.height) / api.game.scale.height };
        },
        [x, y],
      );
    // The editor's opening view panned right by 8 columns: the old panel floats
    // over the canvas from x 925 (tile 25.7 at zoom 2.25), and this check
    // clicks columns up to 30 (tests/e2e/support/editor.ts home does the same).
    const home = () =>
      G(() => {
        const cam = window.__pewter.scene.camera;
        cam.home(window.__pewter.model.start);
        cam.panByScreen(8 * 16 * cam.zoom, 0);
      });
    await home();

    assert((await strip()).main === "quiet · Ctrl+Space to ask", "status strip mounted in #ghost-status, quiet");
    assert(await page.locator("#ghost-status #pg-ghost-strip").isVisible(), "strip visible under the toolbar");
    assert(await page.locator("#pg-ghost-dev").isVisible(), "?dev=1 shows the dev overlay");

    // ---- Show a Finish ghost off the start platform -------------------------
    const stair = sugg("g-stair", {
      label: "staircase",
      levelGuess: "parkour",
      adds: [
        { x: 12, y: 15, tile: 6 },
        { x: 13, y: 15, tile: 6 },
        { x: 14, y: 15, tile: 6 },
        { x: 15, y: 15, tile: 6 },
        { x: 14, y: 14, tile: 1 },
        { x: 15, y: 14, tile: 1 },
        { x: 15, y: 13, tile: 1 },
      ],
      entities: [{ kind: "coin", x: 13, y: 12 }],
      path: [
        { x: 2, y: 14 },
        { x: 13, y: 14 },
        { x: 14, y: 13 },
        { x: 15, y: 12 },
      ],
    });
    for (const a of stair.adds) assert((await tileAt(a.x, a.y)) === 0, `(${a.x},${a.y}) empty before`);
    let r = await show(stair);
    assert(r.status === "shown", `ghost shown (${JSON.stringify(r)})`);
    await page.waitForTimeout(250);
    let L = await layer();
    assert(L.visible && L.adds === 7 && L.entities === 1 && L.outlineRuns > 0, `layer draws 7 faint tiles, 1 sprite and a dashed outline (${JSON.stringify(L)})`);
    assert(L.alpha === 1, "fade-in finished (120 ms)");
    assert(L.caption === "staircase · Tab", `canvas caption near the anchor ("${L.caption}")`);
    assert(await page.locator(".pg-ghost-caption").isVisible(), "caption element visible");
    let st = await strip();
    assert(/^ghost: staircase · /.test(st.main) && /Tab keeps them/.test(st.main), `first-ghost teaching line ("${st.main}")`);
    assert(st.guess === "Ghost thinks: parkour", `level guess shown ("${st.guess}")`);
    assert(!/stub|llm|algo|jev/i.test(await page.locator("#ghost-status").innerText()), "strip never names the filler");
    assert((await tileAt(12, 15)) === 0, "showing does not change the level");
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot });
    console.log(`screenshot -> ${shot}`);

    // ---- Tab accepts; focus does not move -----------------------------------
    await page.focus('[data-cmd="play"]');
    const focusBefore = await G(() => document.activeElement && document.activeElement.getAttribute("data-cmd"));
    await page.keyboard.press("Tab");
    const focusAfter = await G(() => document.activeElement && document.activeElement.getAttribute("data-cmd"));
    assert(focusBefore === "play" && focusAfter === "play", "Tab did not move browser focus");
    for (const a of stair.adds) {
      assert((await tileAt(a.x, a.y)) === a.tile && (await authorAt(a.x, a.y)) === 2, `(${a.x},${a.y}) applied with author GHOST`);
    }
    const coin = await G(() => {
      const m = window.__pewter.model;
      const e = m.entitiesAt(13, 12)[0];
      return e ? { kind: e.kind, author: m.entityAuthor(e.id) } : null;
    });
    assert(coin && coin.kind === "coin" && coin.author === 2, "ghost coin placed with author GHOST");
    assert((await G(() => window.__pewter.model.provenanceAt(12, 15))) === "g-stair", "provenance = suggestion id");
    assert((await G(() => window.__pewter.ghost.current())) === null, "ghost gone after Tab");
    assert((await G(() => window.__pewter.ghost.route().length)) >= 2, "agent route drawn on accept");
    await page.waitForTimeout(2300);
    assert((await G(() => window.__pewter.ghost.route().length)) === 0, "route gone after 2 s");
    assert((await G(() => window.__pewter.model.undoDepth)) === 1, "one accept = one undo step");

    // ---- Undo restores ---------------------------------------------------------
    await page.keyboard.press("Control+z");
    for (const a of stair.adds) assert((await tileAt(a.x, a.y)) === 0, `undo cleared (${a.x},${a.y})`);
    assert((await G(() => window.__pewter.model.entitiesAt(13, 12).length)) === 0, "undo removed the ghost coin");

    // ---- Esc dismisses -----------------------------------------------------------
    const ledge = (id) =>
      sugg(id, {
        label: "ledge",
        adds: [20, 21, 22, 23].map((x) => ({ x, y: 12, tile: 6 })),
      });
    r = await show(ledge("g-esc"));
    assert(r.status === "shown", "second ghost shown");
    await page.keyboard.press("Escape");
    assert((await G(() => window.__pewter.ghost.current())) === null, "Esc dismissed it");
    await page.waitForTimeout(200);
    assert(!(await layer()).visible && (await layer()).leaving === 0, "dismissed ghost faded out");
    assert((await tileAt(21, 12)) === 0, "Esc applied nothing");

    // ---- Painting on a ghost cell keeps that cell; painting elsewhere ends it --------
    r = await show(ledge("g-part"));
    assert(r.status === "shown", "third ghost shown");
    assert(/Tab keeps them/.test((await strip()).main), "third ghost still carries the teaching line");
    await page.click('[data-item="grass"]');
    let p = await screenOf(21, 12);
    await page.mouse.click(p.x, p.y);
    assert((await tileAt(21, 12)) === 6 && (await authorAt(21, 12)) === 1, "painted cell is the person's");
    let cur = await G(() => window.__pewter.ghost.current());
    assert(cur && cur.remaining.length === 3, "ghost stays with 3 cells left (partial accept)");
    assert((await layer()).adds === 3, "layer stops drawing the painted cell");
    assert(/3 of 4 left/.test((await strip()).main), "strip counts cells left");
    p = await screenOf(30, 6);
    await page.mouse.click(p.x, p.y);
    assert((await G(() => window.__pewter.ghost.current())) === null, "painting elsewhere dismissed it");
    let hist = await G(() => window.__pewter.ghost.history());
    assert(hist.outcomes.partial === 1 && hist.outcomes.esc === 1 && hist.outcomes.accepted === 1, `history: ${JSON.stringify(hist.outcomes)}`);
    await page.keyboard.press("1"); // back to Select

    // ---- After three ghosts the strip uses the short line --------------------------
    r = await show(sugg("g-short", { label: "pillar", adds: [{ x: 26, y: 10, tile: 1 }] }));
    st = await strip();
    assert(st.main === "ghost: pillar · Tab to accept · Esc to dismiss", `4th ghost: short line ("${st.main}")`);
    assert((await layer()).caption === "pillar", "4th ghost: short canvas caption");
    await page.keyboard.press("Escape");

    // ---- Ctrl+Space ----------------------------------------------------------------------
    await page.keyboard.press("Control+Space");
    assert(/^asked/.test((await strip()).main), "Ctrl+Space: strip says asked");
    await page.keyboard.press("Escape");
    assert((await strip()).main === "quiet · Ctrl+Space to ask", "Esc cancels the request");

    // ---- Fix: removals crossed out, one undo restores exactly --------------------------
    const before = await G(() => JSON.stringify(window.__pewter.model.snapshot()));
    const fix = sugg("g-fix", {
      kind: "fix",
      label: "gap 9 · knight clears 6",
      removes: [
        { x: 9, y: 15 },
        { x: 10, y: 15 },
      ],
      adds: [{ x: 9, y: 12, tile: 1 }, { x: 10, y: 12, tile: 1 }],
      anchor: { x: 9, y: 15 },
    });
    r = await show(fix);
    assert(r.status === "shown", `fix shown (${JSON.stringify(r)})`);
    await page.waitForTimeout(200);
    L = await layer();
    assert(L.kind === "fix" && L.removes === 2 && L.adds === 2, "fix draws 2 crossed-out removals and 2 faint adds");
    assert((await tileAt(9, 15)) === 6, "removal not applied before Tab");
    await page.screenshot({ path: shot.replace(/\.png$/, "-fix.png") });
    await page.keyboard.press("Tab");
    assert((await tileAt(9, 15)) === 0 && (await tileAt(10, 15)) === 0, "Tab removed the crossed-out tiles");
    assert((await tileAt(9, 12)) === 1 && (await authorAt(9, 12)) === 2, "and added the fix tiles");
    await page.keyboard.press("Control+z");
    const after = await G(() => JSON.stringify(window.__pewter.model.snapshot()));
    assert(after === before, "one undo restores the level exactly");

    // ---- Extend: camera brings the first third into view; edge arrow -------------------
    await home();
    await page.waitForTimeout(100);
    const view0 = await G(() => window.__pewter.api.camera.viewTiles());
    const ex0 = Math.ceil(view0.x + view0.w) + 6;
    const ext = sugg("g-ext", {
      kind: "extend",
      label: "pit and landing",
      adds: Array.from({ length: 36 }, (_, i) => ({ x: ex0 + i, y: 15, tile: 6 })),
      anchor: { x: ex0, y: 15 },
    });
    r = await show(ext);
    assert(r.status === "shown", "extend ghost shown");
    await page.waitForTimeout(900);
    const view1 = await G(() => window.__pewter.api.camera.viewTiles());
    assert(view1.x > view0.x, `camera nudged right (${view0.x.toFixed(1)} -> ${view1.x.toFixed(1)})`);
    assert(view1.x <= ex0 && view1.x + view1.w >= ex0 + 12, "first third of the extend ghost is on screen");
    L = await layer();
    assert(L.arrow && L.arrow.side === "right", `edge arrow points at the rest (${JSON.stringify(L.arrow)})`);
    assert(await page.locator(".pg-ghost-arrow").isVisible(), "edge arrow visible");
    await page.screenshot({ path: shot.replace(/\.png$/, "-extend.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    assert(!(await page.locator(".pg-ghost-arrow").isVisible()), "arrow gone with the ghost");

    // ---- Play: R shows the route for the current section --------------------------------
    await home();
    r = await show(
      sugg("g-run", {
        label: "runway",
        adds: [
          { x: 12, y: 15, tile: 6 },
          { x: 13, y: 15, tile: 6 },
        ],
        path: [
          { x: 2, y: 14 },
          { x: 13, y: 14 },
        ],
      }),
    );
    assert(r.status === "shown", "route ghost shown");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(2300);
    await page.keyboard.press("p");
    await page.waitForTimeout(400);
    assert(await G(() => window.__pewter.api.isPlaying()), "Play started");
    assert(/R shows the checked route/.test((await strip()).main), "strip names the route key in Play");
    await page.keyboard.press("r");
    assert((await G(() => window.__pewter.ghost.route().length)) >= 2, "R shows the route in Play");
    await page.screenshot({ path: shot.replace(/\.png$/, "-route.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    assert(!(await G(() => window.__pewter.api.isPlaying())), "Esc still stops Play");
    assert((await G(() => window.__pewter.ghost.route().length)) === 0, "route hidden after Play");

    const real = errors.filter((e) => !/favicon/i.test(e));
    assert(real.length === 0, `no console errors${real.length ? `: ${real.join(" | ")}` : ""}`);
    console.log("ghost check passed");
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    if (errors.length) console.error("console errors:", errors.join("\n"));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    killServer(server);
  }
})();
