# Suite run: algo

- Prompt `algo`; model `algo`, window as recorded, summary as recorded, examples off, brief on, confidence stated, samples 1, temperature 0.2, thinking 0, send-back always, agent cap 300 ms, call budget 15000 ms.
- 52 cases (52 scored, 0 skipped, 0 call errors, 0 from cache). Run 2026-11-16T22:33:33.009Z to 2026-11-16T22:33:33.306Z.

## Summary

| measure | value |
|---|---|
| Playability first try (of acting answers) | 86.7% |
| Playable after one send-back | 95.6% |
| Send-back pass rate | 66.7% (6 sent back) |
| Schema ok | 100.0% |
| Coordinate accuracy (all checks) | 97.8% |
| Coordinate item share | 100.0% |
| Validator pass | 91.1% |
| Expectation met (seed labels) | 60.0% of 30 |
| Acted / declined | 45 / 7 |
| Distinct tags per session | 2.6 |
| Tag three times running (violations) | 1 (FAIL) |
| Extends repeating the last two accepted | 0 |
| Tag novelty vs previous answer | 0.67 |
| Latency p50 / p90 | 0 ms / 1 ms |
| Within call budget (15000 ms) | 100.0% |
| Stated confidence AUC vs first try | 0.50 |
| Mean stated confidence | 0.68 |
| Prompt / output tokens (mean) | 0 / 0 |
| Errors / skipped | 0 / 0 |

## First-try verdict by stage

| stage | answers |
|---|---|
| ok | 39 |
| measure | 4 |
| rules | 2 |

Agent over its cap on 0 answer(s) (counted as fails, as in the app).

## Kinds

| kind | answers |
|---|---|
| finish | 45 |

## Variety per session (G-25)

| session | answers | distinct tags | longest run | 3-in-a-row | history repeats | tag novelty |
|---|---|---|---|---|---|---|
| seed-coins | 5 | 3 (coin-row-on-floor, rising-steps, wall) | wall x1 | none | 0 | 1.00 |
| seed-enemies | 3 | 1 (tunnel) | tunnel x2 | none | 0 | 0.50 |
| seed-gaps | 6 | 2 (gap-run, pit) | pit x2 | none | 0 | 0.60 |
| seed-maze | 5 | 1 (tunnel) | tunnel x1 | none | 0 | 0.25 |
| seed-misc | 11 | 4 (gap-run, pit, staircase, tunnel) | staircase x1 | none | 0 | 0.90 |
| seed-mixed | 5 | 3 (coin-arc, pit, risky-coin) | pit x1 | none | 0 | 0.75 |
| seed-patrol | 0 | 0 () | - | none | 0 | 0.00 |
| seed-platforms | 5 | 4 (pit, rising-steps, tunnel, wall) | wall x1 | none | 0 | 1.00 |
| seed-stairs | 5 | 3 (pit, staircase, tunnel) | staircase x5 | staircase x5 | 0 | 0.38 |

## Stated confidence vs first try

| band | n | first-try rate |
|---|---|---|
| low [0, 0.4) | 5 | 100.0% |
| mid [0.4, 0.75) | 20 | 80.0% |
| high [0.75, 1) | 20 | 90.0% |

## Cases

