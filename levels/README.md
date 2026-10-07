# Levels: reference levels and test fixtures (G-31)

These are lab-made levels in save format v2, built from ASCII sources that people can edit:

- **Reference levels** (`reference/<type>-<n>.json`). There are three of each type: parkour, maze, collect-a-thon, story and speedrun. All are 200x20, and the physics-exact playtest agent has beaten each one from the start to the flag. They are measured with `@measure` and sliced into `reference/chunks.json`, which the brief uses to pick examples ("sections others have drawn here", `apps/editor/src/fill/examples.ts`).
- **Fixtures** (`fixtures/*.json`). These are small situations for other modules' tests: `unbeatable-gap`, `staircase-mid-flight`, `coin-floor` and `enemy-cluster`.
- **`index.json`** lists every level with its file, its type, the agent's verdict (and how many seconds it takes the agent) and the type numbers below.

Any reference level opens in the editor with Load, like a saved level.

## Commands

```sh
npx tsx levels/build.ts             # build everything, run the agent, write JSON + index + chunks
npx tsx levels/build.ts --check     # same checks, writes nothing; exit 1 if a file is stale or a level fails
npx tsx levels/build.ts --report    # also print each level's type numbers
npx tsx levels/build.ts maze-2      # only these levels (index and chunks are not rewritten)
npx tsx levels/build.ts --no-verify # skip the agent while drafting
npx tsx levels/show.ts maze-2 80 160  # print a level with the agent's route ('*'), columns 80..159
npx vitest run --config levels/vitest.config.ts   # the tests
npx tsc --noEmit -p levels                        # typecheck
```

The root `vite.config.ts` and `tsconfig.json` do not list `levels/` yet. Until they do, use the two commands above.

## Source format (`src/<name>.txt`)

```text
; comment lines start with ';' (because '#' is grass)
@name parkour-1            must match the file name
@kind reference            reference | fixture
@type parkour              parkour | maze | collect-a-thon | story | speedrun (references only)
@title Pillar Run
@expect beatable           beatable (default) | unbeatable | open (no flag: reach the frontier)
@note Any text; repeatable
@sign Text for a sign      one per 'i', in x order
@size 200x20               optional; the default is 200x20

== start                   a section; sections are placed side by side
..........
..P.......
##########
dddddddddd
```

Glyphs are the `@measure` ASCII alphabet. Terrain: `.` empty, `#` grass, `d` dirt, `B` block, `=` half block, `?` question block. Entities: `c` coin, `f` fruit, `s` slime, `U` ultraslime, `F` flag, `i` sign, `P` start.

How sections are placed:

- Every row in a section must be the same width. A short row would open a hole without anyone noticing, so it is an error.
- A section can be shorter than 20 rows. It is bottom-aligned, so flat ground needs only its top rows and the dirt below them.
- Sections join left to right. If they add up to fewer than 200 columns, the build pads the right side with empty columns.

What the build does with the map:

- It needs exactly one `P`. It also needs exactly one `F`, except for `@expect open` levels, which have none.
- Every tile and entity is authored by the person, entity ids run `e1..eN` in x order, and the goal is set to the flag.
- Enemy patrol spans are derived from the floor under each enemy, the same way the editor derives them.

Mistakes are reported as `file:line: message`.

## What the build checks

1. **Agent.** It runs `@physsim` `search` (thorough passes, 30 s cap) from the start to the flag's cell. For `open` levels the target is the rightmost standable column. `unbeatable` levels must make the agent fail without timing out. The agent models the knight and the tiles exactly. It does not model enemies, so lint covers them.
2. **Lint** (reference levels only):
   - The start and the flag stand on ground.
   - Every enemy has at least 4 tiles of patrol and is more than 1 tile from any jump landing.
   - No collectable is sealed in by tiles.
   - There is a rest at least every 72 columns (three screens).
