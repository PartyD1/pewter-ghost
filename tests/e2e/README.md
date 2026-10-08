# End-to-end suite (G-07 harness, G-32 latency contracts)

```
npx playwright test -c tests/e2e/playwright.config.ts          # or: npm run test:e2e
npx playwright test -c tests/e2e/playwright.config.ts latency  # one spec
```

The config starts Vite on a free port (set `PG_E2E_PORT` to pin one) and uses the Chromium in
`$PLAYWRIGHT_BROWSERS_PATH` (default `/opt/pw-browsers`; `PG_E2E_CHROMIUM` overrides). One worker:
the latency specs measure wall-clock time.

No model, key or proxy process is involved. `support/proxyMock.ts` answers the proxy's endpoints
with `page.route`: `GET /session` (condition and overrides per spec), `POST /fill` (a recorded
`ProxyFillResponse` from `fixtures/*.json`, after a chosen delay) and `POST /log`. The editor is
opened with `?proxy=http://pewter-proxy.e2e.test&token=e2e-token`.

Fixtures keep the model's window-relative coordinates plus the window origin they were recorded at
(`recordedOrigin`); replay shifts them onto the live request's window, so the same level cells come
back. `fixtureFromRecording()` turns a line of `proxy/.data/recordings/<session>.jsonl` into a
fixture. `specs/replay.spec.ts` checks every fixture against the editor's own answer parser.

| Spec | Covers |
| --- | --- |
| smoke | boot, session, research log to `/log`, no console errors |
| painting | strokes, modes, strokes stop over the UI, undo / redo |
| saveload | Save task v2 and Load, v1 import, broken file, share code round trip |
| ghost-keys | Tab, Esc, Ctrl+Space, paint-on-ghost partial, draw elsewhere dismisses |
| patrol-fix | unbeatable level gets a patrol Fix after idle; Fix with removals and one undo |
| condition-none | no `/fill` calls, no patrol, no ghost |
| latency | the three §24 latency-budget contracts |
| replay | the harness: fixtures, rebasing, recordings |

Latency contract 1 reads "within 200 ms of the third placement" as 200 ms of client time on top of
the debounce and the model's round trip (see the header of `specs/latency.spec.ts`): with one call in
flight and newest wins, the third placement's answer cannot arrive before `fillDebounceMs + 500 ms`.
