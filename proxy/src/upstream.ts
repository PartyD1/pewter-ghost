/**
 * The model behind /fill. gemini.ts implements it; tests use fakes.
 */
import type { RenderedPrompt } from "../../apps/editor/src/contracts";

export interface UpstreamRequest {
  prompt: RenderedPrompt;
  temperature: number;
  samples: 1 | 2;
}

export interface UpstreamResult {
  /** Raw text of each sample (null when that sample failed or returned no text). */
  texts: (string | null)[];
  /** Mean token log-probability of the first sample, when the upstream exposes it. */
  logprob?: number;
  /** Model id that answered (the pinned id). */
  model: string;
  /** Per-sample errors (same length as texts) when some but not all samples failed. */
  sampleErrors?: (string | null)[];
  usage?: { promptTokens?: number; outputTokens?: number };
}

export type UpstreamErrorKind = "timeout" | "http" | "network" | "config" | "bad-response";

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface Upstream {
  readonly model: string;
  /** Must reject with UpstreamError on timeout / HTTP failure. */
  generate(req: UpstreamRequest): Promise<UpstreamResult>;
}
