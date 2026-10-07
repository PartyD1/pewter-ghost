/**
 * Seed fixtures: realistic editing states built programmatically, the
 * starting benchmark before real sessions exist. Each returns a SeedSpec
 * (level + captured placements + request settings). makeSeed.ts turns them
 * into eval/data/seed.jsonl with the real window builder and brief.
 *
 * Families: staircase, gaps, platforms, coins, maze, patrol (unbeatable
 * sections), enemies, misc (fresh start, erasing, requested, send-back,
 * accepted ghosts, variety pressure, level end). Sessions group cases so
 * variety can be scored per session.
 *
 * Geometry: level 200 x 20, ground (grass over dirt) on row 15, the knight
 * starts at (2,14). Knight limits: gap 8 standing / 11 running, rise 6.
 */
import { TILE, type GhostHistoryItem } from "../../../apps/editor/src/contracts";
import { GROUND_Y as Y, Sketch, col, run, type Cell, type SeedSpec } from "./sketch";

const G = TILE.GRASS;
const B = TILE.BLOCK;
const H = TILE.GRASS_HALF;
const Q = TILE.QUESTION;
const D = TILE.DIRT;

const gh = (kind: GhostHistoryItem["kind"], label: string, outcome: GhostHistoryItem["outcome"], patterns?: string[]): GhostHistoryItem =>
  patterns ? { kind, label, outcome, patterns } : { kind, label, outcome };

/** Steps of `w` tiles rising `dy` per step, starting at (x0, y0), n steps, as strokes. */
function steps(x0: number, y0: number, n: number, w: number, dy: number): Cell[][] {
  const out: Cell[][] = [];
  for (let i = 0; i < n; i++) out.push(run(x0 + i * w, x0 + i * w + w - 1, y0 - i * dy));
  return out;
}

// ---------------------------------------------------------------------------
// Staircase (session seed-stairs)
// ---------------------------------------------------------------------------

const STAIRS = "seed-stairs";

function stairsUp2(): SeedSpec {
  const s = new Sketch().ground(0, 40).tick(2500);
  s.strokes(steps(30, Y - 1, 3, 2, 1), B);
  return s.spec({ name: "stairs-up-2wide", family: "staircase", sessionId: STAIRS, tags: ["finish"], mode: "auto", idleMs: 380,
    expect: { act: true, kinds: ["finish"], note: "three identical 2-wide steps: continue the climb" } });
}

function stairsUp1(): SeedSpec {
  const s = new Sketch().ground(0, 34).tick(2000);
  s.strokes(steps(24, Y - 1, 4, 1, 1), B, 300);
  return s.spec({ name: "stairs-up-1wide", family: "staircase", sessionId: STAIRS, tags: ["finish"], mode: "auto", idleMs: 420,
    lastGhosts: [gh("extend", "flat run", "accepted", ["rest"])],
    expect: { act: true, kinds: ["finish"] } });
}

function stairsDown(): SeedSpec {
  const s = new Sketch().ground(0, 20).rect(21, 9, 26, 9, G).ground(36, 60).tick(2500);
  s.strokes([run(27, 28, 10), run(29, 30, 11), run(31, 32, 12)], B);
  return s.spec({ name: "stairs-down", family: "staircase", sessionId: STAIRS, tags: ["finish"], mode: "auto", idleMs: 400,
    expect: { act: true, kinds: ["finish"], note: "descending steps toward the lower ground" } });
}

function stairsFloating(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(52, 70).tick(2500);
  s.strokes(steps(32, Y - 2, 3, 2, 1), B);
  return s.spec({ name: "stairs-floating-over-pit", family: "staircase", sessionId: STAIRS, tags: ["finish", "pit"], mode: "auto", idleMs: 450,
    expect: { act: true, kinds: ["finish", "extend"] } });
}

function stairsTwoSteps(): SeedSpec {
  const s = new Sketch().ground(0, 50).tick(2500);
  s.strokes(steps(38, Y - 1, 2, 3, 2), B);
  return s.spec({ name: "stairs-two-steps-ambiguous", family: "staircase", sessionId: STAIRS, tags: ["ambiguous"], mode: "auto", idleMs: 900 });
}

