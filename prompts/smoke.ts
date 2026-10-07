/**
 * Live smoke test of prompt v1.
 *
 *   npx tsx prompts/smoke.ts            # render 3 fixture requests; call Gemini if a key is set
 *   npx tsx prompts/smoke.ts --dry      # render only
 *   npx tsx prompts/smoke.ts --samples 2 --temperature 0.4
 *
 * Renders three fixture editing states with the real window builder, brief
 * and measures, prints their sizes, and, ONLY if VITE_LLM_API_KEY (or
 * GEMINI_API_KEY) is set, sends each straight to Gemini through
 * proxy/src/gemini.ts (no proxy server needed). Prints the raw model text,
 * whether it parsed, the converted suggestion and the validator's verdict.
 * The key is never printed: GeminiUpstream scrubs it from errors, and this
 * script only ever reports whether one is set.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FillRequest } from "../apps/editor/src/contracts";
import { freshStart, midStaircase, patrolRightEdge, type FixtureState } from "../apps/editor/src/fill/__fixtures__/states";
import { buildFillRequest, estimateTokens } from "../apps/editor/src/fill/window";
import { buildBrief, measureRequestWindow } from "../apps/editor/src/fill/brief";
import { parseModelAnswerDetailed, PROMPT_VERSION, renderFillPrompt } from "../apps/editor/src/fill/prompt";
import { convertModelAnswer } from "../apps/editor/src/fill/answer";
import { seedLibrary } from "../apps/editor/src/fill/examples";
import { validateSuggestion } from "../apps/editor/src/verify/validate";
import { GeminiUpstream, DEFAULT_MODEL } from "../proxy/src/gemini";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv(): void {
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader !== "function") return;
  for (const name of [".env.local", ".env"]) {
    const p = path.join(here, "..", name);
    if (existsSync(p)) {
      try {
        loader(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requestFor(f: FixtureState): FillRequest {
  const level = f.model.snapshot();
  const brief = buildBrief({
    level,
    frontierX: f.stream.last?.x,
    focusX: f.blockedAt?.x,
    lastGhosts: f.lastGhosts,
    historyCount: 5,
    examples: { library: seedLibrary() },
  });
  return buildFillRequest(f.model, f.stream, {
    now: f.now,
    mode: f.mode,
    blockedAt: f.blockedAt,
    previousFailure: f.previousFailure,
    lastGhosts: f.lastGhosts,
    brief: brief.text,
    briefVersion: brief.version,
    measure: measureRequestWindow,
  });
}

async function main(): Promise<void> {
  loadDotEnv();
  const fixtures = [freshStart(), midStaircase(), patrolRightEdge()];
  const key = process.env.VITE_LLM_API_KEY || process.env.GEMINI_API_KEY || "";
  const dry = process.argv.includes("--dry") || !key;
  const samples = arg("--samples") === "2" ? 2 : 1;
  const temperature = Number(arg("--temperature") ?? 0.2);
  const model = process.env.VITE_LLM_MODEL_NAME || DEFAULT_MODEL;
  console.log(`prompt ${PROMPT_VERSION}; key ${key ? "set" : "NOT set"}; model ${model}; ${dry ? "dry run" : `samples ${samples}, temperature ${temperature}`}`);

  const upstream = dry
    ? undefined
    : new GeminiUpstream({
        apiKey: key,
        model,
        timeoutMs: Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS) || 20_000,
        thinkingBudget: process.env.PROXY_THINKING_BUDGET ? Number(process.env.PROXY_THINKING_BUDGET) : null,
      });

  for (const f of fixtures) {
    const req = requestFor(f);
    const prompt = renderFillPrompt(req);
    console.log(`\n=== ${f.name} (mode ${req.mode}, window origin ${req.origin.x},${req.origin.y}) ===`);
    console.log(`system ~${estimateTokens(prompt.system)} tok, user ~${estimateTokens(prompt.user)} tok (est. chars/4)`);
    if (!upstream) {
      console.log(prompt.user);
      continue;
    }
    const t0 = performance.now();
    try {
      const res = await upstream.generate({ prompt, temperature, samples });
      const ms = Math.round(performance.now() - t0);
      console.log(
        `latency ${ms} ms; usage ${JSON.stringify(res.usage ?? {})}; logprob ${res.logprob ?? "n/a"}` +
          ` (logprobs ${upstream.logprobsEnabled ? "requested" : "off: rejected by the API"}; thinking ${upstream.thinkingBudget ?? "default"})` +
          (res.sampleErrors ? `; sample errors ${JSON.stringify(res.sampleErrors)}` : ""),
      );
      res.texts.forEach((text, i) => {
        console.log(`--- sample ${i + 1} raw ---\n${text ?? "(no text)"}`);
        const parsed = text == null ? { answer: null, error: "no text" } : parseModelAnswerDetailed(text);
        if (!parsed.answer) {
          console.log(`parsed: NO (${parsed.error})`);
          return;
        }
        console.log("parsed: yes");
        const conv = convertModelAnswer(parsed.answer, req, { filler: "llm", requestHash: "smoke", latencyMs: ms });
        if (conv.dropped.length) console.log(`dropped by converter: ${JSON.stringify(conv.dropped)}`);
        if (!conv.suggestion) {
          console.log(`no suggestion (${conv.empty})`);
          return;
        }
        const s = conv.suggestion;
        console.log(
          `suggestion: ${s.kind} "${s.label}" conf ${s.confidence} guess ${s.levelGuess ?? "-"}; ` +
            `adds ${JSON.stringify(s.adds)} removes ${JSON.stringify(s.removes)} entities ${JSON.stringify(s.entities)} (level coords)`,
        );
        const v = validateSuggestion(f.model, s, { act: true, lastGhosts: f.lastGhosts, frontierX: f.stream.last?.x });
        console.log(`validator: ${v.ok ? "ok" : `FAIL at ${v.stage}: ${v.reason}`}${v.tags?.length ? ` tags ${v.tags.join(",")}` : ""}`);
      });
    } catch (e) {
      console.log(`call failed after ${Math.round(performance.now() - t0)} ms: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(`smoke failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
