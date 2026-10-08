# Making ghosts appear sooner: lever 1 (hide the wait)

Live A/B with the real model (gemini-3.7-flash, thinking off), 8 October 2026. Each trial draws a
one-tile staircase on a fresh page through the level model, then measures the time from the last
tile to the first ghost on screen. Three repetitions per cell; "before" is commit 0d11116.

| Scenario | Before | 4 ahead, 4 in flight | 6 ahead, 6 in flight (current) |
|---|---|---|---|
| 3 steps, 400 ms apart | 2.13 s | 1.97 s | 1.66 s |
| 3 steps, 250 ms apart | 2.25 s | 2.26 s | 2.03 s |
| 6 steps, 400 ms apart | 1.42 s | 1.52 s | 1.27 s |
| 10 steps, 400 ms apart | 1.38 s | — | 0.72 s |

Medians of three; individual runs vary by about ±0.5 s.

What changed:
- The first tile of a stroke calls the model at once instead of waiting out the coalescing window (`fillLeadingEdge`).
- Six calls may be in flight at once instead of three (`maxInFlight`).
- The prompt asks Finish to run about six units ahead; the editor trims the cells the person draws while an answer travels and shows the rest.

What it does and does not fix:
- Longer strokes improve most: on a 10-step staircase the wait after the last tile halves (1.38 s to 0.72 s), because an answer from earlier in the stroke still has cells left when it lands.
- The first ghost of a new structure still costs the model's full latency (about 2 s): the model needs two or three tiles to see the pattern, then takes about 2 s to answer.
- A person drawing continuously at 400 ms per tile still outruns the model. Answers that arrive after all their cells were drawn are dropped as "stale: all cells drawn"; ghosts are almost never on screen mid-stroke.

Next options: let the model's own answer roll forward on the client (it names the unit, e.g. one up and one right; the editor keeps the ghost one unit ahead of each new tile until the next answer lands), or a faster model (lever 2; see eval/runs for the quality trade-off).
