/**
 * Serves the real proxy handler (in-memory store) to a page by intercepting
 * its requests, so the replay viewer can be tested without a running proxy.
 */
import type { Page } from "@playwright/test";
import { createHandler } from "../../../proxy/src/handler";
import { StaticTokenStore } from "../../../proxy/src/sessions";
import { MemoryStore, logKey } from "../../../proxy/src/store";
import { FakeUpstream, fakeParse, fakeRender } from "../../../proxy/src/__fixtures__/fakes";
import { scriptedSession } from "../../../apps/editor/src/research/__fixtures__/scriptedSession";

/** The editor's default proxy; /replay signs in to it by itself with the password "dev". */
export const LOCAL = "http://localhost:8787";

const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

export async function serveProxy(page: Page, origin: string, secret: string, extra: Record<string, object[]> = {}) {
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

/** Serve one session log as the local proxy would, and open it in the viewer. */
export async function openLogInViewer(page: Page, events: object[], id = "dev.20990101120000-e2e"): Promise<void> {
  await serveProxy(page, LOCAL, "dev", { [id]: events });
  await page.goto(`./replay/#${id}`);
}
