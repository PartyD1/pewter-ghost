/**
 * The viewer reading a session from the proxy's read API with the lab password.
 *
 * The real proxy handler (in-memory store) answers the viewer's requests, so
 * this covers the contract between them: headers, the password check, CORS,
 * the session list, the log, and a link that lands on a given moment.
 */
import { expect, test, type Page } from "@playwright/test";
import { createHandler } from "../../../proxy/src/handler";
import { StaticTokenStore } from "../../../proxy/src/sessions";
import { MemoryStore, logKey } from "../../../proxy/src/store";
import { FakeUpstream, fakeParse, fakeRender } from "../../../proxy/src/__fixtures__/fakes";
import { scriptedSession } from "../../../apps/editor/src/research/__fixtures__/scriptedSession";

const API = "http://proxy.test";
const SECRET = "lab-secret";

async function serveProxy(page: Page) {
  const store = new MemoryStore();
  await store.append(logKey("p01"), scriptedSession("p01").map((e) => JSON.stringify(e)).join("\n") + "\n");
  await store.append(logKey("p02"), scriptedSession("p02").map((e) => JSON.stringify(e)).join("\n") + "\n");
  const handler = createHandler({
    render: fakeRender,
    parse: fakeParse,
    upstream: new FakeUpstream(),
    store,
    tokens: new StaticTokenStore({ tokens: {} }, false),
    readSecret: SECRET,
  });
  const seen: { method: string; path: string }[] = [];
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    seen.push({ method: req.method(), path: new URL(req.url()).pathname });
    const res = await handler(new Request(req.url(), { method: req.method(), headers: req.headers() }));
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
  });
  return seen;
}

test("password, session list, log and a link to a moment", async ({ page }) => {
  const seen = await serveProxy(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`./replay.html?api=${encodeURIComponent(API)}`);
  const pw = page.locator('input[type="password"]');

  // Wrong password: a clear message, nothing listed.
  await pw.fill("not-the-password");
  await page.getByRole("button", { name: "Show sessions" }).click();
  await expect(page.locator(".rp-err")).toContainText("not accepted");
  await expect(page.locator(".rp-list button")).toHaveCount(0);

  // Right password: both sessions are listed.
  await pw.fill(SECRET);
  await page.getByRole("button", { name: "Show sessions" }).click();
  await expect(page.locator(".rp-list button")).toHaveCount(2);
  expect(seen.some((s) => s.path === "/replay/sessions")).toBe(true);

  // Open one: the timeline and the suggestion list (with reaction times) appear.
  await page.locator(".rp-list button", { hasText: "p01" }).click();
  await expect(page.locator(".tl-seg").first()).toBeVisible();
  await expect(page.locator(".rp-ghost")).toHaveCount(3);
  await expect(page.locator(".rp-ghost").first()).toContainText("continue ledge");
  await expect(page.locator(".rp-ghost").first()).toContainText("accepted");
  await expect(page.locator(".rp-ghost").first()).toContainText("decided in");
  await expect(page.locator(".rp-side")).toContainText("p01");

  // Clicking a suggestion jumps the playhead to when it appeared (1.95 s).
  await page.locator(".rp-ghost").nth(1).click(); // shown at 5.8 s
  await expect(page.locator(".rp-bar .time")).toHaveText(/^0:05\.8 \//);

  // The API track holds the fill calls; clicking one selects it.
  await expect(page.locator(".tl-api .tl-seg").first()).toBeVisible();
  await page.locator(".tl-api .tl-seg").nth(1).click();
  await expect(page.locator(".rp-side .rp-kv").nth(1)).toContainText("API calls");

  // A link to a moment: the password is remembered for the tab, so it opens straight in.
  await page.goto(`./replay.html?api=${encodeURIComponent(API)}#p02@9500`);
  await expect(page.locator(".rp-bar .time")).toHaveText(/^0:09\.5 \//);
  await expect(page.locator(".rp-side")).toContainText("p02");

  // "Copy link" is available for a server session.
  await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("an unknown session says so and returns to the start screen", async ({ page }) => {
  await serveProxy(page);
  await page.goto(`./replay.html?api=${encodeURIComponent(API)}`);
  await page.evaluate((s) => sessionStorage.setItem("pewter-ghost.replay.password", s), SECRET);
  await page.goto(`./replay.html?api=${encodeURIComponent(API)}#nope`);
  await expect(page.locator(".rp-err")).toContainText("no such session");
});

test("a server with reading switched off explains why", async ({ page }) => {
  await page.route(`${API}/**`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "off" }) }));
  await page.goto(`./replay.html?api=${encodeURIComponent(API)}`);
  await page.locator('input[type="password"]').fill("x");
  await page.getByRole("button", { name: "Show sessions" }).click();
  await expect(page.locator(".rp-err")).toContainText("not enabled");
});
