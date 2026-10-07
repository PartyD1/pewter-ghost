/**
 * Test doubles for the suite: a fake model upstream, deterministic answers
 * for a request, a small case set built without the agent, and a scripted
 * session log with recordings (dashboard, export, calibration).
 */
import type {
  FillRequest,
  LogEvent,
  ModelAnswer,
  Recording,
  RenderedPrompt,
} from "../../../apps/editor/src/contracts";
import { UpstreamError, type Upstream, type UpstreamRequest, type UpstreamResult } from "../../../proxy/src/upstream";
import { seedCase } from "../fixtures/seed";
import { SEED_FIXTURES } from "../fixtures/levels";
import type { EvalCase } from "../types";

/** Fake upstream: answers by a function of the prompt; counts calls. */
export class FakeUpstream implements Upstream {
  calls: UpstreamRequest[] = [];
  constructor(
    readonly model: string,
    private readonly answer: (prompt: RenderedPrompt, sample: number, call: number) => string | null | Error,
    private readonly o: { logprob?: number } = {},
  ) {}
  async generate(req: UpstreamRequest): Promise<UpstreamResult> {
    const n = this.calls.push(req) - 1;
    const texts: (string | null)[] = [];
    for (let i = 0; i < req.samples; i++) {
      const a = this.answer(req.prompt, i, n);
      if (a instanceof Error) throw a;
      texts.push(a);
    }
    const r: UpstreamResult = { texts, model: this.model, usage: { promptTokens: 1000, outputTokens: 50 } };
    if (this.o.logprob !== undefined) r.logprob = this.o.logprob;
    return r;
  }
}

export const httpError = (status: number) => new UpstreamError("http", `upstream ${status}: nope`, status);

/** Frontier cell of the request (window coordinates). */
const frontierOf = (req: FillRequest) => ({ x: req.frontier.x, y: req.frontier.y });

/** A plausible finish answer: one block to the right of the frontier, on the frontier's row. */
export function nextToFrontier(req: FillRequest, confidence = 0.8): ModelAnswer {
  const f = frontierOf(req);
  return {
    act: true,
    kind: "finish",
    adds: [{ x: Math.min(req.size.w - 1, f.x + 1), y: f.y, tile: "block" }],
    removes: [],
    entities: [],
    confidence,
    label: "one more block",
  };
}

/** A clearly wrong answer: tiles in level coordinates (outside the window). */
export function levelCoordAnswer(req: FillRequest): ModelAnswer {
  return {
    act: true,
    kind: "extend",
    adds: [{ x: req.origin.x + req.frontier.x + 1, y: req.origin.y + req.frontier.y, tile: "grass" }],
    removes: [],
    entities: [],
    confidence: 0.3,
    label: "wrong coordinates",
  };
}

export const decline: ModelAnswer = { act: false, kind: "extend", adds: [], removes: [], entities: [], confidence: 0, label: "wait" };

/** Seed cases without patrol (no agent needed), first `n`. */
export async function quickCases(names?: readonly string[]): Promise<EvalCase[]> {
  const out: EvalCase[] = [];
  const seq = new Map<string, number>();
  for (const make of SEED_FIXTURES) {
    const spec = make();
    if (spec.patrol) continue;
    if (names && !names.includes(spec.name)) continue;
    const s = seq.get(spec.sessionId) ?? 0;
    seq.set(spec.sessionId, s + 1);
    out.push(await seedCase(spec, s));
  }
  return out;
}

/** A recording for a case with a given answer. */
export function recordingFor(c: EvalCase, answer: ModelAnswer | null, o: { sessionId?: string; t?: string; latencyMs?: number } = {}): Recording {
  return {
    t: o.t ?? "2026-10-01T10:00:00.000Z",
    sessionId: o.sessionId ?? "s1",
    requestHash: c.requestHash,
    request: c.request,
    answer,
    latencyMs: o.latencyMs ?? 700,
    model: "gemini-test",
    promptVersion: "fill.v1-test",
  };
}