3. **Type fit** (reference levels only). The numbers below are measured with `@measure` (`lib/types.ts`), and each must fall inside its type's band. The bands put `prompts/brief/types.md` into numbers. Gap fractions are relative to `maxGapRun` (11 tiles).

| Type | Bands |
| --- | --- |
| parkour | density ≤ 0.2; ≥ 60% of gaps ≥ 0.6 of the limit; ≥ 10 gap jumps; bursty takeoffs (rhythm CV ≥ 0.3); rests on ≥ 2 screens; ≤ 16 rewards, ≤ 4 enemies; mean difficulty ≥ 0.25, hardest screen ≥ 0.5 |
| maze | density ≥ 0.4; verticality ≥ 0.3; linearity ≤ 0.7; walls on ≥ 4 screens; tunnels on ≥ 2; ≥ 2 fruit |
| collect-a-thon | ≥ 5 rewards per screen; reward spacing 1-9 tiles; ≥ 80% of coins on arcs; ≤ 10% on the floor; ≤ 35% of gaps at the limit |
| story | ≥ 3 signs; rests on ≥ 4 screens; mean difficulty ≤ 0.2; no gap ≥ 0.6 of the limit; ≤ 2 enemies |
| speedrun | steady takeoffs (rhythm CV ≤ 0.15); linearity ≥ 0.85; verticality ≤ 0.15; ≥ 80% of gaps 0.4-0.8; landings ≥ 3 wide on average; ≥ 15 jumps; walls on ≤ 1 screen; ≤ 2 enemies |

Two notes on the bands:

- *Rhythm CV* is the coefficient of variation of the distance between one jump's takeoff and the next.
- Mazes have no gap band. `@measure`'s arcs assume open sky, so under a roof they count jumps that nobody can make.

## Fixtures

| Name | What it is | Expectation |
| --- | --- | --- |
| `unbeatable-gap` | 24 tiles of run-up, then a 14-tile pit (more than `maxGapRun` 11, beyond even ULTRA timing), then a flag | Agent exhausts its search; `blockedAt` is at the pit edge |
| `staircase-mid-flight` | Start ground and four rising steps, stopped halfway; no flag; the rest of the level is empty | `staircase` pattern; start reaches the top step (the frontier) |
| `coin-floor` | A collect-a-thon draft with rows of coins lying on the floor, plus one proper arc | `coin-row-on-floor`; floor share ≥ 0.5; fails the collect-a-thon coin rule |
| `enemy-cluster` | Five enemies packed around two landings | Pressure ≥ 1; lint flags short patrols and enemies on landings; geometry beatable |

Load one in a test with `loadFixture("coin-floor")`.

## Using the levels from code

```ts
import { loadReferenceLevels, loadFixture, referenceExampleLibrary } from "../../levels"; // Node (fs)
const parkour = loadReferenceLevels("parkour");        // [{ name, type, title, level: LevelSnapshot, entry }]
const lib = referenceExampleLibrary();                 // ExampleLibrary over chunks.json
buildBrief({ ..., examples: { library: lib } });       // fill/brief.ts
```

In the browser bundle, import the JSON directly:

```ts
import chunksJson from "../../../../levels/reference/chunks.json";
new ExampleLibrary(chunksFromJson(chunksJson));
```

`chunksFromJson` lives in `levels/lib/chunks.ts` and has no file-system code. Each chunk is an `@measure` `Chunk` (rows, tags, numbers, measures) plus `levelType`. The level is sliced at rests using the default slice options: chunks are 8 to 32 columns wide, and a long rest keeps a 3-column margin on each side.

## Adding a level

1. Copy a source in `src/`, rename it, and set `@name`.
2. Draw it.
3. Run `npx tsx levels/build.ts --report <name>`. Fix anything it reports: the agent's furthest standing cell, lint, or type bands.
4. Run `npx tsx levels/build.ts` to rewrite the index and the chunks. Then run the tests.
