/** Test fakes shared by proxy tests: a FillRequest, a renderer, a parser, upstreams. */
import type { FillRequest, ModelAnswer, RenderedPrompt } from "../../../apps/editor/src/contracts";
import { UpstreamError, type Upstream, type UpstreamRequest, type UpstreamResult } from "../upstream";

export function sampleRequest(over: Partial<FillRequest> = {}): FillRequest {
  return {
    grid: "   0123\n 0 ....\n 1 ##..\n",
    origin: { x: 10, y: 4 },
    size: { w: 24, h: 12 },
    recent: [{ dt: 120, x: 12, y: 9, tile: "grass", tool: "paint" }],
    frontier: { x: 13, y: 9, idleMs: 900 },
    knight: { maxGapStand: 3, maxGapRun: 5, maxRise: 3 },
    measured: { density: 0.2, gapHist: [0, 1, 0, 0, 0], verticality: 0.1, rewardSpacing: 0, pressure: 0 },
    brief: "Make a fair level.",
    briefVersion: "brief.v1",
    lastGhosts: [],
    mode: "auto",
    ...over,
  };
}

export const GOOD_ANSWER: ModelAnswer = {
  act: true,
  kind: "extend",
  adds: [
    { x: 4, y: 9, tile: "grass" },
    { x: 5, y: 9, tile: "grass" },
  ],
  removes: [],
  entities: [{ kind: "coin", x: 5, y: 7 }],
  confidence: 0.8,
  label: "continue the ledge",
};

export const fakeRender = (req: FillRequest): RenderedPrompt => ({
  system: "SYSTEM",
  user: `USER ${req.grid.length}`,
  responseSchema: { type: "OBJECT", properties: { act: { type: "BOOLEAN" } }, required: ["act"] },
  promptVersion: "fill.test.1",
});

/** Accepts objects that look like a ModelAnswer; null for anything else. */
export const fakeParse = (raw: unknown): ModelAnswer | null => {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<ModelAnswer>;
  if (typeof a.act !== "boolean" || !Array.isArray(a.adds) || typeof a.confidence !== "number") return null;
  return a as ModelAnswer;
};

export class FakeUpstream implements Upstream {
  readonly model = "fake-model-1";
  calls: UpstreamRequest[] = [];
  constructor(
    public impl: (req: UpstreamRequest, n: number) => Promise<UpstreamResult> | UpstreamResult = () => ({
      texts: [JSON.stringify(GOOD_ANSWER)],
      logprob: -0.12,
      model: "fake-model-1",
    }),
  ) {}
  async generate(req: UpstreamRequest): Promise<UpstreamResult> {
    this.calls.push(req);
    return this.impl(req, this.calls.length);
  }
}

export const timeoutUpstream = () =>
  new FakeUpstream(() => {
    throw new UpstreamError("timeout", "upstream timeout after 10 ms");
  });
