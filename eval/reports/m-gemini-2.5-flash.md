# Suite run: m-gemini-2.5-flash

- Prompt `fill.v1-e87b351e`; model `gemini-2.5-flash`, window as recorded, summary as recorded, examples off, brief on, confidence stated, samples 1, temperature 0.2, thinking 0, send-back always, agent cap 300 ms, call budget 6000 ms.
- 52 cases (52 scored, 0 skipped, 0 call errors, 0 from cache). Run 2026-10-09T19:40:53.819Z to 2026-10-09T19:41:29.293Z.

## Summary

| measure | value |
|---|---|
| Playability first try (of acting answers) | 74.5% |
| Playable after one send-back | 74.5% |
| Send-back pass rate | 0.0% (13 sent back) |
| Schema ok | 100.0% |
| Coordinate accuracy (all checks) | 86.3% |
| Coordinate item share | 98.0% |
| Validator pass | 82.4% |
| Expectation met (seed labels) | 83.3% of 30 |
| Acted / declined | 51 / 1 |
| Distinct tags per session | 2.4 |
| Tag three times running (violations) | 1 (FAIL) |
| Extends repeating the last two accepted | 0 |
| Tag novelty vs previous answer | 0.69 |
| Latency p50 / p90 | 1077 ms / 1826 ms |
| Within call budget (6000 ms) | 100.0% |
| Stated confidence AUC vs first try | 0.65 |
| Mean stated confidence | 0.84 |
| Prompt / output tokens (mean) | 10352 / 157 |
| Errors / skipped | 0 / 0 |

## First-try verdict by stage

| stage | answers |
|---|---|
| ok | 38 |
| measure | 5 |
| shape | 4 |
| rules | 4 |

Agent over its cap on 0 answer(s) (counted as fails, as in the app).

## Kinds

| kind | answers |
|---|---|
| finish | 39 |
| extend | 7 |
| fix | 5 |

## Variety per session (G-25)

| session | answers | distinct tags | longest run | 3-in-a-row | history repeats | tag novelty |
|---|---|---|---|---|---|---|
| seed-coins | 6 | 1 (wall) | wall x1 | none | 0 | 0.40 |
| seed-enemies | 3 | 1 (tunnel) | tunnel x2 | none | 0 | 0.50 |
| seed-gaps | 6 | 2 (gap-run, pit) | pit x2 | none | 0 | 0.60 |
| seed-maze | 5 | 2 (tunnel, wall) | tunnel x1 | none | 0 | 0.75 |
| seed-misc | 10 | 3 (gap-run, pit, tunnel) | pit x1 | none | 0 | 0.78 |
| seed-mixed | 5 | 3 (coin-arc, pit, risky-coin) | pit x1 | none | 0 | 0.75 |
| seed-patrol | 5 | 2 (pit, wall) | pit x2 | none | 0 | 0.75 |
| seed-platforms | 5 | 4 (pit, rising-steps, tunnel, wall) | wall x1 | none | 0 | 1.00 |
| seed-stairs | 6 | 4 (pit, staircase, tunnel, wall) | staircase x3 | staircase x3 | 0 | 0.70 |

## Stated confidence vs first try

| band | n | first-try rate |
|---|---|---|
| low [0, 0.4) | 0 | n/a |
| mid [0.4, 0.75) | 7 | 57.1% |
| high [0.75, 1) | 44 | 77.3% |

## Cases

