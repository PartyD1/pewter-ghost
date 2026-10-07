# Baseline: seed set, default config

- Prompt `fill.v1-f9d1aef8`; model `gemini-3.7-flash`, window as recorded, summary as recorded, examples off, brief on, confidence stated, samples 1, temperature 0.2, thinking 0, send-back always, agent cap 300 ms, call budget 900 ms.
- 52 cases (52 scored, 0 skipped, 0 call errors, 3 from cache). Run 2026-10-07T23:11:07.673Z to 2026-10-07T23:11:55.772Z.

## Summary

| measure | value |
|---|---|
| Playability first try (of acting answers) | 87.8% |
| Playable after one send-back | 91.8% |
| Send-back pass rate | 33.3% (6 sent back) |
| Schema ok | 100.0% |
| Coordinate accuracy (all checks) | 98.0% |
| Coordinate item share | 100.0% |
| Validator pass | 91.8% |
| Expectation met (seed labels) | 100.0% of 30 |
| Acted / declined | 49 / 3 |
| Distinct tags per session | 2.9 |
| Tag three times running (violations) | 4 (FAIL) |
| Extends repeating the last two accepted | 0 |
| Tag novelty vs previous answer | 0.73 |
| Latency p50 / p90 | 2022 ms / 2880 ms |
| Within call budget (900 ms) | 0.0% |
| Stated confidence AUC vs first try | 0.41 |
| Mean stated confidence | 0.74 |
| Prompt / output tokens (mean) | 8807 / 95 |
| Errors / skipped | 0 / 0 |

## First-try verdict by stage

| stage | answers |
|---|---|
| ok | 43 |
| measure | 4 |
| rules | 2 |

Agent over its cap on 0 answer(s) (counted as fails, as in the app).

## Kinds

| kind | answers |
|---|---|
| finish | 27 |
| extend | 15 |
| fix | 7 |

## Variety per session (G-25)

| session | answers | distinct tags | longest run | 3-in-a-row | history repeats | tag novelty |
|---|---|---|---|---|---|---|
| seed-coins | 6 | 4 (coin-arc, rising-steps, risky-coin, wall) | coin-arc x2 | none | 0 | 0.80 |
| seed-enemies | 3 | 1 (tunnel) | tunnel x1 | none | 0 | 1.00 |
| seed-gaps | 6 | 1 (pit) | pit x5 | pit x5 | 0 | 0.20 |
| seed-maze | 4 | 3 (pillar-hop, tunnel, wall) | tunnel x1 | none | 0 | 1.00 |
| seed-misc | 9 | 2 (gap-run, pit) | pit x3 | pit x3 | 0 | 0.63 |
| seed-mixed | 5 | 4 (coin-arc, pit, risky-coin, staircase) | pit x3 | pit x3 | 0 | 0.75 |
| seed-patrol | 5 | 2 (pit, wall) | pit x2 | none | 0 | 0.75 |
| seed-platforms | 5 | 5 (coin-row-on-floor, gap-run, pillar-hop, pit, rising-steps) | gap-run x1 | none | 0 | 1.00 |
| seed-stairs | 6 | 4 (pit, staircase, tunnel, wall) | staircase x6 | staircase x6 | 0 | 0.40 |

## Stated confidence vs first try

| band | n | first-try rate |
|---|---|---|
| low [0, 0.4) | 0 | n/a |
| mid [0.4, 0.75) | 14 | 92.9% |
| high [0.75, 1) | 35 | 85.7% |

## Cases