/**
 * A scripted session: three ghosts joined to recordings (one accepted and
 * then hand-repaired, one drawn over, one accepted partially), plus calls
 * with verdicts, a send-back and a timeout.
 */
export function scriptedSession(cases: readonly EvalCase[], sessionId = "s1"): { events: LogEvent[]; recordings: Recording[] } {
  const [c1, c2, c3] = cases;
  const a1 = nextToFrontier(c1.request, 0.9);
  const a2 = nextToFrontier(c2.request, 0.2);
  const a3 = nextToFrontier(c3.request, 0.6);
  const recordings = [
    recordingFor(c1, a1, { sessionId, t: "2026-10-01T10:00:01.000Z" }),
    recordingFor(c2, a2, { sessionId, t: "2026-10-01T10:01:01.000Z" }),
    recordingFor(c3, a3, { sessionId, t: "2026-10-01T10:02:01.000Z" }),
  ];
  const id = (c: EvalCase, n: number) => `llm-${n}-${c.requestHash.slice(0, 8)}`;
  const f1 = c1.request.frontier;
  const repairX = c1.request.origin.x + Math.min(c1.request.size.w - 1, f1.x + 1);
  const repairY = c1.request.origin.y + f1.y;
  const events: LogEvent[] = [
    { type: "session", t: 0, sessionId, commit: "abc1234", promptVersion: "fill.v1-test", briefVersion: "brief.v1-test", model: "gemini-test", filler: "llm", config: {} },
    { type: "fill.call", t: 900, requestHash: c1.requestHash, mode: "auto", superseded: false, latencyMs: 700, act: true, kind: "finish", confidence: 0.9, tiles: 1, verdictStage: "ok" },
    { type: "ghost.show", t: 1000, suggestionId: id(c1, 1), kind: "finish", confidence: 0.9, shownBecause: "now", cells: 1, label: a1.label },
    { type: "ghost.end", t: 3000, suggestionId: id(c1, 1), outcome: "accepted", dwellMs: 2000, acceptedCells: 1 },
    { type: "erase", t: 13_000, x: repairX, y: repairY, tile: 0, author: 1, stroke: "k1", tool: "erase" },
    { type: "fill.call", t: 60_500, requestHash: c2.requestHash, mode: "auto", superseded: false, latencyMs: 800, act: true, kind: "finish", confidence: 0.2, tiles: 1, verdictStage: "ok", sendBack: true },
    { type: "ghost.show", t: 61_000, suggestionId: id(c2, 2), kind: "finish", confidence: 0.2, shownBecause: "longPause", cells: 1, label: a2.label },
    { type: "ghost.end", t: 62_000, suggestionId: id(c2, 2), outcome: "drawn-over", dwellMs: 1000 },
    { type: "fill.call", t: 100_000, requestHash: "f".repeat(64), mode: "auto", superseded: false, latencyMs: 900, act: null, error: "fill-timeout" },
    { type: "fill.call", t: 110_000, requestHash: "e".repeat(64), mode: "auto", superseded: true, latencyMs: 0, act: null },
    { type: "fill.call", t: 115_000, requestHash: "d".repeat(64), mode: "auto", superseded: false, latencyMs: 600, act: true, kind: "extend", confidence: 0.5, tiles: 3, verdictStage: "agent", reason: "stuck", sendBack: true },
    { type: "fill.call", t: 120_500, requestHash: c3.requestHash, mode: "auto", superseded: false, latencyMs: 650, act: true, kind: "finish", confidence: 0.6, tiles: 1, verdictStage: "ok" },
    { type: "ghost.show", t: 121_000, suggestionId: id(c3, 3), kind: "finish", confidence: 0.6, shownBecause: "pause", cells: 1, label: a3.label },
    { type: "ghost.end", t: 124_000, suggestionId: id(c3, 3), outcome: "partial", dwellMs: 3000, acceptedCells: 1 },
    { type: "patrol", t: 130_000, beatable: true, ms: 120 },
    { type: "save", t: 140_000, snapshotId: "snap-1" },
  ];
  return { events, recordings };
}
