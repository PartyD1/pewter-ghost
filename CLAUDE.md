# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pewter Ghost is an LLM autofill for a 2D platformer level editor (Phaser 3 + TypeScript + Vite, Node 22). As the person paints, a model proposes the next stretch of level as a faint "ghost"; nothing reaches the screen unless a validator and a physics-exact playtest agent both pass it. See `README.md` for the user-facing description, `docs/PLAN.md` for the full design (work items G-01..G-38; code comments cite these IDs), and `ORIGIN.md` for where copied code came from.

## Commands

Use npm (`package-lock.json` is the one CI installs from).

```bash
npm run dev            # proxy + editor together; refuses to start without a model key (cp .env.example .env, set GEMINI_API_KEY)
npm run dev:editor     # editor alone, no AI (http://localhost:5173)
npm run typecheck      # tsc --noEmit (covers apps, packages, proxy, eval, tests)
npm test               # vitest run (Node, no browser)
npx vitest run apps/editor/src/fill            # one directory
npx vitest run -t "name of test"               # one test by name
npx tsx prompts/build.ts --check               # prompts/bundle.ts must match prompt sources (CI check)
npx tsx prompts/build.ts                       # regenerate bundle (few-shots: npx tsx prompts/fewshot/make.ts)
npm run build          # typecheck + vite build into dist/
npx tsx proxy/src/keyScan.ts dist              # fail if dist/ contains a key pattern
npm run test:e2e       # Playwright suite (tests/e2e), proxy mocked; one spec: npm run test:e2e -- latency
node apps/editor/src/__e2e__/loopCheck.cjs     # stub-filler whole-loop browser check (also ghost/__e2e__/ghostCheck.cjs)
npm run eval -- help   # offline eval suite (eval/README.md)
```

`levels/` is not in the root vite/tsconfig yet: use `npx tsx levels/build.ts [--check]`, `npx vitest run --config levels/vitest.config.ts` and `npx tsc --noEmit -p levels` (see `levels/README.md`).

URL switches for manual testing: `/?filler=stub&dev=1` (deterministic, no network), `/?filler=none` (human-only), `/?token=dev&callTimeoutMs=4000` (model via local proxy), `&timing=cdhf|jev` (timing policy; default `llm`, see `suggest/timing/policy.ts`). Dev reloads start a fresh level; `?restore=1` brings back the autosave.

## Architecture

The loop, wired in `apps/editor/src/session.ts` (`FillLoop` has no Phaser and runs in Node tests; `PewterApp` is the boot glue `main.ts` creates):

```
placements -> PlacementStream -> FillRequest (ASCII window + brief + measured numbers)
  -> Filler (llm via proxy | stub | algo | none) -> reconcile against current level
  -> verify (validator, rule check, playtest agent, one send-back) -> SuggestionManager -> ghost layer
idle -> patrol (agent plays start -> frontier) -> blocked? -> Fix ghost (model, else <=3-tile local repair)
```

- **Source layout**: `apps/editor/src/{level,editor,ui,player,entities,fill,verify,suggest,ghost,research}` plus shared pure packages `packages/{physsim,measure,jump-tables,chunks}`, `prompts/`, `proxy/`, `eval/`, `levels/`. Import aliases (`@app/*`, `@physsim`, `@measure`, `@jump-tables`, `@chunks`) are defined in both `tsconfig.json` and `vite.config.ts`; add new ones to both.
- **Contracts** live in `apps/editor/src/contracts.ts`; every tunable in `apps/editor/src/suggest/config.ts` (`DEFAULT_CONFIG`). Config precedence: `DEFAULT_CONFIG` <- URL params <- `GET /session` overrides. Config fields are flat so the shallow `applyOverrides` can override each one. Don't change a contract silently: add a dated line to `docs/decisions.md` and keep old fields working.
- **Pure logic stays free of Phaser imports** so it runs in Node tests and Web Workers (the playtest agent runs in a worker in `packages/physsim`).
- **Coordinates**: tiles, x right, y down, origin top-left, level 200x20. In a `FillRequest` only `origin`/`size` are level coordinates; `grid`, `recent`, `frontier`, `blockedAt` and the model's answer are window-relative. Validator failure reasons use level coordinates.
- **Speculative calls**: up to `maxInFlight` model calls run concurrently; each answer is reconciled (`fill/reconcile.ts`) against the level as it is now and dropped if stale. Dropped calls are logged as `fill.call` with `superseded: true` and a `reason`. `SuggestionManager` holds one slot.
- **Prompt**: system prompt = `prompts/fill.v1.md` + static brief + few-shots, bundled into the generated `prompts/bundle.ts` (so Vite, tsx, Worker and Vitest share the same text). `PROMPT_VERSION` is a hash of that text, so any prompt edit changes it; `fill/prompt.test.ts` and CI fail when the bundle or snapshots (`prompts/__snapshots__`, `fill/__snapshots__`) are stale. Dynamic per-request part comes from `fill/brief.ts`.
- **Proxy** (`proxy/`): the only thing that reads the model key; tokens map to `{sessionId, condition, overrides}`; records every `/fill` exchange to git-ignored `proxy/.data/` for the eval suite. `/fill` answers HTTP 200 with `answer: null` on upstream failure.
- **Physics must match Play mode**: `packages/jump-tables` and `physsim` are derived from the player physics in `apps/editor/src/player`; changing player physics means regenerating tables (`npm run jump-tables`) and their parity tests.
- **Research log**: events (`session` first, `fill.call`, `ghost.show/end`, patrol, play, undo, save) go to the proxy `/log`; `research/completeness.ts` checks a log.

## Gotchas

- **Never read `import.meta.env` as a whole object** (Vite would inline `VITE_LLM_API_KEY` into the bundle). Only static properties like `import.meta.env.VITE_COMMIT`; `session.test.ts` scans for violations and CI builds with a canary key and greps `dist/`.
- Never print, log or commit the model key; it is read by the proxy only (`GEMINI_API_KEY` / `VITE_LLM_API_KEY`).
- `docs/PLAN.md`, `README.md` and `docs/decisions.md` lag the code in places (e.g. the route overlay / `R` key was removed, and suggestion timing has changed since); trust the code and recent git log, and add a line to `docs/decisions.md` when you change behavior.
- Tests are `*.test.ts` next to the code (Vitest includes `apps`, `packages`, `proxy`, `eval`); fast-check is used for property tests.
