/**
 * Schema scorer: did every sample parse against the answer schema
 * (fill/prompt.ts parseModelAnswerDetailed, the same strict check the client
 * and proxy use)?
 */
import type { ModelAnswer } from "../../../apps/editor/src/contracts";
import { parseModelAnswerDetailed } from "../../../apps/editor/src/fill/prompt";
import type { CallResult } from "../types";

export interface SchemaScore {
  /** Every sample produced a valid answer. */
  ok: boolean;
  /** Parsed answers, one per sample (null where a sample failed). */
  answers: (ModelAnswer | null)[];
  /** Rejection reason per sample (undefined where it parsed). */
  errors: (string | undefined)[];
}

/** Parse the call's samples. A call with no samples (an error) is not ok. */
export function scoreSchema(call: Pick<CallResult, "texts" | "parsed" | "error">): SchemaScore {
  const answers: (ModelAnswer | null)[] = [];
  const errors: (string | undefined)[] = [];
  if (call.parsed && call.parsed.length) {
    // Recorded answers: already parsed by the proxy; re-validate the objects.
    call.parsed.forEach((a, i) => {
      if (a === null) {
        const raw = call.texts[i];
        const r = raw ? parseModelAnswerDetailed(raw) : { answer: null, error: "no usable answer recorded" };
        answers.push(r.answer);
        errors.push(r.answer ? undefined : r.error ?? "no usable answer recorded");
        return;
      }
      const r = parseModelAnswerDetailed(a);
      answers.push(r.answer);
      errors.push(r.error);
    });
  } else {
    for (const t of call.texts) {
      if (t == null) {
        answers.push(null);
        errors.push("no text");
        continue;
      }
      const r = parseModelAnswerDetailed(t);
      answers.push(r.answer);
      errors.push(r.error);
    }
  }
  if (answers.length === 0) errors.push(call.error ?? "no samples");
  const ok = answers.length > 0 && answers.every((a) => a !== null);
  return { ok, answers, errors };
}
