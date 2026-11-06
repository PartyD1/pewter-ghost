# Pewter Ghost proxy (G-09, G-33)

Holds the model key, pins the model, checks session tokens, rate-limits, and
records every /fill exchange so the offline suite can replay it.

## Run locally

```bash
# key in env or in pewter-ghost/.env(.local): VITE_LLM_API_KEY=...  (never printed)
PROXY_OPEN=1 npm run proxy          # http://127.0.0.1:8787, accepts token "dev"
npx tsx proxy/src/tokens-cli.ts add --condition llm --label pilot   # prints a launcher URL
```

Files (git-ignored) under `proxy/.data/`:
- `tokens.json` — `{ "tokens": { "<token>": { "condition": "llm|algo|none|stub", "sessionId": "p01", "overrides": {…}, "label": "…", "expiresAt": "…", "disabled": false } } }`
- `recordings/<sessionId>.jsonl` — one `Recording` per /fill (contracts.ts)
- `logs/<sessionId>.jsonl` — research events from /log; invalid ones go to `<sessionId>.rejected.jsonl`

## Routes

| Route | Auth | Body / result |
|---|---|---|
| `GET /health` | none | `{ ok, model, time }` |
| `GET /session?token=` | query or Bearer | `ProxySessionResponse` (condition + overrides; dev token mints `dev.<id>`) |
| `POST /fill` | Bearer | `ProxyFillBody` → `ProxyFillResponse`; upstream failure = 200 with `answer:null, error` |
| `POST /log` | Bearer or `?token=` (sendBeacon) | `ProxyLogBody` → `{ ok, accepted, rejected[] }` |

Errors: 401 bad/missing/expired token · 403 condition not `llm` (fill) or sessionId not the token's ·
400 bad body · 413 too large · 429 rate limit (`Retry-After`). Limits per token: /fill 120/min, /log 60/min (burst 30), /session 30/min.

A token's sessionId `p01` also admits `p01.<suffix>` so one token can hold several runs.

## Env

`LLM_PROVIDER` = `gemini` | `openrouter` | `bayleaf` (unset: the first with a key, in that order; see `src/provider.ts`).
Gemini: `VITE_LLM_API_KEY` / `GEMINI_API_KEY`, `VITE_LLM_MODEL_NAME` (default `gemini-3.7-flash`).
OpenRouter: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `z-ai/glm-5.3-flash`).
BayLeaf: `BAYLEAF_API_KEY` (default `campus`, UCSC network only), `BAYLEAF_MODEL` (default `openrouter:z-ai/glm-5.3-flash`).
OpenRouter and BayLeaf share `src/openrouter.ts` (chat/completions; `json_schema` output, stepping down to
`json_object` then plain text if a model rejects it). `PROXY_THINKING_BUDGET=0` is sent as
`reasoning: { enabled: false }`; `PROXY_REASONING_EFFORT` as `reasoning: { effort }`.
Shared:
`PROXY_READ_SECRET` (the shared lab password for the replay read API below; unset = reading is off),
`PROXY_OPEN=1`, `PROXY_PORT`, `PROXY_HOST`, `PROXY_ALLOWED_ORIGINS` (dev) / `ALLOWED_ORIGINS` (worker),
`PROXY_UPSTREAM_TIMEOUT_MS` (10000), `PROXY_THINKING_BUDGET` (unset = not sent), `PROXY_LOGPROBS=0`.

`responseLogprobs` is requested by default and turned off for the process if the API rejects it.

## Replay read API (researchers)

Participants write their session log through `POST /log`. Researchers read it back:

```
GET /replay/sessions[?limit=60]  -> { sessions: [{ sessionId, events, durationMs, startedAt, hasReplay, filler, bytes }], total }
                                    newest first; `hasReplay` is false for logs from before replay existed
GET /replay/sessions/<id>        -> the session's JSONL log (application/x-ndjson, never cached)
```

Both need `Authorization: Bearer <PROXY_READ_SECRET>`, the shared lab password. A participant token
cannot read anything. With no `PROXY_READ_SECRET` set the routes answer 503. Wrong passwords are throttled
per client (8 per minute, then a one-minute lockout even for the right password); reads are rate limited.
Add the viewer's origin to `ALLOWED_ORIGINS` / `PROXY_ALLOWED_ORIGINS`.

The viewer is the page at **`/replay`** (built beside the editor; `/replay/` on a static host). On the machine
running `npm run dev` it needs nothing: it signs in with the local password (`dev`) and lists the newest
sessions with a "Watch the latest session" button. Elsewhere open `/replay?api=<proxy url>`, type the lab
password, and pick a session. `#<sessionId>` (add `@<ms>` to land on a moment) opens one directly.

## Firebase (session logs)

Set `FIREBASE_SERVICE_ACCOUNT_FILE` (local) or `FIREBASE_SERVICE_ACCOUNT` (Worker secret) and the proxy keeps
**session logs in Cloud Firestore**; recordings for the eval suite, rejected events and Jev exchanges stay
where they were (proxy/.data, KV or R2). The proxy is the only thing that talks to Firestore (service
account over REST, so no Firebase key reaches a browser and `firestore.rules` denies every client).

```
sessions/{sessionId}                one summary per session: events, bytes, firstT, lastT, startedAt, replayFlag, filler
sessions/{sessionId}/chunks/{id}    the log itself, whole JSONL lines, <= 700 KB per document
```

The summary is what makes the replay list fast: one ordered query, no logs downloaded.

Setup (once): Firebase console -> your project -> Build -> Firestore Database -> Create database (production
mode is right; the rules in `firestore.rules` deny clients and the service account bypasses them). Then
Project settings -> Service accounts -> Generate new private key, save the `.json` somewhere that is not in
git (the repo ignores `*firebase-adminsdk*.json`, `firebase-key*.json`, `service-account*.json`), and put its
path in `.env`: `FIREBASE_SERVICE_ACCOUNT_FILE=./firebase-key.json`. `npm run dev` then prints
`session logs go to Firebase project "<id>"`. For a Worker:
`npx wrangler secret put FIREBASE_SERVICE_ACCOUNT < firebase-key.json`. To deploy the rules:
`npx firebase-tools deploy --only firestore:rules`. Local emulator (Java 11+):
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` with `npx firebase-tools emulators:start --only firestore`.

Tested against a stand-in for Firestore's REST API (proxy/src/__fixtures__/fakeFirestore.ts) that checks the
token signature, write preconditions and transforms; it has not been run against a live project in CI.

## Worker

`src/worker.ts` exports `default { fetch }`. Bind KV as `PEWTER_KV` (tokens under `tokens/<token>`,
recordings/logs as append chunks) or R2 as `PEWTER_R2`. See `wrangler.toml.example`.

## Checks

`npx tsx proxy/src/keyScan.ts dist` fails if a Google key pattern or the configured key is in the bundle.