function stairsSolidHill(): SeedSpec {
  const s = new Sketch().ground(0, 60).tick(2500);
  // A filled hill: each column stacked down to the ground, drawn column by column.
  const strokes: Cell[][] = [];
  for (let i = 0; i < 4; i++) strokes.push(col(40 + i, Y - 1 - i, Y - 1));
  s.strokes(strokes, D, 380);
  return s.spec({ name: "stairs-solid-hill", family: "staircase", sessionId: STAIRS, tags: ["finish"], mode: "auto", idleMs: 500,
    expect: { act: true, kinds: ["finish"] } });
}

// ---------------------------------------------------------------------------
// Gaps (session seed-gaps)
// ---------------------------------------------------------------------------

const GAPS = "seed-gaps";

function gapRun3(): SeedSpec {
  const s = new Sketch().ground(0, 20).tick(2000);
  s.strokes([run(24, 28, Y), run(32, 36, Y), run(40, 44, Y)], G, 600, 110);
  return s.spec({ name: "gap-run-3", family: "gaps", sessionId: GAPS, tags: ["finish", "gap-run"], mode: "auto", idleMs: 700,
    expect: { act: true, kinds: ["finish", "extend"], note: "platforms 5 wide, gaps 3: one more of the same" } });
}

function gapRunIncreasing(): SeedSpec {
  const s = new Sketch().ground(0, 18).tick(2000);
  s.strokes([run(21, 25, Y), run(29, 33, Y), run(38, 42, Y)], G, 600, 110);
  return s.spec({ name: "gap-run-increasing", family: "gaps", sessionId: GAPS, tags: ["gap-run"], mode: "auto", idleMs: 800,
    lastGhosts: [gh("finish", "two more steps", "accepted", ["staircase"])],
    expect: { act: true, kinds: ["finish", "extend"], note: "gaps 2, 3, 4: the next is 5" } });
}

function gapAtFrontier(): SeedSpec {
  const s = new Sketch().ground(0, 30).tick(1500);
  s.stroke(run(31, 45, Y), G, 90);
  return s.spec({ name: "gap-frontier-long-idle", family: "gaps", sessionId: GAPS, tags: ["extend"], mode: "auto", idleMs: 2700,
    lastGhosts: [gh("extend", "gap run of three", "accepted", ["gap-run"]), gh("finish", "staircase up", "accepted", ["staircase"])],
    expect: { act: true, kinds: ["extend"] } });
}

function singlePitBehind(): SeedSpec {
  const s = new Sketch().ground(0, 25).ground(31, 40).tick(2000);
  s.stroke(run(41, 52, Y), G, 90);
  return s.spec({ name: "pit-behind-flat-ahead", family: "gaps", sessionId: GAPS, tags: ["extend"], mode: "auto", idleMs: 1600 });
}

function halfBlockHops(): SeedSpec {
  const s = new Sketch().ground(0, 22).ground(56, 70).tick(2000);
  s.strokes([run(26, 28, Y - 2), run(32, 34, Y - 3), run(38, 40, Y - 2)], H, 500);
  return s.spec({ name: "half-block-hops", family: "gaps", sessionId: GAPS, tags: ["finish", "pit"], mode: "auto", idleMs: 600,
    expect: { act: true, kinds: ["finish", "extend"], note: "hop platforms across a pit: continue to the far ground" } });
}

function gapRunMidStroke(): SeedSpec {
  const s = new Sketch().ground(0, 16).tick(2000);
  s.strokes([run(20, 23, Y), run(27, 30, Y), run(34, 35, Y)], G, 500, 120);
  return s.spec({ name: "gap-run-mid-stroke", family: "gaps", sessionId: GAPS, tags: ["finish"], mode: "auto", idleMs: 250,
    expect: { act: true, kinds: ["finish"], note: "the third platform is half drawn" } });
}

// ---------------------------------------------------------------------------
// Platforms (session seed-platforms)
// ---------------------------------------------------------------------------

const PLAT = "seed-platforms";

function pillarHop(): SeedSpec {
  const s = new Sketch().ground(0, 18).tick(2000);
  s.strokes([col(22, Y - 3, Y + 1), col(27, Y - 3, Y + 1), col(32, Y - 3, Y + 1)], B, 500);
  return s.spec({ name: "pillar-hop", family: "platforms", sessionId: PLAT, tags: ["finish", "pillar-hop"], mode: "auto", idleMs: 600,
    expect: { act: true, kinds: ["finish", "extend"] } });
}

