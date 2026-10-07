/**
 * The proxy, replayed. Intercepts the three proxy endpoints the editor talks to
 * (GET /session, POST /fill, POST /log) with page.route, so no model, key or
 * proxy process is involved:
 *
 *  - /session answers with the condition and overrides a spec chooses (G-33).
 *  - /fill answers with a recorded ProxyFillResponse fixture (fixtures/*.json),
 *    after a configurable delay. Fixture answers are in window coordinates, as
 *    the model wrote them; each fixture carries the window origin it was
 *    recorded at and is rebased onto the live request's origin, so the same
 *    level cells come back whichever window the editor sends.
 *  - /log accepts and keeps the batches (the research log, G-18).
 *
 * Every call is recorded with timestamps so specs can assert what was asked,
 * what was answered and when.
 */
import type { Page, Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FillRequest,
  LogEvent,
  ModelAnswer,
  Point,
  ProxyFillBody,
  ProxyFillResponse,
  ProxyLogBody,
  ProxySessionResponse,
} from "../../../apps/editor/src/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(here, "../fixtures");

/** Base URL of the fake proxy (passed to the editor as ?proxy=). Never resolves on the network. */
export const PROXY_URL = "http://pewter-proxy.e2e.test";

/** A recorded /fill answer, as stored in tests/e2e/fixtures/<name>.json. */
export interface FillFixture {
  /** What the recording shows (for people reading the fixture). */
  note: string;
  /** Window origin (level coordinates) of the request the answer was recorded for. */
  recordedOrigin: Point;
  /** The proxy's response, verbatim (answer coordinates are window-relative to recordedOrigin). */
  response: ProxyFillResponse;
}

export function loadFixture(name: string): FillFixture {
  const file = path.join(FIXTURE_DIR, name.endsWith(".json") ? name : `${name}.json`);
  const f = JSON.parse(readFileSync(file, "utf8")) as FillFixture;
  if (!f || typeof f !== "object" || !f.response || !f.recordedOrigin) throw new Error(`${file} is not a FillFixture`);
  return f;
}

