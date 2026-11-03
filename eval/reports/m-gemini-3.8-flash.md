# Suite run: m-gemini-3.8-flash

- Prompt `fill.v1-e87b351e`; model `gemini-3.8-flash`, window as recorded, summary as recorded, examples off, brief on, confidence stated, samples 1, temperature 0.2, thinking 0, send-back always, agent cap 300 ms, call budget 6000 ms.
- 52 cases (52 scored, 0 skipped, 0 call errors, 0 from cache). Run 2026-10-09T19:42:45.343Z to 2026-10-09T19:44:14.389Z.

## Summary

| measure | value |
|---|---|
| Playability first try (of acting answers) | 83.7% |
| Playable after one send-back | 85.7% |
| Send-back pass rate | 12.5% (8 sent back) |
| Schema ok | 100.0% |
| Coordinate accuracy (all checks) | 85.7% |
| Coordinate item share | 99.7% |
| Validator pass | 91.8% |
| Expectation met (seed labels) | 83.3% of 30 |
| Acted / declined | 49 / 3 |
| Distinct tags per session | 3.2 |
| Tag three times running (violations) | 2 (FAIL) |
| Extends repeating the last two accepted | 0 |
| Tag novelty vs previous answer | 0.78 |
| Latency p50 / p90 | 3002 ms / 5104 ms |
| Within call budget (6000 ms) | 94.2% |
| Stated confidence AUC vs first try | 0.34 |
| Mean stated confidence | 0.84 |
| Prompt / output tokens (mean) | 10352 / 139 |
| Errors / skipped | 0 / 0 |

## First-try verdict by stage

| stage | answers |
|---|---|
| ok | 41 |
| measure | 4 |
| agent | 2 |
| rules | 2 |

Agent over its cap on 1 answer(s) (counted as fails, as in the app).

## Kinds

| kind | answers |
|---|---|
| finish | 40 |
| fix | 7 |
| extend | 2 |

## Variety per session (G-25)

| session | answers | distinct tags | longest run | 3-in-a-row | history repeats | tag novelty |
|---|---|---|---|---|---|---|
| seed-coins | 5 | 4 (coin-arc, pit, risky-coin, wall) | coin-arc x2 | none | 0 | 0.83 |
| seed-enemies | 3 | 1 (tunnel) | tunnel x1 | none | 0 | 1.00 |
| seed-gaps | 6 | 2 (gap-run, pit) | pit x2 | none | 0 | 0.50 |
| seed-maze | 5 | 3 (pillar-hop, tunnel, wall) | tunnel x1 | none | 0 | 0.75 |
| seed-misc | 9 | 2 (gap-run, pit) | pit x1 | none | 0 | 0.75 |
| seed-mixed | 5 | 4 (coin-arc, pit, risky-coin, staircase) | pit x1 | none | 0 | 1.00 |
| seed-patrol | 5 | 4 (gap-run, pillar-hop, pit, rising-steps) | pit x3 | pit x3 | 0 | 0.79 |
| seed-platforms | 5 | 5 (coin-row-on-floor, gap-run, pillar-hop, pit, rising-steps) | gap-run x1 | none | 0 | 1.00 |
| seed-stairs | 6 | 4 (pit, staircase, tunnel, wall) | staircase x6 | staircase x6 | 0 | 0.40 |

## Stated confidence vs first try

| band | n | first-try rate |
|---|---|---|
| low [0, 0.4) | 0 | n/a |
| mid [0.4, 0.75) | 3 | 100.0% |
| high [0.75, 1) | 46 | 82.6% |

## Cases

