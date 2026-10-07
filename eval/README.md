# eval/ — the offline suite

The development loop for the autofill (plan G-20, G-25, G-27, G-28, G-29, G-38).
Recorded or seed requests are replayed through a configuration (prompt, model,
window size, confidence source, samples) and every answer is scored without a
person in the loop. Every prompt, model or window change goes through it
before it ships.

```
npx tsx eval/src/cli.ts help
npx tsx eval/src/cli.ts seed                                   # eval/data/seed.jsonl (52 fixture requests)
npx tsx eval/src/cli.ts run --name baseline                    # eval/reports/baseline.md
npx tsx eval/src/cli.ts run --model recorded --data proxy/.data/recordings   # score recorded answers, no API calls
npx tsx eval/src/cli.ts compare --a-model gemini-3.7-flash --b-model gemini-2.5-flash-lite
npx tsx eval/src/cli.ts compare baseline other-run             # two saved runs (eval/runs/*.json)
npx tsx eval/src/cli.ts calibrate --logs proxy/.data/logs      # G-27
npx tsx eval/src/cli.ts matrix --models gemini-2.5-flash-lite,gemini-3.7-flash   # G-28
npx tsx eval/src/cli.ts dashboard --levels levels/saved        # G-29 -> eval/dashboard/index.html
npx tsx eval/src/cli.ts export --format gemini                 # G-38 -> eval/data/export/finetune-gemini.jsonl
```

Live calls need `VITE_LLM_API_KEY` (or `GEMINI_API_KEY`, or a `.env` at the
project root). The key is only ever reported as set / not set. Calls go
straight through `proxy/src/gemini.ts` with `fill/prompt.ts renderFillPrompt`,
four at a time (`--concurrency`), and are cached in `eval/.cache/calls` by
(rendered prompt, model, temperature, samples, thinking budget), so reruns are
free. `--refresh` ignores the cache. Failed calls are not cached.

## Inputs

- `eval/data/*.jsonl`: eval cases (`EvalCase` in `src/types.ts`). The seed set
  carries the full level and the placement-stream state, so its requests can
  be rebuilt for another window size and verified against the real level.
- `proxy/.data/recordings/*.jsonl` (`--data` or `--recordings-too`): the
  proxy's `Recording` lines. They carry only the window, so the suite
  reconstructs a level from the window text to verify against, and cannot
  re-window them (those cells of a matrix skip them).

## Scores (src/score/)

| scorer | what |
|---|---|
| schema | every sample parses against the answer schema (`parseModelAnswerDetailed`) |
| coords | items inside the window (and how many look like level coordinates), on free cells, tile groups anchored within the knight's reach, enemies on floor, within one running jump of the frontier / recent placements / blocking point |
| verify | `@app/verify`: validator stage and pattern tags, rule check + playtest agent on the first try, one send-back with the failure reason (patrol answers through `verifyPatrolFix` with the local repair switched off) |
| variety | per session: distinct tags, a tag three times running (the suite FAILS; `--strict` exits 1), extends repeating both last accepted extends, novelty vs the previous answer |
| latency | p50 / p90 / p99, share within `callTimeoutMs` |
| calibration | bins, app bands, AUC, Brier, ECE, slope, steepness, suggested thresholds |

Seed cases may carry an expectation (act or decline, acceptable kinds), scored
as "expectation met".

## Outputs

- `eval/reports/<name>.md` — committed; summary table first.
- `eval/runs/<name>.json` — full per-case results (gitignored), input to
  `compare` and `export --run`.
- `eval/dashboard/index.html` (+ `.json`) — static, no scripts.

## Caveats

- The seed set is hand-built fixtures, not real sessions: sessions there are
  families of similar fixtures, so the variety rule fails by construction on
  some (e.g. every gap fixture yields `pit`). Treat variety on seed as a smoke
  check; it becomes meaningful on recorded sessions.
- Several seed fixtures resemble the prompt's few-shots (e.g. the staircase),
  which flatters those cases.
- On seed, "acceptance" for calibration is verified-first-try; with logs
  (`--logs`) real acceptance is joined by request hash.
