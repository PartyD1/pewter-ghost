# Suite run: m-gemini-3.7-flash

- Prompt `fill.v1-e87b351e`; model `gemini-3.7-flash`, window as recorded, summary as recorded, examples off, brief on, confidence stated, samples 1, temperature 0.2, thinking 0, send-back always, agent cap 300 ms, call budget 6000 ms.
- 52 cases (52 scored, 0 skipped, 0 call errors, 0 from cache). Run 2026-10-09T19:41:31.880Z to 2026-10-09T19:42:39.595Z.

## Summary

| measure | value |
|---|---|
| Playability first try (of acting answers) | 82.0% |
| Playable after one send-back | 86.0% |
| Send-back pass rate | 22.2% (9 sent back) |
| Schema ok | 100.0% |
| Coordinate accuracy (all checks) | 86.0% |
| Coordinate item share | 100.0% |
| Validator pass | 90.0% |
| Expectation met (seed labels) | 86.7% of 30 |
| Acted / declined | 50 / 2 |
| Distinct tags per session | 3.3 |
| Tag three times running (violations) | 2 (FAIL) |
| Extends repeating the last two accepted | 0 |
| Tag novelty vs previous answer | 0.77 |
| Latency p50 / p90 | 2630 ms / 3599 ms |
| Within call budget (6000 ms) | 100.0% |
| Stated confidence AUC vs first try | 0.53 |
| Mean stated confidence | 0.84 |
| Prompt / output tokens (mean) | 10352 / 145 |
| Errors / skipped | 0 / 0 |

## First-try verdict by stage

| stage | answers |
|---|---|
| ok | 41 |
| measure | 5 |
| rules | 3 |
| agent | 1 |

Agent over its cap on 0 answer(s) (counted as fails, as in the app).

## Kinds

| kind | answers |
|---|---|
| finish | 40 |
| extend | 4 |
| fix | 6 |

## Variety per session (G-25)

| session | answers | distinct tags | longest run | 3-in-a-row | history repeats | tag novelty |
|---|---|---|---|---|---|---|
| seed-coins | 6 | 5 (coin-arc, pit, rising-steps, risky-coin, wall) | coin-arc x2 | none | 0 | 0.87 |
| seed-enemies | 3 | 1 (tunnel) | tunnel x1 | none | 0 | 1.00 |
| seed-gaps | 6 | 2 (gap-run, pit) | pit x2 | none | 0 | 0.50 |
| seed-maze | 5 | 3 (pillar-hop, tunnel, wall) | tunnel x1 | none | 0 | 0.75 |
| seed-misc | 9 | 2 (gap-run, pit) | pit x1 | none | 0 | 0.75 |
| seed-mixed | 5 | 4 (coin-arc, pit, risky-coin, staircase) | pit x1 | none | 0 | 1.00 |
| seed-patrol | 5 | 4 (gap-run, pillar-hop, pit, rising-steps) | pit x3 | pit x3 | 0 | 0.79 |
| seed-platforms | 5 | 5 (coin-row-on-floor, gap-run, pillar-hop, pit, rising-steps) | rising-steps x2 | none | 0 | 0.88 |
| seed-stairs | 6 | 4 (pit, staircase, tunnel, wall) | staircase x6 | staircase x6 | 0 | 0.40 |

## Stated confidence vs first try

| band | n | first-try rate |
|---|---|---|
| low [0, 0.4) | 0 | n/a |
| mid [0.4, 0.75) | 4 | 100.0% |
| high [0.75, 1) | 46 | 80.4% |

## Cases