function rebaseAnswer(a: ModelAnswer | null, dx: number, dy: number): ModelAnswer | null {
  if (!a) return a;
  return {
    ...a,
    adds: a.adds.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
    removes: a.removes.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
    entities: a.entities.map((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
  };
}

/**
 * The fixture's response for a live request: answers shifted from the recorded
 * window to the live one. The recorded requestHash is dropped (it names the
 * recorded request, not this one), so the editor logs the hash of what it sent,
 * as it would with the real proxy.
 */
export function replayResponse(f: FillFixture, req: Pick<FillRequest, "origin">): ProxyFillResponse {
  const dx = f.recordedOrigin.x - req.origin.x;
  const dy = f.recordedOrigin.y - req.origin.y;
  const out: ProxyFillResponse = { ...f.response, answer: rebaseAnswer(f.response.answer, dx, dy) };
  if (f.response.answers) out.answers = f.response.answers.map((a) => rebaseAnswer(a, dx, dy));
  delete (out as Partial<ProxyFillResponse>).requestHash;
  return out;
}

/** What a /fill call gets: a fixture (or a raw response) after a delay, or an HTTP error. */
export type FillReply =
  | { fixture: string | FillFixture; delayMs?: number }
  | { response: ProxyFillResponse; delayMs?: number }
  | { status: number; body?: unknown; delayMs?: number };

export interface FillCall {
  /** 1-based call number. */
  n: number;
  body: ProxyFillBody;
  /** Node clock (Date.now) when the request reached the mock. */
  receivedAt: number;
  /** Node clock when the reply was sent, or null if it never was (client gave up first). */
  repliedAt: number | null;
  /** Fixture name, or "response" / "status <n>". */
  replied: string;
  delayMs: number;
  /** True when fulfilling failed because the browser had already aborted the request. */
  abortedByClient: boolean;
}

export interface ProxyMockOptions {
  condition?: ProxySessionResponse["condition"];
  /** Per-token config overrides from /session (G-33). */
  overrides?: Record<string, unknown>;
  sessionId?: string;
  /**
   * Decide each /fill reply. Default: a declining answer ({act:false}) at once.
   * Return null for the default.
   */
  fill?: (body: ProxyFillBody, n: number) => FillReply | null;
  /** Make /session fail with this status (local fallback session). */
  sessionStatus?: number;
}

const DECLINE: ProxyFillResponse = {
  answer: { act: false, kind: "finish", adds: [], removes: [], entities: [], confidence: 0, label: "" },
  latencyMs: 0,
  model: "replay",
  promptVersion: "replay",
  requestHash: "",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ProxyMock {
  readonly fills: FillCall[] = [];
  readonly logBatches: ProxyLogBody[] = [];
  readonly sessions: string[] = [];
  private opts: ProxyMockOptions;
  private readonly fixtures = new Map<string, FillFixture>();

  constructor(
    private readonly page: Page,
    opts: ProxyMockOptions = {},
  ) {
    this.opts = { condition: "llm", sessionId: "e2e-session", ...opts };
  }

  /** Change how later /fill calls are answered. */
  onFill(fn: ProxyMockOptions["fill"]): void {
    this.opts.fill = fn;
  }

  /** Every logged event the proxy received, in order. */
  get loggedEvents(): LogEvent[] {
    return this.logBatches.flatMap((b) => b.events);
  }

  async install(): Promise<void> {
    await this.page.route(`${PROXY_URL}/session**`, (route) => this.session(route));
    await this.page.route(`${PROXY_URL}/fill`, (route) => this.fill(route));
    await this.page.route(`${PROXY_URL}/log**`, (route) => this.log(route));
  }

  private fixture(name: string | FillFixture): FillFixture {
    if (typeof name !== "string") return name;
    let f = this.fixtures.get(name);
    if (!f) {
      f = loadFixture(name);
      this.fixtures.set(name, f);
    }
    return f;
  }

  private async session(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    this.sessions.push(url.searchParams.get("token") ?? "");
    if (this.opts.sessionStatus) {
      await route.fulfill({ status: this.opts.sessionStatus, contentType: "application/json", body: JSON.stringify({ error: "refused" }) });
      return;
    }
    const body: ProxySessionResponse = {
      sessionId: this.opts.sessionId!,
      condition: this.opts.condition!,
      overrides: this.opts.overrides ?? {},
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  }

  private async fill(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() !== "POST") {
      await route.fulfill({ status: 405, body: "" });
      return;
    }
    const body = req.postDataJSON() as ProxyFillBody;
    const call: FillCall = {
      n: this.fills.length + 1,
      body,
      receivedAt: Date.now(),
      repliedAt: null,
      replied: "decline",
      delayMs: 0,
      abortedByClient: false,
    };
    this.fills.push(call);
    const reply = this.opts.fill?.(body, call.n) ?? { response: DECLINE };
    call.delayMs = reply.delayMs ?? 0;
    let status = 200;
    let payload: unknown;
    if ("fixture" in reply) {
      const f = this.fixture(reply.fixture);
      call.replied = typeof reply.fixture === "string" ? reply.fixture : "inline fixture";
      payload = replayResponse(f, body.request);
    } else if ("response" in reply) {
      call.replied = reply.response === DECLINE ? "decline" : "response";
      payload = reply.response;
    } else {
      status = reply.status;
      call.replied = `status ${reply.status}`;
      payload = reply.body ?? { error: `HTTP ${reply.status}` };
    }
    if (call.delayMs > 0) await sleep(call.delayMs);
    try {
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
      call.repliedAt = Date.now();
    } catch {
      // The editor aborted the fetch (superseded or timed out) before the answer came.
      call.abortedByClient = true;
    }
  }

  private async log(route: Route): Promise<void> {
    try {
      const body = route.request().postDataJSON() as ProxyLogBody;
      if (body && Array.isArray(body.events)) this.logBatches.push(body);
    } catch {
      /* keep going: a malformed batch is the editor's bug, asserted elsewhere */
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  }
}
