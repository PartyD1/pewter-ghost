/**
 * Seed set: SEED_FIXTURES -> EvalCases with the real window builder, brief
 * and measures (cases.buildCaseRequest). Patrol fixtures get their blocking
 * point from the real Patrol and agent, exactly as the app would.
 *
 *   npx tsx eval/src/cli.ts seed            # writes eval/data/seed.jsonl
 */
import { AgentClient } from "@physsim";
import { Patrol } from "../../../apps/editor/src/verify/patrol";
import { buildCaseRequest, hashRequest, packLevel, streamState, type CaseState } from "../cases";
import type { BlockedInfo, EvalCase } from "../types";
import { SEED_FIXTURES } from "./levels";
import type { SeedSpec } from "./sketch";

export interface SeedOptions {
  /** Agent for the patrol fixtures (default: an in-process AgentClient). */
  agent?: AgentClient;
  /** Patrol cap, ms (default 3000: the seed wants a conclusive answer, not the app's 1 s budget). */
  patrolCapMs?: number;
}

async function blockedFor(spec: SeedSpec, agent: AgentClient, capMs: number): Promise<BlockedInfo> {
  const last = spec.events[spec.events.length - 1];
  const p = new Patrol({
    level: spec.model,
    agent,
    config: { patrolIdleMs: 3000, patrolCapMs: capMs },
    frontier: () => last?.x,
  });
  const r = await p.runNow();
  if (r.beatable !== false || !r.blocked) throw new Error(`seed fixture ${spec.name}: patrol found no block (beatable ${String(r.beatable)})`);
  return { ...r.blocked, blockedAt: { ...r.blocked.blockedAt }, from: { ...r.blocked.from } };
}

/** One EvalCase from a fixture spec. */
export async function seedCase(spec: SeedSpec, seq: number, agent?: AgentClient, capMs = 3000): Promise<EvalCase> {
  let blocked: BlockedInfo | undefined;
  if (spec.patrol) {
    if (!agent) throw new Error("patrol fixtures need an agent");
    blocked = await blockedFor(spec, agent, capMs);
  }
  const state: CaseState = {
    level: spec.model.snapshot(),
    stream: streamState(spec.events, spec.now, spec.recentCount),
    mode: spec.mode,
    lastGhosts: spec.lastGhosts,
    lastGuess: spec.lastGuess,
    previousFailure: blocked ? { reason: blocked.reason, stage: "agent" } : spec.previousFailure,
    blockedAt: blocked?.blockedAt,
  };
  const request = buildCaseRequest(state);
  const c: EvalCase = {
    id: spec.name,
    source: "seed",
    sessionId: spec.sessionId,
    seq,
    family: spec.family,
    tags: spec.tags,
    request,
    requestHash: hashRequest(request),
    level: packLevel(state.level),
    stream: state.stream,
  };
  if (spec.lastGuess) c.lastGuess = spec.lastGuess;
  if (blocked) c.blocked = blocked;
  if (spec.expect) c.expect = spec.expect;
  return c;
}

/** Build every seed case (sequence numbers count per session, in fixture order). */
export async function buildSeedCases(o: SeedOptions = {}): Promise<EvalCase[]> {
  const agent = o.agent ?? new AgentClient({ worker: null });
  const seqBySession = new Map<string, number>();
  const out: EvalCase[] = [];
  try {
    for (const make of SEED_FIXTURES) {
      const spec = make();
      const seq = seqBySession.get(spec.sessionId) ?? 0;
      seqBySession.set(spec.sessionId, seq + 1);
      out.push(await seedCase(spec, seq, agent, o.patrolCapMs ?? 3000));
    }
  } finally {
    if (!o.agent) agent.dispose();
  }
  return out;
}

/** JSONL text of cases (one per line). */
export const toJsonl = (cases: readonly unknown[]): string => cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
