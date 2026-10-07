## Pattern catalogue

Name each structure you draw with one of these names (the measure package tags the level with the same names). Window glyphs; `.` empty.

- **staircase**: three or more steps of 1-2 rows, same direction, no gaps. Keep the step height and tread width the person used.
  `..GG` / `.GG.` / `GG..`
- **rising-steps**: three or more separate platforms, each higher than the last, with gaps between. Each rise plus gap must stay inside the reach table.
  `.....GG` / `...GG..` / `GG.....`
- **gap-run**: three or more jumps over gaps at nearly the same height (change of 1 row at most). Vary the gap width by at most 1-2 between jumps.
  `GG..GG...GG..GG`
- **pillar-hop**: two or more pillars only 1-2 tiles wide with solid tiles below them, hopped in a row.
  `G..G..G` / `D..D..D`
- **pit**: a gap with nothing below it. Falling in is death, so give a wide takeoff and landing.
  `GGG....GGG` / `DDD....DDD`
- **wall**: a solid face 3 or more rows tall beside the path. A wall taller than the knight's max rise needs a step or a way around.
- **tunnel**: 4 or more columns of path under a ceiling 1-3 rows up. The knight cannot jump high inside, so keep its gaps small (2 at most).
- **rest**: 4 or more columns of flat ground with no enemies and headroom. Gives breathing room after a hard stretch.
  `GGGGGG`
- **coin-arc**: three or more coins along the knight's jump over a gap (offsets in the arc table below). Collected by making the jump well.
- **coin-ladder**: three or more coins stacked in one column over a ledge or pit, collected on the way up or down.
- **risky-coin**: a coin over a pit or beyond a safe landing, so collecting it costs a risk.
  `..o..` / `GG.GG`
- **guarded-reward**: a coin or fruit within 3 tiles of an enemy that patrols past it.
  `.o..` / `.~S~` / `GGGG`
- **enemy-gate**: an enemy on a short floor (5 wide or less) or under a low ceiling that the route must cross. Hard: use once per screen at most.
- **reveal**: a ?-block (Q) or reward placed where it only shows up after a climb or a drop. Rewards exploring.
- **dead-end-reward**: a short side branch that goes nowhere but holds a fruit or coins. The main route continues elsewhere.
- **one-way-drop**: a drop the knight cannot climb back up (more than 6 rows, or a wall). Only drop the knight where there is ground to land on.
- **flow-run**: long, nearly flat ground with small hops (gaps of 1-3) and coins at jump height, for running without stopping.
- **coin-row-on-floor** (anti-pattern): coins lying flat along a floor. Avoid this in a level that is about coins. Lift the coins onto the arc instead.