| case | mode | act | kind | label | schema | coords | first try | send-back | tags | conf | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stairs-up-2wide | auto | true | finish | staircase, six more steps | ok | ok | measure: gap at x=41 is 1 wide and 7 up; the knight cannot reach 7 rows up | fail | staircase, tunnel | 0.90 | 1733 |
| stairs-up-1wide | auto | true | finish | staircase, three more steps | ok | ok | ok |  | staircase | 0.90 | 1456 |
| stairs-down | auto | true | finish | staircase, six more steps | ok | 4 item(s) on occupied cells (or removes on empty ones) | shape: cell (37,15) already holds a tile; a finish only adds to empty cells (use kind "fix" to ch | fail |  | 0.90 | 2074 |
| stairs-floating-over-pit | auto | true | finish | staircase, six more steps | ok | ok | ok |  | staircase, pit | 0.90 | 2026 |
| stairs-two-steps-ambiguous | auto | true | finish | rising steps, two more platforms | ok | 1 tile group(s) floating out of reach | ok |  | staircase | 0.90 | 1283 |
| stairs-solid-hill | auto | true | finish | staircase, four more steps | ok | ok | ok |  | staircase, rest, wall | 0.90 | 2460 |
| gap-run-3 | auto | true | finish | gap-run, one more platform | ok | ok | ok |  | rest, pit | 0.90 | 1033 |
| gap-run-increasing | auto | true | finish | platform, five more tiles | ok | ok | ok |  | rest, pit | 0.90 | 1156 |
| gap-frontier-long-idle | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 1128 |
| pit-behind-flat-ahead | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 1047 |
| half-block-hops | auto | true | finish | half-block platforms, three more | ok | ok | ok |  | gap-run, pit | 0.90 | 1077 |
| gap-run-mid-stroke | auto | true | finish | platform, two more tiles | ok | ok | ok |  | rest | 0.90 | 1004 |
| pillar-hop | auto | true | finish | close the pit | ok | ok | ok |  | rest, wall | 0.90 | 954 |
| rising-platforms | auto | true | finish | rising steps, two more platforms | ok | 1 tile group(s) floating out of reach | ok |  | rising-steps | 0.90 | 1273 |
| alternating-platforms | auto | true | finish | rising steps, one more platform | ok | ok | measure: gap at x=50 is 10 wide and 7 down; the knight clears 8 with a 2-tile run-up (9 with a full | fail | pit | 0.90 | 1042 |
| question-blocks | auto | true | finish | question block row, two more | ok | ok | ok |  | rest, tunnel | 0.90 | 1060 |
| platform-under-ceiling | auto | true | finish | platform, four more blocks | ok | ok | rules: blocked at (35,11): there is nothing to land on right of column 35 (going from (31,11) to  | fail | rest, pit | 0.90 | 1095 |
| coin-arcs-next-pit | auto | true | extend | pit with a coin arc | ok | 2 item(s) on occupied cells (or removes on empty ones) | shape: cell (48,15) already holds a tile; a extend only adds to empty cells (use kind "fix" to ch | fail |  | 0.50 | 1826 |
| coin-arc-partial | auto | true | extend | pit with a coin arc | ok | 8 item(s) on occupied cells (or removes on empty ones) | shape: cell (36,15) already holds a tile; a extend only adds to empty cells (use kind "fix" to ch | fail |  | 0.50 | 1657 |
| coin-ladder-by-wall | auto | true | finish | wall, two more blocks | ok | ok | rules: blocked at (33,14): the next surface (34,8) is 0 empty tiles away, 6 higher; the knight cl | fail | wall | 0.90 | 989 |
| coins-flat-on-floor | auto | true | extend | pit with a coin arc | ok | 22 item(s) on occupied cells (or removes on empty ones) | shape: cell (52,15) already holds a tile; a extend only adds to empty cells (use kind "fix" to ch | fail |  | 0.50 | 3112 |
| risky-coins-over-pits | auto | true | extend | flat run with a slime | ok | ok | ok |  |  | 0.50 | 1014 |
| fruit-on-high-platform | auto | true | extend | rising steps with fruit | ok | ok | ok |  |  | 0.50 | 1540 |
| tunnel-ceiling | auto | true | finish | finish the row, 4 more blocks | ok | ok | ok |  | rest, tunnel | 0.90 | 1058 |
| vertical-tower | auto | true | finish | half-block platform, up and left | ok | ok | ok |  |  | 0.90 | 1139 |
| zigzag-walls | auto | true | finish | close the pit | ok | ok | measure: gap at x=27 is 5 wide and 3 up; the knight clears 3 with a 0-tile run-up (5 with a full ru | fail | rest, wall, tunnel | 0.90 | 1278 |
| wall-with-slot | auto | true | finish | pillar, two more blocks | ok | ok | ok |  |  | 0.90 | 856 |
| drop-shaft | auto | true | finish | half-block platform, four more tiles | ok | ok | ok |  | rest | 0.90 | 1096 |
| patrol-wide-pit | patrol | true | fix | pit 13 wide · knight clears 7 | ok | ok | ok |  | pit | 0.80 | 1287 |
| patrol-tall-wall | patrol | true | fix | wall 8 high · knight rises 3 | ok | ok | ok |  |  | 0.80 | 942 |
| patrol-high-ledge | patrol | true | fix | wall 8 high · knight rises 3 | ok | ok | rules: blocked at (31,11): there is nothing to land on right of column 31 (going from (30,14) to  | fail | rest, wall | 0.80 | 942 |
| patrol-pit-high-platform | patrol | true | fix | pit 7 wide · knight clears 7 | ok | ok | measure: gap at x=34 is 2 wide and 7 up; the knight cannot reach 7 rows up | fail | pit | 0.80 | 908 |
| patrol-pit-mid-level | patrol | true | fix | pit 15 wide · knight clears 7 | ok | ok | measure: gap at x=67 is 9 wide; the knight clears 6 with a 1-tile run-up (7 with a full run-up) | fail | pit | 0.80 | 1299 |
| slime-on-floor | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 1510 |
| enemy-gate | auto | true | extend | floating blocks, two more | ok | ok | ok |  | rest, tunnel | 0.50 | 1198 |
| ultraslime-platform | auto | true | extend | tunnel with ultraslime | ok | 1 item(s) on occupied cells (or removes on empty ones) | ok |  | rest, tunnel | 0.50 | 2774 |
| fresh-start | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 1440 |
| erasing | auto | false |  | person is erasing | ok |  |  |  |  | 0.00 | 587 |
| requested-mid-level | requested | true | finish | platform, one more up and right | ok | ok | rules: blocked at (45,14): there is nothing to land on right of column 45 (going from (43,14) to  | fail | rest | 0.90 | 897 |
| send-back-gap | auto | true | finish | platform, one more | ok | ok | ok |  | rest, pit | 0.90 | 941 |
| after-accepted-ghost | auto | true | finish | finish the platform | ok | ok | ok |  | rest | 0.90 | 839 |
| long-flat-run | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 1031 |
| question-field | auto | true | finish | question block row | ok | ok | ok |  | gap-run | 0.90 | 955 |
| level-end-flag | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 1199 |
| half-block-bridge | auto | true | finish | half-block platform, four more | ok | ok | ok |  | rest, pit | 0.90 | 1182 |
| variety-after-gap-runs | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 1049 |
| after-dismissals | auto | true | finish | platform row, four more tiles | ok | ok | ok |  | rest, tunnel | 0.90 | 1369 |
| mixed-1-gaps | auto | true | finish | pit with a platform | ok | ok | ok |  | rest, pit | 0.90 | 1049 |
| mixed-2-steps | auto | true | finish | staircase, two more steps | ok | ok | ok |  |  | 0.90 | 883 |
| mixed-3-high-run | auto | true | finish | platform, four more tiles | ok | ok | ok |  | rest | 0.90 | 919 |
| mixed-4-coins | auto | true | finish | coin arc, three more | ok | ok | ok |  | coin-arc, risky-coin | 0.90 | 1064 |
| mixed-5-extend | auto | true | finish | floor, four more tiles | ok | ok | ok |  | rest | 0.90 | 955 |
