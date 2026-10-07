# Notes for builders (humans and agents)

- Everything lives under `pewter-ghost/`. Run commands from there.
- Spec: `docs/PLAN.md` (generated from the published plans; work items G-01..G-38 at the end).
- Contracts: `apps/editor/src/contracts.ts`. Tunables: `apps/editor/src/suggest/config.ts`.
  Do not change a contract silently: if you must, add a line to `docs/decisions.md` and keep old fields working.
- Import aliases: `@app/*` -> apps/editor/src, `@physsim`, `@measure`, `@jump-tables`, `@chunks` -> packages/*/src/index.ts.
- Tests: Vitest, files named `*.test.ts` next to the code. Run your own: `npx vitest run <dir>`.
  Typecheck: `npx tsc --noEmit -p .` (other modules may be mid-build; only your files must be clean).
- Do not run `npm install` or edit `package.json`; ask in your final report if you need a dependency.
- Never print, log or commit the model key. It is read from `VITE_LLM_API_KEY` by the proxy only.
- Pure logic stays free of Phaser imports so it can run in Node tests and in Web Workers.
- Coordinates: tiles, x right, y down, origin top-left, level 200 x 20.