function risingPlatforms(): SeedSpec {
  const s = new Sketch().ground(0, 70).tick(2000);
  s.strokes([run(24, 26, Y - 2), run(29, 31, Y - 4), run(34, 36, Y - 6)], B, 500);
  return s.spec({ name: "rising-platforms", family: "platforms", sessionId: PLAT, tags: ["finish", "rising-steps"], mode: "auto", idleMs: 500,
    expect: { act: true, kinds: ["finish"] } });
}

function alternatingPlatforms(): SeedSpec {
  const s = new Sketch().ground(0, 20).ground(60, 80).tick(2000);
  s.strokes([run(23, 25, Y - 1), run(29, 31, Y - 4), run(35, 37, Y - 1), run(41, 43, Y - 4)], G, 450);
  return s.spec({ name: "alternating-platforms", family: "platforms", sessionId: PLAT, tags: ["finish", "pit"], mode: "auto", idleMs: 700,
    lastGhosts: [gh("extend", "rising platforms", "accepted", ["rising-steps"])],
    expect: { act: true, kinds: ["finish", "extend"] } });
}

function questionRow(): SeedSpec {
  const s = new Sketch().ground(0, 60).tick(2000);
  s.strokes([run(20, 20, Y - 4), run(23, 25, Y - 4)], Q, 600);
  s.place("coin", [[24, Y - 5]]);
  return s.spec({ name: "question-blocks", family: "platforms", sessionId: PLAT, tags: ["extend"], mode: "auto", idleMs: 1400,
    lastGuess: "classic" });
}

function ledgeWithCeiling(): SeedSpec {
  const s = new Sketch().ground(0, 24).ground(40, 60).rect(26, 7, 38, 7, B).tick(2000);
  s.stroke(run(28, 31, Y - 3), B, 150);
  return s.spec({ name: "platform-under-ceiling", family: "platforms", sessionId: PLAT, tags: ["finish", "pit"], mode: "auto", idleMs: 900 });
}

// ---------------------------------------------------------------------------
// Coins (session seed-coins)
// ---------------------------------------------------------------------------

const COINS = "seed-coins";

function coinArcs(): SeedSpec {
  const s = new Sketch().ground(0, 20).ground(25, 34).ground(39, 48).ground(53, 62).tick(1500);
  s.place("coin", [[21, 12], [22, 11], [23, 11], [24, 12]]);
  s.place("coin", [[35, 12], [36, 11], [37, 11], [38, 12]]);
  return s.spec({ name: "coin-arcs-next-pit", family: "coins", sessionId: COINS, tags: ["coin-arc", "finish"], mode: "auto", idleMs: 1200,
    lastGuess: "collect-a-thon",
    expect: { act: true, kinds: ["finish", "extend"], note: "coins on the arc over the third pit" } });
}

function coinArcPartial(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(36, 50).tick(1500);
  s.place("coin", [[31, 12], [32, 11]], 300);
  return s.spec({ name: "coin-arc-partial", family: "coins", sessionId: COINS, tags: ["coin-arc", "finish"], mode: "auto", idleMs: 350,
    expect: { act: true, kinds: ["finish"] } });
}

function coinLadder(): SeedSpec {
  const s = new Sketch().ground(0, 50).rect(34, 10, 35, Y - 1, B).tick(1500);
  s.place("coin", [[33, 13], [33, 11]], 350);
  return s.spec({ name: "coin-ladder-by-wall", family: "coins", sessionId: COINS, tags: ["coin-ladder"], mode: "auto", idleMs: 600,
    expect: { act: true, kinds: ["finish"] } });
}

function floorCoins(): SeedSpec {
  const s = new Sketch().ground(0, 70).tick(1000);
  s.ground(30, 32).place("coin", [[10, 12], [11, 11], [12, 12], [20, 12], [21, 11], [22, 12]]);
  s.tick(2000).place("coin", run(40, 45, Y - 1), 200);
  return s.spec({ name: "coins-flat-on-floor", family: "coins", sessionId: COINS, tags: ["fix", "coin-row-on-floor"], mode: "auto", idleMs: 2600,
    lastGuess: "collect-a-thon" });
}

