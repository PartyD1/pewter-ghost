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

`VITE_LLM_API_KEY` / `GEMINI_API_KEY`, `VITE_LLM_MODEL_NAME` (default `gemini-3.7-flash`),
`PROXY_OPEN=1`, `PROXY_PORT`, `PROXY_HOST`, `PROXY_ALLOWED_ORIGINS` (dev) / `ALLOWED_ORIGINS` (worker),
`PROXY_UPSTREAM_TIMEOUT_MS` (10000), `PROXY_THINKING_BUDGET` (unset = not sent), `PROXY_LOGPROBS=0`.

`responseLogprobs` is requested by default and turned off for the process if the API rejects it.

## Worker

`src/worker.ts` exports `default { fetch }`. Bind KV as `PEWTER_KV` (tokens under `tokens/<token>`,
recordings/logs as append chunks) or R2 as `PEWTER_R2`. See `wrangler.toml.example`.

## Checks

`npx tsx proxy/src/keyScan.ts dist` fails if a Google key pattern or the configured key is in the bundle.
