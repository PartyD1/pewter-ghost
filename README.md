# Pewter Ghost

An autofill for a 2D platformer level editor. As you paint, a model proposes the
next stretch of the level as a faint **ghost**: finish the staircase you started,
continue a platform past a gap, or repair a jump the knight cannot make.
**Tab** keeps the ghost, **Esc** (or carrying on drawing) dismisses it,
**Ctrl+Space** asks for one, and **Alt+]** / **Alt+[** cycle between choices when
there is more than one. Every ghost is checked before you see it: a validator and
a physics-exact playtest agent (the same knight as Play mode) must both pass it.
Nothing unverified ever reaches the screen.

It is the research successor to the Pewter editor (see [ORIGIN.md](ORIGIN.md)):
Phaser 3.90 + TypeScript + Vite, with a small proxy that holds the model key.
Contributor conventions are in [CLAUDE.md](CLAUDE.md) and [docs/BUILDERS.md](docs/BUILDERS.md);
changes to contracts and behavior are logged in [docs/decisions.md](docs/decisions.md).
Comments in the code cite work-item IDs (`G-01`..`G-38`) from the original design
plan, which is no longer in the tree: `git show c9c7a7e:docs/PLAN.md`.

```
placements ─► PlacementStream ─► FillRequest (ASCII window + brief + measured numbers)
   ─► Filler (llm via proxy | stub | algo | markov | none) ─► reconcile against the current level
   ─► verify (validator, rule check, agent, one send-back) ─► SuggestionManager ─► ghost layer
idle ─► patrol (agent plays start → frontier) ─► blocked? ─► Fix ghost (model, else ≤3-tile local repair)
```

The loop is wired in `apps/editor/src/session.ts` (`FillLoop` has no Phaser; `PewterApp` is the boot glue `main.ts` creates).

## Layout

| Path | What |
|---|---|
| `apps/editor/src/level` | `LevelModel`: grid, entities, authorship (person / ghost), command undo, save v2 |
| `apps/editor/src/editor`, `ui`, `styles` | Phaser scenes, painting, Select tool, camera, Play mode, toolbar, palette, dialogs, CSS |
| `apps/editor/src/player`, `entities` | The frame-rate-independent knight; time-based enemies |
| `apps/editor/src/fill` | Placement stream, window builder, prompt v1, design brief, fillers |
| `apps/editor/src/verify` | Validator, playability check, send-back pipeline, patrol + local repair |
| `apps/editor/src/suggest` | `SuggestionManager` (when to show), timing policies, **`config.ts` (every tunable)** |
| `apps/editor/src/ghost` | Ghost layer, captions, keys, dev overlay |
| `apps/editor/src/research`, `replay` | Event log (`/log`), schema, completeness checker; the session replay viewer at `/replay` |
| `packages/physsim` | Playtest agent (Arcade physics re-implementation + A*), rule check, Web Worker |
| `packages/jump-tables` | Exact jump reach tables from the jump solver |
| `packages/measure`, `packages/chunks` | Level measures and pattern tags; chunk generator |
| `prompts/` | Prompt v1, brief fragments, few-shots, reference sections (bundled into `prompts/bundle.ts`) |
| `proxy/` | Key-holding proxy: tokens, `/session`, `/fill`, `/log`, recordings ([proxy/README.md](proxy/README.md)) |
| `eval/` | Offline suite: replays recorded requests and scores answers ([eval/README.md](eval/README.md)) |
| `levels/` | Reference level library (own build and tests, see [levels/README.md](levels/README.md)) |

## Run it

Node 22 and npm. From the repository root:

```bash
cp .env.example .env            # put your model key in .env (GEMINI_API_KEY=...); never commit it
npm install
npm run dev                     # proxy and editor together
```

Open http://localhost:5173. Ghosts appear on the canvas as you draw; there is no chat.
`npm run dev` refuses to start without a model key. `npm run dev:editor` starts the
editor alone, with no AI, for working on the editor itself.

The model provider can be Gemini, [OpenRouter](https://openrouter.ai/) or [BayLeaf](https://api.bayleaf.dev/)
(free for UCSC; no key needed on the UCSC network). Set `LLM_PROVIDER` in `.env`
(`.env.example` lists each provider's key and model), or choose for one run with
`npm run dev -- bayleaf` (or `openrouter`, `gemini`).

In development a plain reload starts a fresh level (handy for testing); `?restore=1`
brings back the autosave. A built copy restores the autosave on every reload, so a
participant never loses work. The editor also has a **New level** action in Help and a
**Level goal** dialog that tells the model what you are building.

### URL switches

| URL | What you get |
|---|---|
| `/?filler=stub&dev=1` | Deterministic staircase filler; no network. Good for trying the loop. |
| `/?token=dev&callTimeoutMs=4000` | The model through the local proxy. |
| `/?filler=none` | Human-only editing: no calls, no ghosts, no patrol. |
| `/?token=<launcher token>` | The token's condition and overrides from the proxy decide everything. |
| `&timing=cdhf\|jev\|always` | Suggestion timing policy (default `llm`; see `suggest/timing/policy.ts`). |

Other flags: `?dev=1` shows the dev overlay and the live filler / timing switch,
`?fresh=1` ignores the autosave, `?proxy=<url>` sets the proxy base URL (default
`http://localhost:8787`), `?trace=1` echoes recorded input to the console.
Config precedence is `DEFAULT_CONFIG` ← URL params ← `GET /session` overrides.
The `llm` filler needs a session token; without one the session runs as `none`.

### The proxy (model key)

The key never reaches the browser. Only the proxy reads it, from `GEMINI_API_KEY` /
`VITE_LLM_API_KEY` in the environment or `.env`:

```bash
PROXY_OPEN=1 PROXY_THINKING_BUDGET=0 npm run proxy   # http://127.0.0.1:8787, accepts token "dev"
npx tsx proxy/src/tokens-cli.ts add --condition llm --label pilot   # mint a launcher token
```

Recordings and logs go to `proxy/.data/` (git-ignored). Provider latency matters a
great deal for whether ghosts arrive: see the timeout notes in `docs/decisions.md`
and the benchmark in `eval/README.md`.

## Tests and checks

```bash
npm run typecheck               # tsc --noEmit
npm test                        # Vitest: unit and property tests (Node, no browser)
npm run test:e2e                # Playwright suite (tests/e2e), proxy mocked
npx tsx prompts/build.ts --check   # prompts/bundle.ts matches the prompt sources
npm run build                   # typecheck + production build into dist/
npx tsx proxy/src/keyScan.ts dist  # fails if dist/ contains a key pattern
npm run eval -- help            # offline suite: replays recorded /fill exchanges and scores them
```

Standalone browser scripts (they write screenshots to the git-ignored `docs/screens/`):

```bash
node apps/editor/src/__e2e__/loopCheck.cjs        # whole loop with the stub: draw 3 steps → verified ghost → Tab → undo
node apps/editor/src/ghost/__e2e__/ghostCheck.cjs # ghost layer, captions, keys, Fix, Extend
node apps/editor/src/editor/__e2e__/bootCheck.cjs http://localhost:5173/   # editor boot / paint / Play (needs a running dev server)
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, the typecheck, Vitest, the prompt-bundle
check, a production build with a **canary** key that must not appear in `dist/`, and the
browser checks.

## Research log and replay

Every session writes a `session` event first. After it come place/erase, `fill.call`
(superseded calls included), `ghost.show` / `ghost.end`, patrol, `play.start` / `play.end`,
undo/redo, and the raw input, camera and level changes needed to watch a session back.
Events go to the proxy's `/log` (to Firebase when configured, see `proxy/README.md`).
`research/completeness.ts` checks a log for missing events. Without a token the log stays
in the browser (`pewterLog.download()` in the console returns it as JSONL).

The replay viewer is served at **`/replay`** (dev: http://localhost:5173/replay). It lists
sessions held by the proxy and replays any of them with the model never involved.