function riskyCoins(): SeedSpec {
  const s = new Sketch().ground(0, 24).ground(32, 44).ground(52, 64).tick(1500);
  s.place("coin", [[28, Y + 1], [29, Y + 1]]);
  s.place("coin", [[48, Y + 1]]);
  return s.spec({ name: "risky-coins-over-pits", family: "coins", sessionId: COINS, tags: ["risky-coin"], mode: "auto", idleMs: 1500,
    lastGhosts: [gh("extend", "coin arc over pit", "accepted", ["coin-arc", "pit"]), gh("extend", "coin arc over pit", "esc", ["coin-arc", "pit"])] });
}

function fruitOnHigh(): SeedSpec {
  const s = new Sketch().ground(0, 50).tick(1500);
  s.strokes([run(30, 32, Y - 3), run(35, 37, Y - 6)], B, 500);
  s.place("fruit", [[36, Y - 7]]);
  return s.spec({ name: "fruit-on-high-platform", family: "coins", sessionId: COINS, tags: ["guarded-reward"], mode: "auto", idleMs: 1800 });
}

// ---------------------------------------------------------------------------
// Maze-ish (session seed-maze)
// ---------------------------------------------------------------------------

const MAZE = "seed-maze";

function tunnel(): SeedSpec {
  const s = new Sketch().ground(0, 60).tick(1500);
  s.stroke(run(20, 34, Y - 4), B, 80);
  return s.spec({ name: "tunnel-ceiling", family: "maze", sessionId: MAZE, tags: ["tunnel", "extend"], mode: "auto", idleMs: 1200,
    lastGuess: "maze" });
}

function verticalTower(): SeedSpec {
  const s = new Sketch().ground(0, 30).rect(14, 2, 14, Y - 1, B).rect(24, 2, 24, Y - 1, B).tick(2000);
  s.strokes([run(15, 17, 12), run(21, 23, 9), run(15, 17, 6)], H, 600);
  return s.spec({ name: "vertical-tower", family: "maze", sessionId: MAZE, tags: ["finish", "vertical"], mode: "auto", idleMs: 700,
    expect: { act: true, kinds: ["finish"] } });
}

function zigzagWalls(): SeedSpec {
  const s = new Sketch().ground(0, 70).tick(1500);
  s.strokes([col(20, 6, Y - 3), col(26, 9, Y - 1), col(32, 6, Y - 3)], B, 500, 100);
  return s.spec({ name: "zigzag-walls", family: "maze", sessionId: MAZE, tags: ["wall", "finish"], mode: "auto", idleMs: 900,
    lastGuess: "maze" });
}

function wallWithPassage(): SeedSpec {
  const s = new Sketch().ground(0, 60).tick(1500);
  s.stroke([...col(30, 4, 10), ...col(30, 13, Y - 1)], B, 90);
  return s.spec({ name: "wall-with-slot", family: "maze", sessionId: MAZE, tags: ["wall"], mode: "auto", idleMs: 1100 });
}

function dropShaft(): SeedSpec {
  const s = new Sketch({ x: 2, y: 7 }).ground(0, 20, 8).rect(21, 8, 21, 17, B).ground(22, 50, 18, 2).tick(1500);
  s.stroke(run(26, 32, 12), H, 120);
  return s.spec({ name: "drop-shaft", family: "maze", sessionId: MAZE, tags: ["drop"], mode: "auto", idleMs: 1000 });
}

// ---------------------------------------------------------------------------
// Patrol: unbeatable sections (session seed-patrol)
// ---------------------------------------------------------------------------

const PATROL = "seed-patrol";

function widePit(): SeedSpec {
  const s = new Sketch().ground(0, 30).tick(1000);
  s.stroke(run(44, 60, Y), G, 70);
  return s.spec({ name: "patrol-wide-pit", family: "patrol", sessionId: PATROL, tags: ["patrol", "pit"], mode: "patrol", patrol: true, idleMs: 3200,
    expect: { act: true, kinds: ["fix"], note: "a 14-wide pit: one or two stones make it" } });
}

