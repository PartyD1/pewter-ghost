/**
 * The viewer reading sessions from the proxy's read API.
 *
 * The real proxy handler (in-memory store) answers the viewer's requests, so
 * this covers the contract between them: headers, the password check, CORS,
 * the session list, the log, and a link that lands on a given moment.
 *
 *  - A remote server (not this machine): the person types the lab password.
 *  - The local server (http://localhost:8787, the editor's default): /replay
 *    signs in by itself and lists the newest sessions.
 */
import { expect, test, type Page } from "@playwright/test";
import { createHandler } from "../../../proxy/src/handler";
import { StaticTokenStore } from "../../../proxy/src/sessions";
import { MemoryStore, logKey } from "../../../proxy/src/store";
import { FakeUpstream, fakeParse, fakeRender } from "../../../proxy/src/__fixtures__/fakes";
import { scriptedSession } from "../../../apps/editor/src/research/__fixtures__/scriptedSession";

const REMOTE = "http://proxy.test";
const LOCAL = "http://localhost:8787";
const SECRET = "lab-secret";

const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

async function serveProxy(page: Page, origin: string, secret: string, extra: Record<string, object[]> = {}) {
  const store = new MemoryStore();
  await store.append(logKey("p01"), jsonl(scriptedSession("p01")));
  await store.append(logKey("p02"), jsonl(scriptedSession("p02")));
  for (const [id, events] of Object.entries(extra)) await store.append(logKey(id), jsonl(events));
  const handler = createHandler({
    render: fakeRender,
    parse: fakeParse,
    upstream: new FakeUpstream(),
    store,
    tokens: new StaticTokenStore({ tokens: {} }, false),
    readSecret: secret,
    // The viewer is served from 127.0.0.1:<port>; allow it like the real localhost default does.
    allowOrigin: () => true,
  });
  const seen: { method: string; path: string; auth: string | null }[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const req = route.request();
    seen.push({ method: req.method(), path: new URL(req.url()).pathname, auth: req.headers()["authorization"] ?? null });
    const res = await handler(new Request(req.url(), { method: req.method(), headers: req.headers() }));
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
  });
  return seen;
}