| case | mode | act | kind | label | schema | coords | first try | send-back | tags | conf | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stairs-up-2wide | auto | true | finish | two more platforms | ok | ok | ok |  | staircase, tunnel | 0.85 | 5 |
| stairs-up-1wide | auto | true | finish | staircase, three more steps | ok | ok | ok |  | staircase | 0.85 | 1 |
| stairs-down | auto | true | finish | two more platforms | ok | ok | ok |  | staircase, rest | 0.85 | 1 |
| stairs-floating-over-pit | auto | true | finish | two more platforms | ok | ok | measure: gap at x=42 is 10 wide and 6 down; the knight clears 8 with a 1-tile run-up (9 with a full | pass | staircase, pit | 0.85 | 2 |
| stairs-two-steps-ambiguous | auto | true | finish | two more platforms | ok | ok | ok |  | staircase | 0.55 | 1 |
| stairs-solid-hill | auto | false |  | nothing to finish and no room to extend | ok |  |  |  |  | 0.00 | 1 |
| gap-run-3 | auto | true | finish | one more platform | ok | ok | ok |  | rest, pit | 0.55 | 1 |
| gap-run-increasing | auto | true | finish | one more platform | ok | ok | ok |  | rest, pit | 0.55 | 1 |
| gap-frontier-long-idle | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| pit-behind-flat-ahead | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| half-block-hops | auto | true | finish | one more platform | ok | ok | measure: gap at x=47 is 9 wide and 1 down; the knight clears 7 with a 2-tile run-up (8 with a full  | pass | gap-run, pit | 0.55 | 1 |
| gap-run-mid-stroke | auto | true | finish | platform, two more tiles | ok | ok | ok |  | rest | 0.70 | 1 |
| pillar-hop | auto | true | finish | floor across the pit | ok | ok | ok |  | rest, wall | 0.70 | 1 |
| rising-platforms | auto | true | finish | two more platforms | ok | ok | ok |  | rising-steps | 0.85 | 1 |
| alternating-platforms | auto | true | finish | one more platform | ok | ok | measure: gap at x=50 is 10 wide and 7 down; the knight clears 9 with a 2-tile run-up (9 with a full | pass | pit | 0.55 | 0 |
| question-blocks | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest, tunnel | 0.51 | 1 |
| platform-under-ceiling | auto | true | finish | platform, four more tiles | ok | ok | rules: blocked at (35,11): there is nothing to land on right of column 35 (going from (31,11) to  | fail | rest, pit | 0.70 | 0 |
| coin-arcs-next-pit | auto | false |  | nothing to finish and no room to extend | ok |  |  |  |  | 0.00 | 0 |
| coin-arc-partial | auto | true | finish | column, two more tiles | ok | ok | ok |  |  | 0.33 | 1 |
| coin-ladder-by-wall | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest, wall | 0.33 | 1 |
| coins-flat-on-floor | auto | true | finish | coin line, three more | ok | ok | measure: 3 coins at x=46..48 lie flat on the floor (row 14); in a coin level put coins on the arc o | fail | coin-row-on-floor, rest | 0.85 | 1 |
| risky-coins-over-pits | auto | true | finish | column, three more tiles | ok | ok | ok |  |  | 0.33 | 1 |
| fruit-on-high-platform | auto | true | finish | two more platforms | ok | 1 tile group(s) floating out of reach | ok |  | rising-steps | 0.33 | 0 |
| tunnel-ceiling | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest, tunnel | 0.85 | 0 |
| vertical-tower | auto | true | finish | one more platform | ok | ok | ok |  |  | 0.55 | 0 |
| zigzag-walls | auto | true | finish | column, one more tile | ok | ok | ok |  | rest | 0.85 | 1 |
| wall-with-slot | auto | true | finish | column, one more tile | ok | ok | ok |  |  | 0.51 | 0 |
| drop-shaft | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| patrol-wide-pit | patrol | false |  | the algorithm filler does not propose fi | ok |  |  |  |  | 0.00 | 0 |
| patrol-tall-wall | patrol | false |  | the algorithm filler does not propose fi | ok |  |  |  |  | 0.00 | 0 |
| patrol-high-ledge | patrol | false |  | the algorithm filler does not propose fi | ok |  |  |  |  | 0.00 | 0 |
| patrol-pit-high-platform | patrol | false |  | the algorithm filler does not propose fi | ok |  |  |  |  | 0.00 | 0 |
| patrol-pit-mid-level | patrol | false |  | the algorithm filler does not propose fi | ok |  |  |  |  | 0.00 | 0 |
| slime-on-floor | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| enemy-gate | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest, tunnel | 0.51 | 1 |
| ultraslime-platform | auto | true | finish | row, four more tiles | ok | ok | ok |  | tunnel | 0.51 | 0 |
| fresh-start | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| erasing | auto | true | finish | staircase, three more steps | ok | ok | ok |  | staircase | 0.33 | 1 |
| requested-mid-level | requested | true | finish | one more platform | ok | ok | rules: blocked at (45,14): there is nothing to land on right of column 45 (going from (43,14) to  | pass | rest | 0.55 | 0 |
| send-back-gap | auto | true | finish | one more platform | ok | ok | ok |  | rest, pit | 0.55 | 0 |
| after-accepted-ghost | auto | true | finish | platform, two more tiles | ok | ok | ok |  | rest | 0.70 | 0 |
| long-flat-run | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| question-field | auto | true | finish | finish the platform, one more | ok | ok | ok |  | gap-run | 0.55 | 0 |
| level-end-flag | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| half-block-bridge | auto | true | finish | platform, four more tiles | ok | ok | ok |  | rest, pit | 0.70 | 1 |
| variety-after-gap-runs | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| after-dismissals | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest, tunnel | 0.85 | 0 |
| mixed-1-gaps | auto | true | finish | one more platform | ok | ok | ok |  | rest, pit | 0.55 | 0 |
| mixed-2-steps | auto | true | finish | platform, two more tiles | ok | ok | ok |  | rest | 0.70 | 0 |
| mixed-3-high-run | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
| mixed-4-coins | auto | true | finish | coin arc, one more coin | ok | ok | ok |  | coin-arc, risky-coin | 0.85 | 0 |
| mixed-5-extend | auto | true | finish | row, four more tiles | ok | ok | ok |  | rest | 0.85 | 0 |