function tallWall(): SeedSpec {
  const s = new Sketch().ground(0, 60).tick(1000);
  s.stroke(col(30, Y - 8, Y - 1), B, 90);
  return s.spec({ name: "patrol-tall-wall", family: "patrol", sessionId: PATROL, tags: ["patrol", "wall"], mode: "patrol", patrol: true, idleMs: 3300,
    expect: { act: true, kinds: ["fix"] } });
}

function highLedge(): SeedSpec {
  const s = new Sketch().ground(0, 30).tick(1000);
  s.stroke(run(31, 50, Y - 8), G, 70);
  return s.spec({ name: "patrol-high-ledge", family: "patrol", sessionId: PATROL, tags: ["patrol"], mode: "patrol", patrol: true, idleMs: 3100,
    expect: { act: true, kinds: ["fix"] } });
}

function pitWithHighPlatform(): SeedSpec {
  const s = new Sketch().ground(0, 28).ground(48, 66).tick(1000);
  s.stroke(run(36, 39, Y - 7), B, 120);
  return s.spec({ name: "patrol-pit-high-platform", family: "patrol", sessionId: PATROL, tags: ["patrol", "pit"], mode: "patrol", patrol: true, idleMs: 3500,
    expect: { act: true, kinds: ["fix"] } });
}

function longPitMidLevel(): SeedSpec {
  const s = new Sketch().ground(0, 60).ground(76, 100).tick(1000);
  s.stroke(run(101, 110, Y), G, 70);
  return s.spec({ name: "patrol-pit-mid-level", family: "patrol", sessionId: PATROL, tags: ["patrol", "pit"], mode: "patrol", patrol: true, idleMs: 3400,
    expect: { act: true, kinds: ["fix"] } });
}

// ---------------------------------------------------------------------------
// Enemies (session seed-enemies)
// ---------------------------------------------------------------------------

const ENEMY = "seed-enemies";

function slimeFloor(): SeedSpec {
  const s = new Sketch().ground(0, 50).tick(1500);
  s.place("slime", [[30, Y - 1]]);
  s.tick(500).stroke(run(51, 56, Y), G, 100);
  return s.spec({ name: "slime-on-floor", family: "enemies", sessionId: ENEMY, tags: ["extend", "enemy"], mode: "auto", idleMs: 1600 });
}

function enemyGate(): SeedSpec {
  const s = new Sketch().ground(0, 70).tick(1500);
  s.strokes([run(30, 34, Y - 3), run(42, 46, Y - 3)], B, 500);
  s.place("slime", [[38, Y - 1]]);
  return s.spec({ name: "enemy-gate", family: "enemies", sessionId: ENEMY, tags: ["enemy-gate"], mode: "auto", idleMs: 1400,
    lastGhosts: [gh("extend", "slime on a long floor", "accepted", ["enemy-gate"])] });
}

function ultraslimePlatform(): SeedSpec {
  const s = new Sketch().ground(0, 24).ground(30, 60).tick(1500);
  s.stroke(run(36, 44, Y - 4), B, 90);
  s.place("ultraslime", [[40, Y - 5]]);
  return s.spec({ name: "ultraslime-platform", family: "enemies", sessionId: ENEMY, tags: ["enemy"], mode: "auto", idleMs: 1300 });
}

// ---------------------------------------------------------------------------
// Misc (session seed-misc)
// ---------------------------------------------------------------------------

const MISC = "seed-misc";

function freshStart(): SeedSpec {
  const s = new Sketch().tick(1000);
  s.stroke(run(0, 9, Y), G, 90);
  return s.spec({ name: "fresh-start", family: "misc", sessionId: MISC, tags: ["early"], mode: "auto", idleMs: 900,
    expect: { note: "too early to know the level: declining is fine" } });
}

function erasing(): SeedSpec {
  const s = new Sketch().ground(0, 40).tick(1500);
  s.strokes(steps(26, Y - 1, 3, 2, 1), B, 400);
  s.tick(600).erase([[31, Y - 3], [30, Y - 3], [29, Y - 2]]);
  return s.spec({ name: "erasing", family: "misc", sessionId: MISC, tags: ["erase"], mode: "auto", idleMs: 300,
    expect: { act: false, note: "the person is erasing: do not suggest" } });
}