test("remote server: password, session list, log and a link to a moment", async ({ page }) => {
  const seen = await serveProxy(page, REMOTE, SECRET);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`./replay/?api=${encodeURIComponent(REMOTE)}`);
  const pw = page.locator('input[type="password"]');
  // Not this machine, so it asks for the password and sends nothing until it has one.
  await expect(pw).toBeVisible();
  expect(seen).toEqual([]);

  // Wrong password: a clear message, nothing listed.
  await pw.fill("not-the-password");
  await page.getByRole("button", { name: "Show sessions" }).click();
  await expect(page.locator(".rp-err")).toContainText("not accepted");
  await expect(page.locator(".rp-session, .rp-latest")).toHaveCount(0);

  // Right password: the newest session is the big button, the other is in the list.
  await page.locator('input[type="password"]').fill(SECRET);
  await page.getByRole("button", { name: "Show sessions" }).click();
  await expect(page.locator(".rp-latest")).toContainText("Watch the latest session");
  await expect(page.locator(".rp-latest")).toContainText("p02");
  await expect(page.locator(".rp-session")).toHaveCount(1);
  await expect(page.locator(".rp-session")).toContainText("p01");
  await expect(page.locator(".rp-session")).toContainText("21 s");
  expect(seen.some((s) => s.path === "/replay/sessions" && s.auth === `Bearer ${SECRET}`)).toBe(true);

  // Open one: the timeline and the suggestion list (with reaction times) appear.
  await page.locator(".rp-session", { hasText: "p01" }).click();
  await expect(page.locator(".tl-seg").first()).toBeVisible();
  await expect(page.locator(".rp-ghost")).toHaveCount(3);
  await expect(page.locator(".rp-ghost").first()).toContainText("continue ledge");
  await expect(page.locator(".rp-ghost").first()).toContainText("accepted");
  await expect(page.locator(".rp-ghost").first()).toContainText("decided in");
  await expect(page.locator(".rp-side")).toContainText("p01");

  // Clicking a suggestion jumps the playhead to when it appeared.
  await page.locator(".rp-ghost").nth(1).click(); // shown at 5.8 s
  await expect(page.locator(".rp-bar .time")).toHaveText(/^0:05\.8 \//);

  // The API track holds the fill calls; clicking one selects it.
  await expect(page.locator(".tl-api .tl-seg").first()).toBeVisible();
  await page.locator(".tl-api .tl-seg").nth(1).click();
  await expect(page.locator(".rp-side .rp-kv").nth(1)).toContainText("API calls");

  // A link to a moment: the password is remembered for the tab, so it opens straight in.
  await page.goto(`./replay/?api=${encodeURIComponent(REMOTE)}#p02@9500`);
  await expect(page.locator(".rp-bar .time")).toHaveText(/^0:09\.5 \//);
  await expect(page.locator(".rp-side")).toContainText("p02");

  // "Copy link" is available for a server session.
  await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("local server: /replay needs no login, newest session first, old and empty ones tucked away", async ({ page }) => {
  // A dev session from today with replay data, one from before replay existed, and one empty page load.
  const today = Date.UTC(2099, 0, 1, 12, 0, 0);
  const seen = await serveProxy(page, LOCAL, "dev", {
    "dev.20990101120000-newest": [
      { type: "session", t: 100, sessionId: "dev.20990101120000-newest", commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "none", config: {}, replay: 1, startedAt: today },
      ...scriptedSession("x").slice(1),
    ],
    "dev.20261008011131-old": [
      { type: "session", t: 286, sessionId: "dev.20261008011131-old", commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "llm", config: {} },
      { type: "patrol", t: 3296, beatable: true, ms: 8 },
    ],
    "dev.20990101115900-blip": [{ type: "session", t: 5, sessionId: "dev.20990101115900-blip", commit: "x", promptVersion: "p", briefVersion: "b", model: "m", filler: "none", config: {} }],
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // The clean address, with no ?api= and no password typed.
  await page.goto("./replay");
  await expect(page).toHaveURL(/\/replay\/?$/);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator(".rp-latest")).toContainText("Watch the latest session");
  // Named by when it happened, not by the made-up id.
  await expect(page.locator(".rp-latest")).toContainText("2099");
  await expect(page.locator(".rp-latest")).not.toContainText("dev.2099");
  expect(seen[0]).toMatchObject({ path: "/replay/sessions", auth: "Bearer dev" });

  // The two without replay data are hidden until asked for.
  await expect(page.locator(".rp-session:visible")).toHaveCount(2); // p01 and p02 (scripted, watchable)
  const toggle = page.getByRole("button", { name: /Show 2 older or empty sessions/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator(".rp-session.muted")).toHaveCount(2);
  await expect(page.locator(".rp-session.muted").first()).toContainText("nothing to replay");

  // One click opens the newest.
  await page.locator(".rp-latest").click();
  await expect(page.locator(".tl-seg").first()).toBeVisible();
  await expect(page.locator(".rp-side")).toContainText("dev.20990101120000-newest");
  expect(errors).toEqual([]);
});

test("local server not running: says what to do instead of showing nothing", async ({ page }) => {
  await page.route(`${LOCAL}/**`, (route) => route.abort("connectionrefused"));
  await page.goto("./replay");
  await expect(page.locator(".rp-card")).toContainText("Can't load sessions");
  await expect(page.locator(".rp-card")).toContainText("npm run dev");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("an unknown session says so and shows the list again", async ({ page }) => {
  await serveProxy(page, REMOTE, SECRET);
  await page.goto(`./replay/?api=${encodeURIComponent(REMOTE)}`);
  await page.evaluate((s) => sessionStorage.setItem("pewter-ghost.replay.password", s), SECRET);
  await page.goto(`./replay/?api=${encodeURIComponent(REMOTE)}#nope`);
  await expect(page.locator(".rp-err")).toContainText("no such session");
  await expect(page.locator(".rp-latest")).toBeVisible();
});

test("a server with reading switched off explains why", async ({ page }) => {
  await page.route(`${REMOTE}/**`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "off" }) }));
  await page.goto(`./replay/?api=${encodeURIComponent(REMOTE)}`);
  await page.locator('input[type="password"]').fill("x");
  await page.getByRole("button", { name: "Show sessions" }).click();
  await expect(page.locator(".rp-err")).toContainText("not enabled");
});