| case | mode | act | kind | label | schema | coords | first try | send-back | tags | conf | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stairs-up-2wide | auto | true | finish | staircase, two more steps | ok | ok | ok |  | staircase, tunnel | 0.90 | 1924 |
| stairs-up-1wide | auto | true | finish | staircase, two more steps | ok | ok | ok |  | staircase | 0.88 | 2138 |
| stairs-down | auto | true | finish | descending staircase, two more steps | ok | ok | ok |  | staircase, rest | 0.88 | 2337 |
| stairs-floating-over-pit | auto | true | finish | staircase, two more steps | ok | ok | measure: gap at x=42 is 10 wide and 6 down; the drawing so far jumps at most 1, so keep gaps to 6 o | fail | staircase, pit | 0.90 | 2737 |
| stairs-two-steps-ambiguous | auto | true | finish | rising steps, one more platform | ok | ok | ok |  | staircase | 0.85 | 2289 |
| stairs-solid-hill | auto | true | finish | staircase slope, grass cap | ok | ok | ok |  | staircase, rest, wall | 0.85 | 1973 |
| gap-run-3 | auto | true | extend | repeat platform with gap | ok | ok | ok |  | rest, pit | 0.80 | 1795 |
| gap-run-increasing | auto | true | extend | gap run with another platform | ok | ok | ok |  | rest, pit | 0.60 | 3153 |
| gap-frontier-long-idle | auto | true | extend | pit with floating landing | ok | ok | ok |  | rest, pit | 0.50 | 2303 |
| pit-behind-flat-ahead | auto | true | extend | gap jump to another platform | ok | ok | ok |  | rest, pit | 0.50 | 2879 |
| half-block-hops | auto | true | finish | half-block platform, rising rhythm | ok | ok | measure: gap at x=35 is 9 wide; the drawing so far jumps at most 3, so keep gaps to 7 or less here | fail | pit | 0.85 | 2236 |
| gap-run-mid-stroke | auto | true | finish | platform, two more tiles | ok | ok | ok |  | rest | 0.85 | 1661 |
| pillar-hop | auto | true | finish | pillar-hop, two more pillars | ok | ok | ok |  | gap-run, pillar-hop, pit | 0.85 | 2436 |
| rising-platforms | auto | true | finish | rising steps, one more platform | ok | ok | ok |  | rising-steps | 0.85 | 2018 |
| alternating-platforms | auto | true | finish | alternating platforms, next step down | ok | ok | ok |  | pit | 0.85 | 1490 |
| question-blocks | auto | true | finish | matching coins above question blocks | ok | ok | measure: 3 coins at x=20..25 lie flat on the floor (row 10); in a coin level put coins on the arc o | fail | coin-row-on-floor | 0.78 | 1862 |
| platform-under-ceiling | auto | true | fix | gap 15 wide · knight clears 11 | ok | ok | ok |  | pit | 0.75 | 1908 |
| coin-arcs-next-pit | auto | true | finish | coin arc over the pit | ok | nearest item is 9 tiles from the action (> 8) | ok |  | coin-arc, risky-coin | 0.85 | 2004 |
| coin-arc-partial | auto | true | finish | coin arc over pit | ok | ok | ok |  | coin-arc, risky-coin | 0.85 | 1756 |
| coin-ladder-by-wall | auto | true | finish | coin ladder beside wall | ok | ok | ok |  | wall | 0.85 | 2712 |
| coins-flat-on-floor | auto | true | fix | lift floor coins onto arc | ok | ok | ok |  | coin-arc, rest | 0.75 | 1957 |
| risky-coins-over-pits | auto | true | extend | rising step with question block | ok | ok | ok |  | rest | 0.50 | 2072 |
| fruit-on-high-platform | auto | true | extend | rising-steps to upper ledge | ok | ok | ok |  | rising-steps | 0.50 | 2880 |
| tunnel-ceiling | auto | true | finish | continue ceiling tunnel | ok | ok | ok |  | rest, tunnel | 0.80 | 2395 |
| vertical-tower | auto | true | finish | zigzag half-block shelf | ok | ok | measure: gap at x=15 is 9 wide; the knight clears 8 with a 0-tile run-up (11 with a full run-up) | fail | wall | 0.85 | 1809 |
| zigzag-walls | auto | true | finish | pillar-hop, next pillar | ok | ok | ok |  | pillar-hop, rest | 0.75 | 2022 |
| wall-with-slot | auto | false |  | vertical wall in progress | ok |  |  |  |  | 0.00 | 3620 |
| drop-shaft | auto | true | extend | floating half-block ledge with coins | ok | ok | ok |  | rest | 0.50 | 2445 |
| patrol-wide-pit | patrol | true | fix | pit 13 wide · knight clears 11 | ok | ok | ok |  | pit | 0.85 | 2096 |
| patrol-tall-wall | patrol | true | fix | wall 8 high · knight rises 6 | ok | ok | ok |  | wall | 0.85 | 1755 |
| patrol-high-ledge | patrol | true | fix | rise 8 high · knight rises 6 | ok | ok | rules: blocked at (32,10): there is nothing to land on right of column 32 (going from (30,14) to  | pass |  | 0.80 | 1700 |
| patrol-pit-high-platform | patrol | true | fix | rise 7 · knight rises 6 | ok | ok | ok |  | pit | 0.85 | 1934 |
| patrol-pit-mid-level | patrol | true | fix | gap 15 · knight clears 11 | ok | ok | ok |  | pit | 0.85 | 1782 |
| slime-on-floor | auto | true | finish | dirt under grass floor | ok | ok | ok |  |  | 0.85 | 1965 |
| enemy-gate | auto | true | finish | floating platform across the gap | ok | ok | ok |  | rest, tunnel | 0.75 | 2045 |
| ultraslime-platform | auto | true | extend | floating platform with a fruit reward | ok | ok | ok |  |  | 0.55 | 1939 |
| fresh-start | auto | true | extend | pit with landing platform | ok | ok | ok |  | rest, pit | 0.50 | 1852 |
| erasing | auto | false |  | person is erasing | ok |  |  |  |  | 0.00 | 2396 |
| requested-mid-level | requested | true | extend | third floating platform to continue asce | ok | ok | rules: blocked at (45,14): there is nothing to land on right of column 45 (going from (43,14) to  | pass | rest | 0.60 | 1871 |
| send-back-gap | auto | true | finish | gap run, next 4-wide platform | ok | ok | ok |  | rest, pit | 0.85 | 2149 |
| after-accepted-ghost | auto | true | extend | rising step with a slight drop | ok | ok | ok |  | gap-run, pit | 0.50 | 1965 |
| long-flat-run | auto | true | extend | small gap jump to platform | ok | ok | ok |  | rest, pit | 0.50 | 2181 |
| question-field | auto | true | finish | two more ?-blocks | ok | ok | ok |  | rest | 0.85 | 2959 |
| level-end-flag | auto | true | finish | continue ground under flag | ok | ok | ok |  | rest | 0.85 | 3257 |
| half-block-bridge | auto | true | finish | half-block platform, extend right | ok | ok | ok |  | rest, pit | 0.78 | 2299 |
| variety-after-gap-runs | auto | true | extend | rising steps over a drop | ok | ok | ok |  | pit | 0.50 | 1970 |
| after-dismissals | auto | false |  | platform complete, waiting for intent | ok |  |  |  |  | 0.00 | 11373 |
| mixed-1-gaps | auto | true | finish | gap-run, another platform | ok | ok | ok |  | rest, pit | 0.85 | 2366 |
| mixed-2-steps | auto | true | finish | staircase, two more steps | ok | ok | ok |  | staircase | 0.85 | 1530 |
| mixed-3-high-run | auto | true | extend | gap jump to floating platform | ok | ok | ok |  | rest, pit | 0.50 | 1877 |
| mixed-4-coins | auto | true | finish | complete coin arc across pit | ok | ok | ok |  | coin-arc, risky-coin, rest, pit | 0.85 | 1996 |
| mixed-5-extend | auto | true | extend | gap run across floating blocks | ok | ok | ok |  | risky-coin, pit | 0.50 | 2155 |