function requested(): SeedSpec {
  const s = new Sketch().ground(0, 45).tick(1500);
  s.strokes([run(30, 33, Y - 3), run(37, 40, Y - 5)], B, 500);
  return s.spec({ name: "requested-mid-level", family: "misc", sessionId: MISC, tags: ["requested"], mode: "requested", idleMs: 4000,
    expect: { act: true, note: "asked with Ctrl+Space: always offer something" } });
}

function sendBack(): SeedSpec {
  const s = new Sketch().ground(0, 30).tick(1500);
  s.strokes([run(34, 37, Y), run(41, 44, Y)], G, 500);
  return s.spec({ name: "send-back-gap", family: "misc", sessionId: MISC, tags: ["send-back"], mode: "auto", idleMs: 600,
    previousFailure: { reason: "gap at x=45..56 is 12 wide; the knight clears 11 with a full run-up", stage: "measure" },
    expect: { act: true } });
}

function acceptedGhost(): SeedSpec {
  const s = new Sketch().ground(0, 40).tick(1500);
  s.ghost("llm-1-0badf00d", [...run(41, 46, Y), ...run(49, 54, Y)], G);
  s.tick(1500).stroke(run(57, 60, Y), G, 110);
  return s.spec({ name: "after-accepted-ghost", family: "misc", sessionId: MISC, tags: ["ghost"], mode: "auto", idleMs: 900,
    lastGhosts: [gh("extend", "two platforms over gaps", "accepted", ["gap-run"])] });
}

function speedrunFlat(): SeedSpec {
  const s = new Sketch().ground(0, 20).tick(1000);
  s.stroke(run(21, 60, Y), G, 50);
  return s.spec({ name: "long-flat-run", family: "misc", sessionId: MISC, tags: ["extend", "rest"], mode: "auto", idleMs: 2600,
    lastGuess: "speedrun", expect: { act: true, kinds: ["extend"] } });
}

function questionField(): SeedSpec {
  const s = new Sketch().ground(0, 50).tick(1200);
  s.strokes([run(20, 23, 10), run(26, 29, 10), run(32, 33, 10)], Q, 400);
  return s.spec({ name: "question-field", family: "misc", sessionId: MISC, tags: ["finish"], mode: "auto", idleMs: 400 });
}

function levelEnd(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(150, 185).tick(1000);
  s.place("flag", [[196, Y - 1]]);
  s.tick(800).stroke(run(186, 190, Y), G, 100);
  return s.spec({ name: "level-end-flag", family: "misc", sessionId: MISC, tags: ["finish", "edge"], mode: "auto", idleMs: 1000,
    expect: { act: true, kinds: ["finish", "extend"], note: "join the ground to the flag" } });
}

function halfBridge(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(44, 60).tick(1500);
  s.stroke(run(31, 35, Y - 1), H, 140);
  return s.spec({ name: "half-block-bridge", family: "misc", sessionId: MISC, tags: ["finish"], mode: "auto", idleMs: 300,
    expect: { act: true, kinds: ["finish"] } });
}

function varietyPressure(): SeedSpec {
  const s = new Sketch().ground(0, 24).ground(28, 34).ground(38, 44).ground(48, 54).tick(1500);
  s.stroke(run(55, 64, Y), G, 70);
  return s.spec({ name: "variety-after-gap-runs", family: "misc", sessionId: MISC, tags: ["extend", "variety"], mode: "auto", idleMs: 2700,
    lastGhosts: [
      gh("extend", "gap run", "accepted", ["gap-run", "rest"]),
      gh("extend", "another gap run", "accepted", ["gap-run"]),
    ],
    expect: { act: true, kinds: ["extend"], note: "the last two extends were gap runs: offer something else" } });
}

function afterDismissals(): SeedSpec {
  const s = new Sketch().ground(0, 50).tick(1500);
  s.stroke(run(30, 33, Y - 3), B, 130);
  return s.spec({ name: "after-dismissals", family: "misc", sessionId: MISC, tags: ["dismissed"], mode: "auto", idleMs: 1000,
    lastGhosts: [
      gh("extend", "pillar hop", "drawn-over", ["pillar-hop"]),
      gh("finish", "platform row", "esc"),
      gh("extend", "coin arc", "drawn-over", ["coin-arc"]),
    ] });
}

// ---------------------------------------------------------------------------
// A second staircase/gap session with history, so variety has runs to score
// ---------------------------------------------------------------------------

