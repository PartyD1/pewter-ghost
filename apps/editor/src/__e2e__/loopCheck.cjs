/**
 * Whole-loop check: drives the real editor in Chromium through
 * placements → fill → verify → manager → ghost → Tab → undo.
 *
 *   node apps/editor/src/__e2e__/loopCheck.cjs                 # StubFiller (?filler=stub)
 *   node apps/editor/src/__e2e__/loopCheck.cjs --llm           # LLM via a proxy already running on :8787
 *        [--token dev] [--timeout 6000] [--shot docs/screens/loop-llm.png]
 *
 * Starts its own Vite dev server on port 5199 (killed by process group at the
 * end). Stub mode asserts; LLM mode reports what happened (a live model may
 * decline or fail verification) and fails only on page errors or a broken log.
 * Exits non-zero on failure.
 */
/* eslint-disable */
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../../../..");
const PORT = 5199;
const URL0 = `http://localhost:${PORT}/`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LLM = flag("--llm");
const shot = path.resolve(ROOT, opt("--shot", LLM ? "docs/screens/loop-llm.png" : "docs/screens/loop-stub.png"));

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

let failures = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`ok - ${msg}`);
}
function note(msg) {
  console.log(`# ${msg}`);
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
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
  }
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

    const query = LLM
      ? `?fresh=1&dev=1&filler=llm&token=${encodeURIComponent(opt("--token", "dev"))}&callTimeoutMs=${opt("--timeout", "6000")}`
      : "?fresh=1&dev=1&filler=stub";
    await page.goto(URL0 + query, { waitUntil: "load" });
    await page.waitForFunction(() => !!(window.__pewter && window.__pewter.api && window.__pewter.ghost && window.__pewter.app), null, {
      timeout: 30000,
    });
    await page.evaluate(() => window.__pewter.app.ready);
    const G = (fn, arg) => page.evaluate(fn, arg);
    const info = await G(() => {
      const a = window.__pewter.app;
      return { filler: a.loop.activeFiller, fromProxy: a.session.fromProxy, sessionId: a.session.sessionId, error: a.session.error || null };
    });
    note(`session ${JSON.stringify(info)}`);
    assert(info.filler === (LLM ? "llm" : "stub"), `active filler is ${LLM ? "llm" : "stub"} (main.ts started the loop)`);
    assert(!/stub|llm|algo|jev/i.test(await page.locator("#ghost-status").innerText()), "status strip never names the filler");

    const tileAt = (x, y) => G(([x, y]) => window.__pewter.model.tileAt(x, y), [x, y]);
    const authorAt = (x, y) => G(([x, y]) => window.__pewter.model.authorAt(x, y), [x, y]);
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
    // The camera eases (home, Extend nudges): wait until the view stops moving.
    const settle = async () => {
      let prev = "";
      for (let i = 0; i < 40; i++) {
        const v = JSON.stringify(
          await G(() => {
            const api = window.__pewter.api;
            const r = api.game.canvas.getBoundingClientRect();
            return [api.camera.viewTiles(), r.top, r.left, r.width, r.height, api.game.scale.width, api.game.scale.height];
          }),
        );
        if (v === prev) return;
        prev = v;
        await page.waitForTimeout(120);
      }
    };
    const click = async (x, y) => {
      await settle();
      let p = await screenOf(x, y);
      await page.mouse.move(p.x, p.y, { steps: 4 });
      await page.waitForTimeout(60);
      if (process.env.LOOP_DEBUG) note(`click (${x},${y}) at ${JSON.stringify(p)} -> tile under it ${JSON.stringify(await G(([sx, sy]) => { const api = window.__pewter.api; const r = api.game.canvas.getBoundingClientRect(); return api.camera.screenToTile(((sx - r.left) * api.game.scale.width) / r.width, ((sy - r.top) * api.game.scale.height) / r.height); }, [p.x, p.y]))}`);
      p = await screenOf(x, y);
      await page.mouse.click(p.x, p.y);
    };
    const drag = async (cells) => {
      await settle();
      const ps = [];
      for (const [x, y] of cells) ps.push(await screenOf(x, y));
      await page.mouse.move(ps[0].x, ps[0].y);
      await page.mouse.down();
      for (const p of ps.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 });
      await page.mouse.up();
    };
    const events = () => G(() => window.__pewter.app.eventLog.events());
    await G(() => window.__pewter.scene.camera.home(window.__pewter.model.start));
    await page.click('[data-item="grass"]');

    if (!LLM) {
      // ---- Three stair steps, one click each, with a little thinking time --------
      const steps = [
        [12, 14],
        [13, 13],
        [14, 12],
      ];
      for (const [x, y] of steps) {
        await click(x, y);
        await page.waitForTimeout(150);
      }
      if (process.env.LOOP_DEBUG)
        note(JSON.stringify(await G(() => ({ mode: window.__pewter.modes.mode, view: window.__pewter.api.camera.viewTiles(), t: window.__pewter.model.tileAt(12, 14), ev: window.__pewter.app.eventLog.events().filter((e) => e.type === "place").map((e) => [e.x, e.y, e.tile]) }))));
      for (const [x, y] of steps) assert((await tileAt(x, y)) === 6 && (await authorAt(x, y)) === 1, `person painted (${x},${y})`);
      const t0 = Date.now();
      await page.waitForFunction(() => !!window.__pewter.ghost.current(), null, { timeout: 10000 });
      note(`ghost appeared ${Date.now() - t0} ms after the third step`);
      const cur = await G(() => window.__pewter.ghost.current());
      const s = cur.suggestion;
      assert(s.verified === true && s.__verified === true, "the ghost is a VerifiedSuggestion");
      assert(s.filler === "stub" && s.kind === "extend", `stub extend "${s.label}"`);
      assert(Array.isArray(s.path) && s.path.length >= 2, `agent route attached (${s.path.length} points)`);
      const adds = s.adds.map((a) => `${a.x},${a.y}`).join(" ");
      assert(adds === "15,11 16,10 17,9", `continues the staircase (${adds})`);
      for (const a of s.adds) assert((await tileAt(a.x, a.y)) === 0, `(${a.x},${a.y}) still empty while the ghost shows`);
      await page.waitForTimeout(300);
      const L = await G(() => window.__pewter.ghost.layer());
      assert(L.visible && L.adds === 3, `ghost layer draws 3 faint tiles (${JSON.stringify({ adds: L.adds, caption: L.caption })})`);
      const ev0 = await events();
      const ok = ev0.filter((e) => e.type === "fill.call" && e.verdictStage === "ok");
      assert(ok.length >= 1 && ok[ok.length - 1].requestHash === s.requestHash, "fill.call logged with verdict ok and the request hash");
      assert(ev0.some((e) => e.type === "ghost.show" && e.suggestionId === s.id), "ghost.show logged");
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot });
      console.log(`screenshot -> ${shot}`);

      // ---- Tab accepts ---------------------------------------------------------
      await page.keyboard.press("Tab");
      for (const a of s.adds) assert((await tileAt(a.x, a.y)) === a.tile && (await authorAt(a.x, a.y)) === 2, `Tab applied (${a.x},${a.y}) as GHOST`);
      assert((await G(() => window.__pewter.ghost.current())) === null, "ghost gone after Tab");
      const ev1 = await events();
      assert(ev1.some((e) => e.type === "ghost.end" && e.suggestionId === s.id && e.outcome === "accepted"), "ghost.end accepted logged");

      // ---- Undo ---------------------------------------------------------------
      await page.keyboard.press("Control+z");
      for (const a of s.adds) assert((await tileAt(a.x, a.y)) === 0, `undo cleared (${a.x},${a.y})`);
      for (const [x, y] of steps) assert((await tileAt(x, y)) === 6, `undo kept the person's step (${x},${y})`);
      const ev2 = await events();
      assert(ev2.some((e) => e.type === "undo" && e.what === "ghost"), "undo logged as 'ghost'");
      assert(ev2[0].type === "session" && ev2[0].filler === "stub", "first log event is the session");
      const types = [...new Set(ev2.map((e) => e.type))].sort();
      note(`log event types: ${types.join(", ")}`);
      assert(ev2.filter((e) => e.type === "place").length >= 3, "place events logged");
    } else {
      // ---- LLM: a staircase, then a platform with a gap ------------------------
      const report = [];
      const watch = async (label, waitMs) => {
        const before = (await events()).length;
        const t0 = Date.now();
        let shown = null;
        while (Date.now() - t0 < waitMs) {
          const c = await G(() => window.__pewter.ghost.current());
          if (c) {
            shown = c;
            break;
          }
          await page.waitForTimeout(100);
        }
        const evs = (await events()).slice(before);
        const calls = evs.filter((e) => e.type === "fill.call");
        const r = {
          label,
          ghostShown: !!shown,
          ghost: shown
            ? { label: shown.suggestion.label, kind: shown.suggestion.kind, confidence: shown.suggestion.confidence, cells: shown.remaining.length, because: shown.shownBecause, attempts: shown.suggestion.attempts }
            : null,
          waitedMs: Date.now() - t0,
          calls: calls.map((c) => ({ mode: c.mode, superseded: c.superseded, latencyMs: Math.round(c.latencyMs), act: c.act, kind: c.kind, confidence: c.confidence, verdict: c.verdictStage, reason: c.reason, sendBack: c.sendBack, error: c.error })),
          patrol: evs.filter((e) => e.type === "patrol"),
        };
        report.push(r);
        console.log(JSON.stringify(r, null, 2));
        return shown;
      };
      for (const [x, y] of [
        [12, 14],
        [13, 13],
        [14, 12],
        [15, 11],
      ]) {
        await click(x, y);
        await page.waitForTimeout(250);
      }
      const first = await watch("staircase", 20000);
      if (first) {
        fs.mkdirSync(path.dirname(shot), { recursive: true });
        await page.screenshot({ path: shot.replace(/\.png$/, "-stair.png") });
        await page.keyboard.press("Escape");
      }
      // A platform after a 4-tile gap, a little higher.
      await drag([19, 20, 21, 22, 23, 24].map((x) => [x, 11]));
      const second = await watch("platform after a gap", 25000);
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot });
      console.log(`screenshot -> ${shot}`);
      if (second) {
        await page.keyboard.press("Tab");
        await page.waitForTimeout(200);
        note(`Tab accepted: ${JSON.stringify(await G(() => window.__pewter.ghost.history()))}`);
      }
      const all = await events();
      assert(all[0].type === "session" && all[0].filler === "llm", "first log event is the session (filler llm)");
      assert(all.some((e) => e.type === "fill.call"), "fill.call events logged");
      fs.writeFileSync(path.resolve(ROOT, "docs/screens/loop-llm.json"), JSON.stringify(report, null, 2) + "\n");
      note("report -> docs/screens/loop-llm.json");
    }

    const bad = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED/.test(e));
    if (bad.length) console.log(`page errors:\n  ${bad.join("\n  ")}`);
    assert(bad.length === 0, "no page errors");
  } catch (e) {
    failures++;
    console.error(String(e && e.stack ? e.stack : e));
    if (errors.length) console.error(`page errors:\n  ${errors.join("\n  ")}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    killServer(server);
  }
  process.exit(failures ? 1 : 0);
})();
