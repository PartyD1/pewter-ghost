# Live trials: do ghosts appear with the real model?

2026-10-08, against `74965a4`. Real model `gemini-3.7-flash`, thinking off (`PROXY_THINKING_BUDGET=0`), proxy on :8797 (`PROXY_OPEN=1`), vite on :5341, headless Chromium through Playwright.
Page: `/?token=dev&proxy=http://localhost:8797&fresh=1`, a fresh browser context per trial, `window.__pewter.app.loop.activeFiller === "llm"` in every trial.
Config under test: `maxInFlight 3`, `maxAnswerAgeMs 8000`, `callTimeoutMs 6000`.

The starter level is the full-floor default map (floor top at y=15, start at (2,14)). Tiles were painted through the level model like a person (`beginStroke`, `paint([{x,y,tile:6}], 1)`, `endStroke`), each cell checked empty with `tileAt` first.

**Answer: yes. Ghosts now appear with the real model.** 4 of 6 trials showed a ghost, including the 3-step staircase that showed nothing before. The two trials without a ghost had no correct answer to show: (c) the model declined, and (d) the drop was the one the plan asks for.

## Trials

"ms to ghost" is measured from the last placement, or from Ctrl+Space in (f), to the moment `window.__pewter.ghost.current()` first returned the ghost (polled every 25 ms).

| # | Scenario | Ghost | ms to ghost | Label · kind · confidence | fill.call events (latency, outcome) |
|---|---|---|---|---|---|
| 1 | (a) 3-step staircase up-right, 400 ms/tile | **yes** | 2401 | "staircase, two more steps" · finish · stated 0.85 (logged 1) · cells (9,11),(10,10) | 2216 declined; 2836 declined; **2202 act, verdict ok, shown** |
| 2 | (b) same staircase, 250 ms/tile | **yes** (then replaced) | 2553, then 3207 | "staircase, two more steps" · finish · 1, **trimmed to 1 cell** because (8,12) was painted after the request; replaced by "diagonal stairs, two more steps", 2 cells | 2224 declined; **2535 act, ok, shown (trimmed)**; **2920 act, ok, replaced the first** |
| 3 | (c) 4-tile floating platform, then pause | no | - | - | 1307 aborted: over maxInFlight; 2030 declined; 2327 declined; 6079 timeout after 6000 ms |
| 4 | (d) staircase, then a platform at y=10 x=10..13, over the staircase continuation (10,10) | no (correct) | - | none shown over the new drawing (overlap check: 0 cells) | 4 × ~1.3 s aborted: over maxInFlight; 1909 declined; **3596 act (staircase, 1 tile) dropped `stale: newer declined`**; 3412 declined |
| 5 | (e) 14-wide pit (x=8..21, knight clears 11), then wait for patrol | **yes** | 8190 (patrol idle 3 s + call 3.9 s) | "gap 14 wide · knight clears 11" · fix · 1 · stepping stone (14,15),(15,15) | 4 × ~1.3 s aborted: over maxInFlight; 2821, 2471, 3154 declined (auto); **3911 patrol, act, ok, shown** |
| 6 | (f) two tiles, then Ctrl+Space | **yes** | 3062 after Ctrl+Space | "rising diagonal staircase" · finish · 1 · (8,12),(9,11),(10,11) | 3769 auto declined; **3141 requested, act, ok, shown**; 3828 auto act dropped `stale: newer shown` |

Accept: in trial 1, Tab drew the ghost's cells (9,11) and (10,10) as tile 6 with `authorAt` = **2** (model) for both. Screenshots: `trial-1.png` … `trial-6.png`, and `trial-1-accepted.png` after Tab.

## Latency (28 fill.call events across the 6 trials)

- 16 calls returned an answer: **p50 2821 ms, p90 3769 ms, min 1909, max 3911**.
- 1 timeout at 6000 ms (trial c). 9 calls aborted as `aborted: over maxInFlight`, each about 1.3 s in.
- 2 answers were dropped at reconciliation: `stale: newer declined` in (d) and `stale: newer shown` in (f). In (b), one answer was trimmed to fit and then shown.
- The `fill.call` logs were accurate. Every aborted or dropped call has `superseded: true` and a reason. No call that showed a ghost was logged as superseded.

## What changed against the earlier failure

- Trials 1 and 2 show the fix for Cause 1. The answer to an earlier placement is no longer thrown away by a later one. It is reconciled and shown: trial 1 shows the 3rd call's answer, and trial 2 shows an answer whose request came before the last tile, trimmed by the cell the person had painted since.
- Trial 4 shows that the drop works. The staircase answer arrived 3.6 s later, after the person had moved on to a platform over its cells, and it was not shown.

## What still does not work, or is not right yet

1. **Bursts of 4 or more placements abort calls that were nearly done.** In (c), (d) and (e), placements 400 ms apart with calls taking about 2.5 s keep more than 3 calls in flight. The oldest call is aborted at about 1.3 s, roughly halfway to its answer, and its tokens are already paid for. A 4th placement within one call's latency always costs a call. Options: raise `maxInFlight` to 4, or skip starting a call while 3 are in flight and the newest is under about 1 s old (debounce instead of abort).
2. **The model declines often.** Of 16 answers, 10 were "act: false": 1-2 tile prefixes, the floating platform in (c), and the edits of the pit. That is a prompt or knowledge issue, not plumbing. Trial (c) got no ghost for a plain 4-tile platform.
3. **Timeouts still happen.** One call in (c) ran past 6000 ms. Measured p90 here is 3.8 s, so 6 s holds, but the earlier tail of 5-11 s means some answers will still be lost.
4. **The logged confidence differs from the stated one.** In trial 1 the model stated 0.85 (also in `proxy/.data/recordings`), and `fill.call` / `ghost.show` logged confidence 1 (the verified value). Worth checking that the dashboard reads the field it means to.
5. **The Fix ghost's caption is wrong for an add-only fix.** In trial 5 it says "crossed-out tiles would go" although the fix only adds tiles. This is in `src/ghost/**` presentation, which belongs to the restyle team.
6. **These are not problems with the fill loop. They come from the restyle in progress:**
   - Vite reloaded open pages whenever the restyle team saved a file. The trials mock the HMR websocket so a page stays put once loaded.
   - Trials 2-6 ran against uncommitted restyle files. They logged a page error, `chrome.toolbar is not a function`, and the toolbar and palette are missing from those screenshots. Fills and ghosts were not affected.
   - There is no chat panel in the running page (`.pt-chatbox` absent), as PLAN.md §4 requires ("No chat"). `src/legacy/chatbox.css` and a `.pt-chatbox` lookup in `src/editor/camera.ts` were ported back by the restyle commits `4ad62e3`/`8b8bb90`. They are dead weight for the restyle team to remove.

## Reproduce

Start the proxy and vite as above. Then run the Playwright script that drove these trials: paint the cells with a pause between each, poll `__pewter.ghost.current()`, and read `__pewter.app.eventLog.events()`. Mock the vite HMR websocket (`context.routeWebSocket(/localhost:5341/, () => {})`) while other people are editing the source.