| case | mode | act | kind | label | schema | coords | first try | send-back | tags | conf | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stairs-up-2wide | auto | true | finish | staircase, four more steps | ok | ok | measure: gap at x=41 is 1 wide and 7 up; the knight cannot reach 7 rows up | fail | staircase, tunnel | 0.90 | 2967 |
| stairs-up-1wide | auto | true | finish | staircase, three more steps | ok | ok | ok |  | staircase | 0.92 | 2959 |
| stairs-down | auto | true | finish | staircase down to the floor | ok | ok | ok |  | staircase, rest | 0.90 | 7599 |
| stairs-floating-over-pit | auto | true | finish | staircase, continue rising steps | ok | ok | agent: the playtest agent found no way from (37,10) to column 52 within 300 ms; it got as far as  | fail | staircase, pit | 0.90 | 3571 |
| stairs-two-steps-ambiguous | auto | true | finish | rising platforms, two more | ok | 1 tile group(s) floating out of reach | ok |  | staircase | 0.85 | 2415 |
| stairs-solid-hill | auto | true | finish | staircase slope, four more steps | ok | ok | ok |  | staircase, rest, wall | 0.85 | 4656 |
| gap-run-3 | auto | true | finish | repeat platform across gap | ok | ok | ok |  | rest, pit | 0.90 | 2369 |
| gap-run-increasing | auto | true | finish | platform, one more across gap | ok | ok | ok |  | rest, pit | 0.90 | 3948 |
| gap-frontier-long-idle | auto | true | finish | continue ground to right edge | ok | ok | ok |  | rest | 0.85 | 4586 |
| pit-behind-flat-ahead | auto | true | finish | finish the floor | ok | ok | ok |  | rest | 0.85 | 3811 |
| half-block-hops | auto | true | finish | half-block platform, one lower | ok | ok | measure: gap at x=47 is 9 wide and 1 down; the knight clears 7 with a 2-tile run-up (7 with a full  | fail | gap-run, pit | 0.85 | 2774 |
| gap-run-mid-stroke | auto | true | finish | gap run, continue platforms | ok | ok | ok |  | rest, pit | 0.85 | 3002 |
| pillar-hop | auto | true | finish | continue pillar hop pattern | ok | 1 tile group(s) floating out of reach | ok |  | gap-run, pillar-hop, pit | 0.85 | 3938 |
| rising-platforms | auto | true | finish | rising steps, two more platforms | ok | 1 tile group(s) floating out of reach | ok |  | rising-steps | 0.90 | 4211 |
| alternating-platforms | auto | true | finish | alternating platforms, two more | ok | 1 tile group(s) floating out of reach | ok |  | pit | 0.85 | 2378 |
| question-blocks | auto | true | finish | more coins over question blocks | ok | ok | ok |  | coin-row-on-floor | 0.75 | 2131 |
| platform-under-ceiling | auto | true | finish | platform, 4 more blocks | ok | ok | rules: blocked at (35,11): there is nothing to land on right of column 35 (going from (31,11) to  | fail | rest, pit | 0.90 | 1749 |
| coin-arcs-next-pit | auto | true | finish | coin arc over gap | ok | nearest item is 9 tiles from the action (> 8) | ok |  | coin-arc, risky-coin | 0.85 | 21770 |
| coin-arc-partial | auto | true | finish | complete the coin arc over the pit | ok | ok | ok |  | coin-arc, risky-coin, rest, pit | 0.85 | 3063 |
| coin-ladder-by-wall | auto | true | fix | wall 5 high · knight rises 3 | ok | 1 item(s) on occupied cells (or removes on empty ones) | ok |  | rest, wall | 0.75 | 5669 |
| coins-flat-on-floor | auto | true | fix | lift floor coins onto jump arc | ok | ok | ok |  | coin-arc, rest | 0.70 | 1987 |
| risky-coins-over-pits | auto | false |  | waiting after dismissal and recent place | ok |  |  |  |  | 0.00 | 1636 |
| fruit-on-high-platform | auto | true | extend | rising-steps, next platform | ok | ok | ok |  |  | 0.55 | 3408 |
| tunnel-ceiling | auto | true | finish | ceiling, continue row | ok | ok | ok |  | rest, tunnel | 0.85 | 3906 |
| vertical-tower | auto | true | finish | half-block platform, rising zig-zag | ok | ok | measure: gap at x=15 is 6 wide and 1 down; the knight clears 5 with a 0-tile run-up (7 with a full  | fail | wall | 0.85 | 4838 |
| zigzag-walls | auto | true | finish | fourth pillar to continue pillar-hop | ok | ok | ok |  | pillar-hop, rest | 0.80 | 3160 |
| wall-with-slot | auto | true | finish | continue wall upward | ok | ok | ok |  |  | 0.80 | 3311 |
| drop-shaft | auto | true | finish | finish half-block platform | ok | ok | ok |  | rest | 0.88 | 3940 |
| patrol-wide-pit | patrol | true | fix | pit 13 wide · knight clears 7 | ok | ok | ok |  | pit | 0.85 | 12291 |
| patrol-tall-wall | patrol | true | fix | wall 7 high · knight rises 3 | ok | ok | ok |  |  | 0.80 | 2758 |
| patrol-high-ledge | patrol | true | fix | stepping platforms to reach upper floor | ok | ok | agent: the fix does not get the knight past (31,14): it still cannot reach column 50 (the agent r | fail | rising-steps, pit | 0.85 | 5104 |
| patrol-pit-high-platform | patrol | true | fix | rise 7 to platform · knight rises 3 | ok | ok | ok |  | pit | 0.85 | 5802 |
| patrol-pit-mid-level | patrol | true | fix | stepping stones across gap 15 | ok | ok | ok |  | gap-run, pillar-hop, pit | 0.85 | 2232 |
| slime-on-floor | auto | true | finish | continue ground with dirt fill | ok | ok | ok |  | rest | 0.85 | 2663 |
| enemy-gate | auto | true | finish | ceiling, five more blocks | ok | ok | ok |  | rest, tunnel | 0.80 | 2309 |
| ultraslime-platform | auto | true | extend | step up to upper platform | ok | ok | ok |  | rest | 0.50 | 2353 |
| fresh-start | auto | true | finish | continue ground to the right | ok | ok | ok |  | rest | 0.85 | 4301 |
| erasing | auto | false |  | person is erasing | ok |  |  |  |  | 0.00 | 2751 |
| requested-mid-level | requested | true | finish | rising steps, one more platform | ok | ok | rules: blocked at (45,14): there is nothing to land on right of column 45 (going from (43,14) to  | fail | rest | 0.85 | 1968 |
| send-back-gap | auto | true | finish | platform row, one more | ok | ok | ok |  | rest, pit | 0.85 | 4680 |
| after-accepted-ghost | auto | true | finish | platform, two more tiles | ok | ok | ok |  | rest | 0.90 | 2502 |
| long-flat-run | auto | true | finish | continue flat grass ground | ok | ok | ok |  | rest | 0.85 | 3987 |
| question-field | auto | true | finish | row of question blocks | ok | 1 tile group(s) floating out of reach | ok |  | gap-run | 0.85 | 1895 |
| level-end-flag | auto | true | finish | finish floor to flag | ok | ok | ok |  | rest | 0.90 | 2489 |
| half-block-bridge | auto | true | finish | half-block platform, four more tiles | ok | ok | ok |  | rest, pit | 0.85 | 2743 |
| variety-after-gap-runs | auto | true | finish | finish grass row to the right | ok | ok | ok |  | rest | 0.85 | 2978 |
| after-dismissals | auto | false |  | platform row was dismissed | ok |  |  |  |  | 0.00 | 4698 |
| mixed-1-gaps | auto | true | finish | continue platform pattern | ok | ok | ok |  | rest, pit | 0.85 | 1768 |
| mixed-2-steps | auto | true | finish | finish staircase, four more steps | ok | ok | ok |  | staircase | 0.85 | 2372 |
| mixed-3-high-run | auto | true | finish | continue flat grass runway | ok | ok | ok |  | rest | 0.85 | 2144 |
| mixed-4-coins | auto | true | finish | complete coin arc and landing platform | ok | ok | measure: gap at x=67 is 6 wide; the drawing so far jumps at most 3, so keep gaps to 5 or less here | pass | coin-arc, risky-coin, rest, pit | 0.85 | 3246 |
| mixed-5-extend | auto | true | finish | continue floor to the right | ok | ok | ok |  | rest | 0.85 | 3013 |
