/**
 * Fillers that make no model call, as an answer source for the suite:
 * `--model algo` (fill/AlgoFiller.ts, the rule-based "no AI" condition) or
 * `--model markov` (fill/MarkovFiller.ts). The suite builds the same
 * requests, sends the same send-backs and scores the answers exactly as it
 * does a model's, so the conditions can be compared offline.
 */
import type { FillRequest, ModelAnswer } from "../../apps/editor/src/contracts";
import { AlgoFiller } from "../../apps/editor/src/fill/AlgoFiller";
import { MarkovFiller } from "../../apps/editor/src/fill/MarkovFiller";
import type { CallResult } from "./types";

export const LOCAL_FILLERS = ["algo", "markov"] as const;
export type LocalFillerName = (typeof LOCAL_FILLERS)[number];

export const isLocalFiller = (model: string): model is LocalFillerName => (LOCAL_FILLERS as readonly string[]).includes(model);

/** Answers a request (window-relative) the way the filler would live; one instance per run, so send-backs move on. */
export type LocalAnswerer = (req: FillRequest) => { answer: ModelAnswer; ms: number };

export function localAnswerer(name: LocalFillerName): LocalAnswerer {
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  if (name === "algo") {
    const f = new AlgoFiller({ clock });
    return (req) => {
      const p = f.propose(req);
      return { answer: p.answer, ms: p.ms };
    };
  }
  const f = new MarkovFiller();
  return (req) => {
    const t0 = clock();
    const p = f.propose(req);
    return { answer: p.answer, ms: clock() - t0 };
  };
}

/** A local answer as the suite's CallResult (as if a model had sent that JSON). */
export function localCall(name: LocalFillerName, answerer: LocalAnswerer, req: FillRequest): CallResult {
  const { answer, ms } = answerer(req);
  return { texts: [JSON.stringify(answer)], parsed: [answer], latencyMs: Math.round(ms), model: name, promptVersion: name };
}
