import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProxyFillResponse, Recording } from "../../../apps/editor/src/contracts";
import { createHandler } from "../handler";
import { StaticTokenStore } from "../sessions";
import { FakeUpstream, GOOD_ANSWER, fakeParse, fakeRender, sampleRequest } from "../__fixtures__/fakes";
import { FileStore } from "./fileStore";
import { startServer } from "./nodeAdapter";
import type http from "node:http";

describe("node adapter (dev server shape)", () => {
  let server: http.Server;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "pg-dev-"));
    const handler = createHandler({
      render: fakeRender,
      parse: fakeParse,
      upstream: new FakeUpstream(),
      store: new FileStore(dir),
      tokens: new StaticTokenStore({ tokens: {} }, true),
    });
    server = await startServer(handler, 0, "127.0.0.1");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("serves /health and CORS preflight over real HTTP", async () => {
    const h = await fetch(`${base}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true });
    const pre = await fetch(`${base}/fill`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("session -> fill -> log round trip writes .data files", async () => {
    const s = (await (await fetch(`${base}/session?token=dev`)).json()) as { sessionId: string };
    expect(s.sessionId).toMatch(/^dev\./);
    const res = await fetch(`${base}/fill`, {
      method: "POST",
      headers: { Authorization: "Bearer dev", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: s.sessionId, request: sampleRequest() }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProxyFillResponse).answer).toEqual(GOOD_ANSWER);
    const rec = JSON.parse((await readFile(path.join(dir, "recordings", `${s.sessionId}.jsonl`), "utf8")).trim()) as Recording;
    expect(rec.answer).toEqual(GOOD_ANSWER);

    const lr = await fetch(`${base}/log`, {
      method: "POST",
      headers: { Authorization: "Bearer dev" },
      body: JSON.stringify({ sessionId: s.sessionId, events: [{ type: "play.start", t: 5 }] }),
    });
    expect(lr.status).toBe(200);
    expect(await readFile(path.join(dir, "logs", `${s.sessionId}.jsonl`), "utf8")).toBe('{"type":"play.start","t":5}\n');
  });

  it("refuses without a token over HTTP", async () => {
    const res = await fetch(`${base}/fill`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});
