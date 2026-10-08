# Pewter Ghost

An autofill for a 2D platformer level editor. As you paint, a model proposes the
next stretch of the level as a faint **ghost**: finish the staircase you started,
continue a platform past a gap, or repair a jump the knight cannot make.
**Tab** keeps the ghost, **Esc** (or carrying on drawing) dismisses it, and
**Ctrl+Space** asks for one. Every ghost is checked before you see it. A
validator and a physics-exact playtest agent (the same knight as Play mode) must
both pass it. Nothing unverified ever reaches the screen.

It is the research successor to the Pewter editor (see [ORIGIN.md](ORIGIN.md)):
Phaser 3.90 + TypeScript + Vite, with a small proxy that holds the model key.
The full design is in [docs/PLAN.md](docs/PLAN.md); conventions for contributors
are in [docs/BUILDERS.md](docs/BUILDERS.md); and decisions that changed a contract are in
[docs/decisions.md](docs/decisions.md).

```
placements ─► PlacementStream ─► FillRequest (ASCII window + brief + measured numbers)
   ─► Filler (llm via proxy | stub | none) ─► verify (validator, rule check, agent, one send-back)
   ─► SuggestionManager (confidence / pause timing, cool-downs) ─► ghost layer + status strip
idle ─► patrol (agent plays start → frontier) ─► blocked? ─► Fix ghost (model, else ≤3-tile local repair)
```

The loop is wired in `apps/editor/src/session.ts`, and `main.ts` starts it.

## Layout

| Path | What |
|---|---|
| `apps/editor/src/level` | `LevelModel`: grid, entities, authorship (person / ghost), command undo, save v2, share codes |
| `apps/editor/src/editor`, `ui` | Phaser scenes, painting, camera, Play mode, toolbar, palette, dialogs |
| `apps/editor/src/player`, `entities` | The fork's frame-rate-independent knight; time-based enemies |
| `apps/editor/src/fill` | Placement stream, window builder, prompt v1, design brief, `LLMFiller`, `StubFiller` |
| `apps/editor/src/verify` | Validator, playability check, send-back pipeline, patrol + local repair |
| `apps/editor/src/suggest` | `SuggestionManager` (when to show), thresholds, **`config.ts` (every tunable)** |
| `apps/editor/src/ghost` | Ghost layer, captions, keys, route overlay, dev overlay |
| `apps/editor/src/research` | Event log (`/log`), schema, completeness checker, session client |
| `apps/editor/src/session.ts` | The whole loop (FillLoop) and the boot glue (PewterApp) |
| `packages/physsim` | Playtest agent (Arcade physics re-implementation + A*), rule check, Web Worker |
| `packages/jump-tables` | Exact jump reach tables from the fork's jump solver |
| `packages/measure` | Level measures and pattern tags (density, gaps, verticality, ...) |
| `prompts/` | Prompt v1, brief fragments, few-shots, reference sections (bundled into `prompts/bundle.ts`) |
| `proxy/` | Key-holding proxy: tokens, `/session`, `/fill`, `/log`, recordings ([proxy/README.md](proxy/README.md)) |
| `eval/` | Offline suite: replays recorded requests and scores answers |

## Run it

Node 22. From this directory:

```bash
cp .env.example .env            # then put your Gemini key in .env (GEMINI_API_KEY=...); never commit it
npm install
npm run dev                     # starts the key-holding proxy and the editor together
```

Open http://localhost:5173. The editor looks like Pewter Platformer (panel on the
right, toolbar at the bottom) but has no chat: ghosts appear on the canvas as you
draw. `npm run dev` refuses to start without a model key, because Pewter Ghost
without the AI is not the product.

`npm run dev:editor` starts the editor alone, without AI, for debugging the editor.

In development a plain reload starts a fresh level (handy for testing). **Save task**
reloads into the level it just saved; `?restore=1` brings back the autosave. A built
copy restores the autosave on every reload so a participant never loses work.
To force a filler, open it with:

| URL | What you get |
|---|---|
| `/?filler=stub&dev=1` | Deterministic staircase filler; no network. Good for trying the loop. |
| `/?filler=llm&token=dev&callTimeoutMs=4000` | The model through the local proxy (below). |
| `/?filler=none` | Human-only editing: no calls, no ghosts, no patrol. |
| `/?token=<launcher token>` | The token's condition and overrides from the proxy decide everything (G-33). |

Other flags: `?dev=1` shows the dev overlay (last answer, confidence, latency, verdict).
`?fresh=1` ignores the autosave. `?proxy=<url>` sets the proxy base URL (default
`http://localhost:8787`). `?callTimeoutMs=<ms>` sets the client time limit for a call.
Config precedence is `DEFAULT_CONFIG` ← URL params ← `GET /session` overrides.
The `llm` filler needs a session token. Without one the session runs as `none`,
because the proxy would refuse every call. The status strip never names the filler.

### The proxy (model key)

The key never reaches the browser. It is read only by the proxy, from
`VITE_LLM_API_KEY` (or `GEMINI_API_KEY`) in the environment or in `.env.local`:

```bash
export VITE_LLM_API_KEY=...                       # never commit, print or log it
PROXY_OPEN=1 PROXY_THINKING_BUDGET=0 npm run proxy   # http://127.0.0.1:8787, accepts token "dev"
npx tsx proxy/src/tokens-cli.ts add --condition llm --label pilot   # mint a launcher token
```

`PROXY_THINKING_BUDGET=0` matters. With the model's default thinking a call
takes 16–20 s, and with thinking off it takes about 2 s. That is still above
the default `callTimeoutMs` of 900, so for live use pass `?callTimeoutMs=4000`
until a faster model or endpoint is chosen (G-28). Recordings and logs go to
`proxy/.data/` (git-ignored).

## Tests

```bash
npx tsc --noEmit -p .           # typecheck (0 errors expected)
npx vitest run                  # unit + property tests (Node, no browser)
npx tsx prompts/build.ts --check   # prompts/bundle.ts matches the prompt sources
npx vite build                  # production build into dist/
npx tsx proxy/src/keyScan.ts dist  # fails if dist/ contains a key pattern
```

### Browser checks (Playwright + Chromium)

Each script starts its own Vite server on a fixed port and kills it when it finishes.

```bash
node apps/editor/src/__e2e__/loopCheck.cjs     # whole loop with the stub: draw 3 steps → verified ghost → Tab → undo
node apps/editor/src/ghost/__e2e__/ghostCheck.cjs   # ghost layer, captions, keys, Fix, Extend, Play route
node apps/editor/src/editor/__e2e__/bootCheck.cjs http://localhost:5173/   # editor boot / paint / save (needs `npm run dev:editor` or `npm run dev`)
# live model (proxy running as above):
node apps/editor/src/__e2e__/loopCheck.cjs --llm --token dev --timeout 6000
```

Screenshots land in `docs/screens/` (`loop-stub.png`, `loop-llm.png`, `ghost*.png`, `editor*.png`).
`docs/screens/loop-llm.json` records the live run: what was shown, latency and verdicts.

### Offline suite (eval)

`npm run eval` replays recorded `/fill` exchanges (`proxy/.data/recordings`)
through a configuration and scores every answer: schema, coordinates,
validator, rules and agent on the first try, send-back, and confidence. See `eval/src/run.ts`.

## CI

`.github/workflows/pewter-ghost.yml` (repository root) runs on every push or PR
that touches `pewter-ghost/**`. It runs `npm ci`, the typecheck, Vitest, the
prompt-bundle check and a production build. The build gets a **fake** key in
`VITE_LLM_API_KEY`, and the job fails if that key or any `AIza…` pattern shows
up in `dist/`. A second job runs the stub loop check and the ghost layer check
in Chromium.

## Research log

Every session writes a `session` event first. After it come place/erase,
fill.call (superseded calls included, with the request hash, verdict stage and
send-back), ghost.show / ghost.end, patrol, play.start / play.end, undo/redo and
save. Events go to the proxy's `/log` every 5 s and on Save task. Without a
token they stay in the browser: `window.__pewter.app.eventLog.download()`
returns them. `research/completeness.ts` checks a log for missing events.