const MIXED = "seed-mixed";

function mixedA(): SeedSpec {
  const s = new Sketch().ground(0, 30).tick(1500);
  s.strokes([run(34, 37, Y), run(41, 44, Y)], G, 500);
  return s.spec({ name: "mixed-1-gaps", family: "gaps", sessionId: MIXED, tags: ["finish"], mode: "auto", idleMs: 700 });
}

function mixedB(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(34, 37).ground(41, 44).ground(48, 51).tick(1500);
  s.strokes(steps(54, Y - 1, 2, 2, 1), B, 450);
  return s.spec({ name: "mixed-2-steps", family: "staircase", sessionId: MIXED, tags: ["finish"], mode: "auto", idleMs: 500,
    lastGhosts: [gh("finish", "third platform", "accepted", ["gap-run"])] });
}

function mixedC(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(34, 37).ground(41, 44).ground(48, 51).rect(54, 14, 55, 14).rect(56, 13, 57, 13).rect(58, 12, 59, 12).tick(1500);
  s.stroke(run(60, 66, 12), G, 90);
  return s.spec({ name: "mixed-3-high-run", family: "misc", sessionId: MIXED, tags: ["extend"], mode: "auto", idleMs: 2600,
    lastGhosts: [gh("finish", "third platform", "accepted", ["gap-run"]), gh("finish", "one more step", "accepted", ["staircase"])] });
}

function mixedD(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(34, 37).ground(41, 44).ground(48, 51).rect(54, 14, 55, 14).rect(56, 13, 57, 13).rect(58, 12, 59, 12).rect(60, 12, 66, 12, G).tick(1500);
  s.place("coin", [[68, 10], [69, 9], [70, 9]], 300);
  return s.spec({ name: "mixed-4-coins", family: "coins", sessionId: MIXED, tags: ["coin-arc"], mode: "auto", idleMs: 500,
    lastGhosts: [
      gh("finish", "third platform", "accepted", ["gap-run"]),
      gh("finish", "one more step", "accepted", ["staircase"]),
      gh("extend", "high run", "accepted", ["rest"]),
    ] });
}

function mixedE(): SeedSpec {
  const s = new Sketch().ground(0, 30).ground(34, 37).ground(41, 44).ground(48, 51).rect(54, 14, 55, 14).rect(56, 13, 57, 13).rect(58, 12, 59, 12).rect(60, 12, 66, 12, G).ground(75, 80).tick(1500);
  s.place("coin", [[68, 10], [69, 9], [70, 9], [71, 9], [72, 10]], 200);
  s.tick(1000).stroke(run(81, 88, Y), G, 70);
  return s.spec({ name: "mixed-5-extend", family: "misc", sessionId: MIXED, tags: ["extend"], mode: "auto", idleMs: 2800,
    lastGhosts: [
      gh("finish", "third platform", "accepted", ["gap-run"]),
      gh("finish", "one more step", "accepted", ["staircase"]),
      gh("extend", "high run", "accepted", ["rest"]),
      gh("finish", "coin arc down", "accepted", ["coin-arc"]),
    ],
    expect: { act: true, kinds: ["extend"] } });
}

/** Every seed fixture, in session order. */
export const SEED_FIXTURES: readonly (() => SeedSpec)[] = [
  stairsUp2, stairsUp1, stairsDown, stairsFloating, stairsTwoSteps, stairsSolidHill,
  gapRun3, gapRunIncreasing, gapAtFrontier, singlePitBehind, halfBlockHops, gapRunMidStroke,
  pillarHop, risingPlatforms, alternatingPlatforms, questionRow, ledgeWithCeiling,
  coinArcs, coinArcPartial, coinLadder, floorCoins, riskyCoins, fruitOnHigh,
  tunnel, verticalTower, zigzagWalls, wallWithPassage, dropShaft,
  widePit, tallWall, highLedge, pitWithHighPlatform, longPitMidLevel,
  slimeFloor, enemyGate, ultraslimePlatform,
  freshStart, erasing, requested, sendBack, acceptedGhost, speedrunFlat, questionField, levelEnd, halfBridge, varietyPressure, afterDismissals,
  mixedA, mixedB, mixedC, mixedD, mixedE,
];