| case | mode | act | kind | label | schema | coords | first try | send-back | tags | conf | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stairs-up-2wide | auto | true | finish | staircase, five more steps | ok | ok | measure: gap at x=41 is 1 wide and 7 up; the knight cannot reach 7 rows up | fail | staircase, tunnel | 0.90 | 3204 |
| stairs-up-1wide | auto | true | finish | staircase, 4 more steps | ok | ok | ok |  | staircase | 0.92 | 3109 |
| stairs-down | auto | true | finish | staircase down, two more steps | ok | ok | ok |  | staircase, rest | 0.92 | 3599 |
| stairs-floating-over-pit | auto | true | finish | staircase, continue rising steps | ok | ok | ok |  | staircase, pit | 0.90 | 3489 |
| stairs-two-steps-ambiguous | auto | true | finish | rising platforms, two more | ok | 1 tile group(s) floating out of reach | ok |  | staircase | 0.90 | 2408 |
| stairs-solid-hill | auto | true | finish | staircase, three more steps | ok | ok | ok |  | staircase, rest, wall | 0.85 | 3908 |
| gap-run-3 | auto | true | finish | platform, one more to the right | ok | ok | ok |  | rest, pit | 0.85 | 2681 |
| gap-run-increasing | auto | true | finish | platform row, one more | ok | ok | ok |  | rest, pit | 0.85 | 2449 |
| gap-frontier-long-idle | auto | true | finish | continue grass floor | ok | ok | ok |  | rest | 0.85 | 3202 |
| pit-behind-flat-ahead | auto | true | finish | continue ground to the edge | ok | ok | ok |  | rest | 0.85 | 2364 |
| half-block-hops | auto | true | finish | stepping platforms, continuing pattern | ok | ok | measure: gap at x=47 is 9 wide and 1 down; the knight clears 7 with a 2-tile run-up (7 with a full  | fail | gap-run, pit | 0.88 | 2580 |
| gap-run-mid-stroke | auto | true | finish | finish platform and next jump | ok | ok | ok |  | rest, pit | 0.85 | 2698 |
| pillar-hop | auto | true | finish | two more pillars | ok | 1 tile group(s) floating out of reach | ok |  | gap-run, pillar-hop, pit | 0.85 | 3920 |
| rising-platforms | auto | true | finish | rising steps, two more platforms | ok | 1 tile group(s) floating out of reach | ok |  | rising-steps | 0.90 | 3135 |
| alternating-platforms | auto | true | finish | rising steps, two more platforms | ok | 1 tile group(s) floating out of reach | ok |  | rising-steps, pit | 0.90 | 4055 |
| question-blocks | auto | true | extend | coins above ?-blocks | ok | ok | ok |  | coin-row-on-floor | 0.70 | 1687 |
| platform-under-ceiling | auto | true | finish | platform, four more blocks | ok | ok | rules: blocked at (35,11): there is nothing to land on right of column 35 (going from (31,11) to  | fail | rest, pit | 0.85 | 2034 |
| coin-arcs-next-pit | auto | true | finish | coin arc over the pit | ok | nearest item is 9 tiles from the action (> 8) | ok |  | coin-arc, risky-coin | 0.85 | 2143 |
| coin-arc-partial | auto | true | finish | complete the jump coin arc | ok | ok | ok |  | coin-arc, risky-coin, rest, pit | 0.85 | 2614 |
| coin-ladder-by-wall | auto | true | finish | continue coin ladder up wall | ok | ok | rules: blocked at (33,14): the next surface (34,9) is 0 empty tiles away, 5 higher; the knight cl | pass | wall | 0.75 | 2785 |
| coins-flat-on-floor | auto | true | fix | lift floor coins onto jump arc | ok | ok | ok |  | coin-arc, rest | 0.75 | 2397 |
| risky-coins-over-pits | auto | true | extend | rising steps with slime | ok | ok | ok |  | rest | 0.70 | 1625 |
| fruit-on-high-platform | auto | true | extend | rising steps to higher platform | ok | 1 tile group(s) floating out of reach | ok |  | rising-steps | 0.55 | 3725 |
| tunnel-ceiling | auto | true | finish | ceiling, finish the row | ok | ok | ok |  | rest, tunnel | 0.85 | 2460 |
| vertical-tower | auto | true | finish | half-block platform, rising zigzag | ok | ok | measure: gap at x=15 is 6 wide and 1 down; the knight clears 5 with a 0-tile run-up (7 with a full  | fail | wall | 0.85 | 2301 |
| zigzag-walls | auto | true | finish | next pillar, 5 columns right | ok | ok | measure: gap at x=33 is 5 wide; the knight clears 4 with a 0-tile run-up (7 with a full run-up) | fail | pillar-hop | 0.80 | 2813 |
| wall-with-slot | auto | true | finish | continue wall upward | ok | ok | ok |  |  | 0.75 | 2166 |
| drop-shaft | auto | true | finish | finish half-block platform | ok | ok | ok |  | rest | 0.85 | 2630 |
| patrol-wide-pit | patrol | true | fix | pit 13 wide · knight clears 7 | ok | ok | ok |  | pit | 0.85 | 4051 |
| patrol-tall-wall | patrol | true | fix | wall 7 high · knight rises 3 | ok | ok | ok |  |  | 0.85 | 2842 |
| patrol-high-ledge | patrol | true | fix | climb 8 rows · knight rises 3 | ok | ok | agent: the fix does not get the knight past (31,14): it still cannot reach column 50 (the agent r | fail | rising-steps, pit | 0.85 | 3269 |
| patrol-pit-high-platform | patrol | true | fix | pit too wide, rise too high | ok | ok | ok |  | pit | 0.85 | 2799 |
| patrol-pit-mid-level | patrol | true | fix | pit 15 wide · stepping stones | ok | ok | ok |  | gap-run, pillar-hop, pit | 0.85 | 3376 |
| slime-on-floor | auto | true | finish | continue ground to the right | ok | ok | ok |  | rest | 0.85 | 1962 |
| enemy-gate | auto | true | finish | ceiling platform, five more blocks | ok | ok | ok |  | rest, tunnel | 0.80 | 2728 |
| ultraslime-platform | auto | true | extend | floating stepping stone with fruit | ok | ok | ok |  |  | 0.50 | 2334 |
| fresh-start | auto | true | finish | continue ground forward | ok | ok | ok |  | rest | 0.85 | 2038 |
| erasing | auto | false |  | person is erasing | ok |  |  |  |  | 0.00 | 1589 |
| requested-mid-level | requested | true | finish | rising steps, one more platform | ok | ok | rules: blocked at (45,14): there is nothing to land on right of column 45 (going from (43,14) to  | fail | rest | 0.90 | 2005 |
| send-back-gap | auto | true | finish | platform row, one more | ok | ok | ok |  | rest, pit | 0.88 | 2204 |
| after-accepted-ghost | auto | true | finish | platform, two more tiles | ok | ok | ok |  | rest | 0.90 | 2125 |
| long-flat-run | auto | true | finish | continue ground to edge | ok | ok | ok |  | rest | 0.85 | 3336 |
| question-field | auto | true | finish | finish ?-block row and add one | ok | 1 tile group(s) floating out of reach | ok |  | gap-run | 0.88 | 3119 |
| level-end-flag | auto | true | finish | continue floor to the flag | ok | ok | ok |  | rest | 0.92 | 2713 |
| half-block-bridge | auto | true | finish | half-block platform, 4 more tiles | ok | ok | ok |  | rest, pit | 0.90 | 2708 |
| variety-after-gap-runs | auto | true | finish | continue grass floor | ok | ok | ok |  | rest | 0.85 | 2746 |
| after-dismissals | auto | false |  | platform row was dismissed | ok |  |  |  |  | 0.00 | 2290 |
| mixed-1-gaps | auto | true | finish | platform repeat, one more | ok | ok | ok |  | rest, pit | 0.85 | 2217 |
| mixed-2-steps | auto | true | finish | staircase, four more steps | ok | ok | ok |  | staircase | 0.85 | 2269 |
| mixed-3-high-run | auto | true | finish | continue grass floor, four tiles | ok | ok | ok |  | rest | 0.85 | 1988 |
| mixed-4-coins | auto | true | finish | complete coin arc and landing platform | ok | ok | measure: gap at x=67 is 6 wide; the drawing so far jumps at most 3, so keep gaps to 5 or less here | pass | coin-arc, risky-coin, rest, pit | 0.80 | 3393 |
| mixed-5-extend | auto | true | finish | finish the grass floor | ok | ok | ok |  | rest | 0.85 | 2248 |
