/**
 * Deterministic context for the LLM (research path: no algo filler required).
 * Pure: same FillRequest + grid parse → same hints.
 */
import { detectAnomalies, type AnomalyProposal } from "@chunks";
import type { FillRequest } from "../contracts";
import { config as liveConfig } from "../suggest/config";
import { detectReachabilityHint, type ReachabilityHint } from "./reachability";
import { parseWindowGrid } from "./windowGrid";

export interface ComputedContext {
  anomaly?: AnomalyProposal;
  reachability?: ReachabilityHint;
  /** Lines appended to the user prompt. */
  lines: string[];
}

export interface ContextOptions {
  comfortGap?: number;
  enabled?: boolean;
}

/** Build structured context and prompt lines for one request. */
export function buildComputedContext(req: FillRequest, opts: ContextOptions = {}): ComputedContext {
  const cfg = liveConfig.context;
  const enabled = opts.enabled ?? cfg?.enabled ?? true;
  const lines: string[] = [];
  if (!enabled) return { lines };

  const grid = parseWindowGrid(req);
  if (!grid) return { lines };

  const recent = req.recent.map((r) => ({ x: r.x, y: r.y, tile: r.tile, tool: r.tool }));
  const anomaly = detectAnomalies(grid, recent);
  const reachability = detectReachabilityHint(req, grid, { comfortGap: opts.comfortGap ?? cfg?.comfortGap });

  if (anomaly) {
    lines.push(anomaly.evidence);
    if (req.mode !== "tidy") {
      lines.push(
        `If the outlier is a mistake, answer act=true kind=fix removes=[(${anomaly.removes.map((p) => `${p.x},${p.y}`).join("), (")})] ` +
          `with label like "${anomaly.label}" and confidence around ${anomaly.confidence}.`,
      );
    }
  }

  if (reachability) {
    lines.push(reachability.evidence);
    if (!reachability.reachable || reachability.comfort) {
      lines.push(`A fix for this jump is appropriate when the person paused or asked; label like "${reachability.label}".`);
    }
  }

  return { anomaly, reachability, lines };
}

/** One block for renderUserMessage. */
export function describeComputedContext(req: FillRequest): string | undefined {
  const { lines } = buildComputedContext(req);
  if (!lines.length) return undefined;
  return "Computed context (deterministic; trust for shape and jump math):\n" + lines.map((l) => `- ${l}`).join("\n");
}
