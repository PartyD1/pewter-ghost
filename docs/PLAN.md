# Pewter Ghost — build spec

Generated from the published plans (Pewter Ghost; Building Pewter Ghost, v5). This is the source of truth for builders. Contracts are in apps/editor/src/contracts.ts and numbers in apps/editor/src/suggest/config.ts.

# Part 1 — Plan (what and why)

    01
## Executive Summary

    Keep the editor people liked, remove the chat and the boxes people fought, and put a language model where the hands already are: as an autofill that draws the next piece of the level as a faint ghost. The question is whether that makes designing a 2D platformer better, and the work is getting the LLM autofill as good as it can be.

### The questions

- Does an LLM autofill for 2D platformer design make the UX better?

- How do you determine when to autofill?

- How do we balance speed with certainty?

- Later: does a generative-algorithm autofill work better? Does making the level purely with an LLM or a generator work better?

- "Works better" means satisfaction while making the level, and how other people rate the level when they play it.

### What changes for the person

- No chat, no selection boxes, no setup form. You draw; Pewter shows a faint ghost of what might come next; Tab accepts, drawing elsewhere dismisses.

- Three kinds of help: Finish the structure you're in, Extend the level by a stretch that fits, Fix what can't be played, including removing or moving your own tiles.

- Nothing is shown that the game's own physics can't beat. If you leave the level unbeatable, Ghost offers the repair.

- Nothing lands without your keypress.

### The bar
A tool is something you reach for because it does the job better than your hands. The first study told us what people gave Pewter to do (block out a level fast, then fix the parts that matter by hand) and why they stopped (68% repaired its output; it had no sense of difficulty; they ignored its text; almost all hit editor bugs). So "feels like a tool" means: I draw, it offers the next piece where I'm looking, the piece is right more often than not, it's sometimes something I wouldn't have thought of, and when it's wrong it costs me nothing.

### The five things most likely to decide whether this works

- The LLM draws the suggestion itself (§6). It sees the level as a grid and answers with tiles. That is the thing being studied, so there is no rules engine standing in for it.

- Confidence is the speed-versus-certainty dial (§7). The model says how sure it is; high confidence shows at once, low confidence waits for a pause. Nothing is hidden for being unsure, since a ghost costs nothing to ignore.

- Playability before anything is shown (§10). Every ghost is played by the physics-exact agent first. The agent exists and matches the real game to the pixel.

- Teach the model what good looks like (§9). The style, pattern and difficulty knowledge from the earlier plan survives as what goes into the model's context and into the checks on its output, not as pickers for the user.

- The ghost contract (§5): faint, local, one at a time, dismissed by drawing. If every wrong suggestion costs nothing, the model can be eager while we learn.

    Order of work: the LLM autofill first and to a high standard. A generative-algorithm autofill as a comparison comes after. Jev as a cheap timing system is a test for much later (§12).

  

    03
## The Core Design Problem

    Help a novice level designer while they draw, without ever getting in the way, and sometimes give them an idea they wouldn't have had.

    Design problem statement. Build an assistant that (1) notices what a person is building from their last few placements, (2) decides when a suggestion is welcome and when silence is better, (3) offers one faint, local, accept-or-ignore suggestion at a time, (4) finishes structures reliably and extends levels with variety, and (5) can fix what the person placed when it can't be played, while the person remains the author of every tile that lands.

       |  | Tension | What we choose

         | Eager enough to help vs. quiet enough not to nag | Make a wrong ghost free (§5), then be eager; let dismissals raise the bar per person (§7).

         | Finish what they're doing vs. offer something new | Both, as different kinds with different triggers. Finish earns trust; Extend earns the word "tool".

         | Ask the person what they want vs. read it from the drawing | Read it from the drawing. No setup form; the model says what it thinks the level is trying to be.

         | Only add vs. also remove | Fix may remove, shown as a crossed-out ghost, accepted as one undoable step.

         | Fast heuristics vs. a model that understands | The model draws. Speculation hides most of the latency; confidence decides how long to wait for the rest.

         | One assistant for everyone vs. one that adapts | Thresholds adapt per person from the accept/dismiss log; the research reads that log.

  

    04
## The Idea in One Screen

    You draw. Pewter watches. When it thinks it knows what comes next, a faint version appears where you're working.

        What you drew (three steps)
        Pewter's ghost: the next two steps and a coin at the top
        Tab accept · Esc dismiss · or just keep drawing

### Finish
Completes the structure you're in the middle of: the rest of the staircase, the far side of the pit, the last two coins of an arc. Feels instant. This is where trust is earned, and it is the first thing we build.

### Extend
Proposes the next stretch of level in your style, a screen or so ahead, shown as a ghost you can scroll to. Takes up to a second. This is where ideas come from, and where variety is a requirement, not a hope.

### Fix
Changes something you placed: widens a gap the knight can't jump, thins a cluster of enemies, moves a coin off a platform in a "tricky coins" level. Shown as a ghost diff: what goes, what comes. Accepted as one step, undone as one step.

      A Fix ghost: the pit you dug is 13 wide and the knight's best jump is 12. Pewter offers a two-tile ledge in the middle with coins marking the route. The pit stays yours; Tab adds the ledge.

  

    05
## The Ghost Contract: Why a Wrong Suggestion Costs Nothing

    "When should it jump in" is the hard question, and most of the answer is not clever AI. It is a contract with the person that makes a bad guess harmless, the same contract code editors arrived at. If every rule below holds, we can afford to be eager and let the data tune the rest.

       |  | Rule | On screen | Why it matters | What the study said

         | Always faint | Ghost tiles at low opacity with a dashed edge; never solid, never the real tile colour. | Nobody mistakes a suggestion for something they placed. | People judged results on the canvas alone; the canvas has to be honest.

         | Always where you are | Finish attaches to the structure under your last placements; Extend starts at the frontier of the level; Fix sits on the problem. | You never have to look for it. | Changes the old Pewter made were "somewhere in the box"; people hunted for them.

         | Never moves what you made unless it says so | Finish and Extend only add. Fix shows removals crossed out and never applies itself. | Authorship stays yours. | "Most believed they were the ones guiding the design."

         | One at a time | At most one ghost on screen; a new one replaces the old. | No clutter, no choosing. | Mask tiles and X-hatching were the most-hated visual noise.

         | Keep drawing and it goes away | Any placement outside the ghost dismisses it. Placing on a ghost tile accepts that tile only. | Rejecting costs zero keystrokes. | People switched to manual whenever the AI got in the way; now switching is rejecting.

         | Keys exist too | Tab accepts; Esc dismisses; Ctrl+Space asks for a suggestion now. | When automatic timing is wrong, people can still pull. | —

         | Silence has a cool-down | After a dismissal, no new ghost on the same structure for a few seconds; after three in a row, nothing until asked or until something new starts. | It never feels like nagging. | "Large amount of frustration" came from the AI not following instructions; nagging would be the autocomplete version of that.

         | Accepted tiles look like yours | A ghost becomes a normal tile on accept; authorship is recorded invisibly. | The level stays one thing, not a patchwork. | "Low perceived contribution is a distinct psychological state": don't make the AI's tiles look foreign.

         | Fix is the only interrupter | Finish and Extend wait for a pause; Fix may appear while you're still drawing, because the problem is already there. | Safety beats politeness. | People asked for traversable gaps and less clutter ("1,000%").

    The timing problem, restated. Under these rules a suggestion shown too early is a faint shape nobody looks at, and one shown too late is a faint shape nobody needs. Both cost nothing. The real risk is the third case: a suggestion that is plausible but wrong, accepted by someone who didn't look closely. We handle that one with Fix (which catches the consequences) and, later, with the playability agent (which prevents them).

  

    06
## What the Model Sees and What It Draws

    One call, fired while you draw. In: a picture of the level around your cursor and what you just did. Out: tiles, and how sure the model is.

### What goes in

- A window of the level around the last placement as an ASCII grid with column and row rulers and a legend (the format the audit tested; it took the replay pass rate from 42 to 45 of 48).

- The last 8–12 placements with timing, so the model can see a pattern mid-flight and whether you have paused.

- The knight's limits in plain numbers: longest standing jump, longest running jump, highest rise.

- A short design brief (§9): what good platformer sections look like, what the drawing so far suggests the level is trying to be, and what was recently accepted or dismissed.

- Nothing typed by the person. There is no setup form; the model reads intent from the drawing.

### What comes out

```
{
  "act": true,
  "kind": "finish" | "extend" | "fix",
  "adds":    [{"x": 47, "y": 10, "tile": "grass"}, ...],
  "removes": [{"x": 38, "y": 12}],             // fix only
  "entities": [{"kind": "coin", "x": 49, "y": 8}],
  "confidence": 0.0–1.0,
  "label": "staircase, two more steps"
}
```

        The tiles are the model's own. They are checked for shape (in bounds, on the grid, not over authored tiles unless it is a fix), then played by the agent (§10). Only then do they become a ghost.

    Why the model draws rather than chooses. The earlier plan had the model pick among algorithm-made candidates. That would have answered a question about choosing, not about LLM autofill. The lab's question is whether an LLM filling in the level is better for the person, so the LLM fills in the level. The audit's warning stands (it produced the same recipe 36 of 36 times when asked open-ended questions in the old chat), so §9 is about giving it the knowledge and the feedback to do better, and §18 is about measuring whether it does.

  

    07
## When Pewter Jumps In: Confidence as the Dial

    The model decides whether there is anything worth suggesting and says how sure it is. Confidence sets how soon the ghost appears, not whether it exists.

### The loop

- Every placement fires the call in the background. At most one is in flight; a newer placement replaces it. Most calls are wasted, which is fine: the one that lands is ready before you stop.

- The model answers with act, tiles and confidence. act: false means "nothing worth saying yet" and is a normal answer.

- Verification (§10) runs on the tiles. A failed suggestion is dropped or sent back once with the failure described.

- Confidence sets the moment. High: show now, even mid-stroke. Medium: show at the next pause. Low: hold it and show only if the pause stretches or you ask with Ctrl+Space. The thresholds are numbers in a config and the first thing we tune.

- One ghost at a time. A new suggestion replaces the old one. Fix may interrupt a Finish ghost when the problem is an unbeatable level.

- Cool-downs. After a dismissal, nothing on the same structure for a few seconds; after three dismissals in a row, nothing until asked or until a new structure starts.

### Speed versus certainty

       |  | Lever | Faster | Surer | Where we start

         | Model size | Small model, sub-second | Larger model, better tiles | Smallest model that passes the offline suite; upgrade only on evidence

         | Context window size | Small grid window, fewer tokens | Wider window, better fit to the level | About 24×12 tiles around the cursor plus a one-line summary of the rest

         | Confidence threshold | Show everything at once | Show only high-confidence ghosts | Everything shows; confidence only changes when

         | Verification depth | Rule check only | Full physics search | Rule check first, agent in a worker with a time cap; unverified ghosts are not shown

         | Speculation | Call on every placement | Call only on pause | Every placement, so the answer is usually ready before the pause

    Confidence has to mean something. The development loop (§18) plots acceptance against stated confidence; if the curve is flat, the prompt and the few-shot examples change until it is not.

  

    08
## What Gets Suggested

    Three kinds. The model picks the kind; the ghost layer shows them the same way.

### Finish
Complete the structure being drawn: the next steps of a staircase, the far end of a platform, the floor of a pit, the roof of a corridor. Small, local, instant. This is what makes it feel like autocomplete.

### Extend
Propose the next stretch of level beyond the frontier, in keeping with what has been drawn so far, and different from the last few things suggested. Larger, shown one screen ahead, allowed up to a second. This is where the model can give an idea the person did not have.

### Fix
Point at a problem and propose the repair, including removing or moving the person's own tiles: a gap the knight cannot clear, a wall too tall, a pile of six slimes, coins laid flat on a platform in a level that is clearly about coins, a level that cannot be finished. Removals are drawn crossed out. Fix is the one kind that may interrupt, and only for playability.

### What Ghost places
Terrain, enemies and collectables, with collectables first among equals: coins that trace the jump the knight would take, rewards that cost a risk. Enemies go where they have room to patrol and never on a landing. The design brief (§9) says this to the model; the verifier (§10) checks it.

  

    09
## Teaching the Model What Good Looks Like

    The style and level-type material from the earlier plan survives in one role: giving the model the means to tell a good section from a bad one. None of it is a form the person fills in.

### Design knowledge in the brief

- A pattern catalogue. Named platformer patterns with a one-line rule each: staircase, gap run, pillar hop, guarded reward, coin arc, rest, reveal, dead end with reward, one-way drop, flow run. The brief names which ones the drawing already uses.

- What each level type wants. Parkour: sparse, bursty rhythm, gaps near the knight's limit. Maze: dense, vertical, branching. Collect-a-thon: rewards every 6–9 tiles, coins on arcs. Story: rests and reveals, signs. Speedrun: platforms at jump rhythm. The model infers the type from the drawing and says which it thinks it is.

- Classic styles as descriptions. What makes a section feel like a classic Mario or Sonic stretch, written as rules about rhythm, gap width, reward placement and enemy direction. No level data is loaded or copied.

- Difficulty as numbers. Gap width against the jump tables, rise against max jump height, enemy proximity to landings, platform width. The brief gives the current numbers for the last screen so the model can keep or change them deliberately.

- Variety. The last few accepted and dismissed suggestions, with the instruction that an Extend must differ from them.

### Design knowledge as the check

- The same measurements run on the model's output before it is shown: a suggestion that pushes density or gap width outside what the drawing has established is sent back once with the numbers.

- The offline suite (§18) scores suggestions on the same scale, so prompt changes are judged against the catalogue, not by eye.

- Reference levels come in here later: lab-authored levels measured into numbers and sliced into examples for the brief, so "what good looks like" is shown as well as described. Fed in and learned, as agreed, after the core loop works.

    Why not pickers. A type and difficulty form was in the earlier plan. It was cut because it answers a question we are not asking (does telling the tool your intent help?) and because the first study showed people barely read Pewter's text. The model should infer intent from the drawing; if it cannot, that is a finding about the model, not a reason to add a form.

  

    10
## Playability Before Anything Is Shown

    Every ghost has been played before you see it, by an agent that uses the game's own physics. If the level itself cannot be finished, Ghost says so and offers the fix.

### How

- A fast rule check first: every surface in the suggestion reachable by the jump tables. Milliseconds.

- Then the playtest agent in a Web Worker, searching from the nearest standable tile before the suggestion through to the far side, with a time cap of a few hundred milliseconds. The agent was built during the audit and its trajectories match the real game to 6e-14 px.

- Fail: drop the suggestion, or send it back to the model once with the failure ("the gap at column 41 is 9 wide; the knight clears 6") and verify again.

- Pass: the ghost appears. On accept, the agent's route is drawn for two seconds, which is the explanation people actually look at.

### Playability of the whole level

- Every few seconds of idle time, the agent plays the level from start to the frontier.

- If it cannot get through, a Fix ghost appears at the first blocking point with the fewest-tile repair. This is the "make it playable if the user didn't" case, and it is a Fix like any other: crossed-out removals, faint additions, Tab to apply, one undo.

- In Play mode, the route the agent found is available on a key so people can see how a section is meant to be beaten.

    Feasibility: the agent, its validator against the real game, and the rule checker exist in audit-prototypes/. The new work is running the agent in a worker with a time cap and wiring the result into the ghost layer, which is small enough for Phase 1.

  

    11
## The Co-Creative Interaction Model

    Mixed initiative with a hard rule: Pewter may speak whenever the contract allows, but nothing lands without the person. Initiative is frequent and cheap; authority is never shared.

```

flowchart LR
  C["Open the editor"] --> D["Draw (human)"]
  D -->|"every placement"| K["Model: wait / finish / extend / fix, with tiles and a confidence"]
  K -->|"wait"| D
  K -->|"show"| G["Ghost on the canvas (one)"]
  G -->|"Tab / paint on it"| A["Accept → tiles, authorship logged"]
  G -->|"Esc / draw elsewhere / expire"| R["Dismiss → threshold rises, logged"]
  A --> D
  R --> D
  D -->|"pause at frontier"| K
  D -->|"problem appears"| K

```

       |  | Dimension | Old Pewter | Pewter Ghost

         | Initiative | Human only; the AI was told not to ask | AI initiates constantly but cheaply; the person can also pull with Ctrl+Space

         | Authority | AI edits landed instantly, unmarked, sometimes over the person's tiles | Nothing lands without a keypress; removals are always shown first

         | Contribution | Execution of commands; one recipe for anything open-ended | Finish (execution), Extend (ideas), Fix (judgement); variety required and measured

         | Channel | Chat text people didn't read | The canvas only; one short status line; no prose

         | Context | A prose height map, stale box coordinates, no memory | The actual grid around the work, the design brief, the measured numbers of the last screen, and the accept/dismiss history

         | Correction | Re-prompt a model with no memory, or fix by hand | Dismiss by drawing; or accept a Fix ghost; one undo per ghost

         | Explanation | None, by instruction | A label on the ghost ("guarded reward"); optional, since the study says people watch the canvas

         | Learning | None | Per-person thresholds from the log; the model sees recent history

### Who decides what

       |  | Decision | Owner

         | What the level is for (type, difficulty, length, theme) | Person, by drawing; the model says what it thinks the level is and follows the drawing

         | When to suggest | Pewter, within the contract and the person's thresholds

         | What to suggest | Pewter (the model chooses; the engine draws)

         | Whether it lands | Person, always

         | Removing the person's tiles | Only through an accepted Fix ghost

         | Whether a level is playable | The physics agent, later; until then, the jump tables

  

    12
## LLM First; Algorithm and Jev Much Later

    The earlier plan weighed three engines against each other. The lab's direction is simpler: perfect the LLM autofill now, build the comparisons afterwards.

       |  | Filler | What it is | When | Why

         | LLM autofill | The model reads the grid and draws the suggestion (§6). All tuning, evaluation and interaction work is on this. | Now | It is the research object. The question "does LLM autofill make the UX better" cannot be answered with anything else in the loop.

         | Generative-algorithm autofill | The audit's pattern-based chunk generator producing suggestions through the same ghost layer, with its own simple timing rule. | After the LLM autofill is good | The comparison on the lab's slide: does a generator do as well without a model?

         | Pure generation (LLM or algorithm makes the whole level) | An end-to-end mode. | Set aside | Not needed for the current question; revisit when the autofill is done.

         | Jev as a timing system | A cheap external service deciding when to jump in. | Very late | A possible cost reduction once we know what good timing looks like from the LLM's own confidence.

    So that these can be added without rework, the editor talks to any filler through one small interface: given the level window and recent placements, return a suggestion with a confidence. The LLM filler is the only implementation built now.

  

    13
## Proposed User Flow

- Open. One sentence: "Draw a level. Pewter suggests the next piece as a ghost; press Tab to keep it." A 60-second guided try (draw three steps, see the ghost, press Tab) or straight to a blank level.

- Open the editor. No form. A one-line hint on first use: "Draw. Grey tiles are suggestions. Tab keeps them."

- Canvas. Flat ground, a start marker, and a goal marker at the chosen length. The palette is the one people know.

- Draw. Place three steps; a ghost of the next two appears before you've paused. Tab. Keep going.

- Pause at the edge. A faint stretch appears a screen ahead: a pit with a landing and coins marking the jump. Scroll to it or ignore it. Tab keeps it; drawing something else clears it.

- Dig a pit too wide. A Fix ghost shows a two-tile ledge in the middle with the problem underlined. Tab adds the ledge; the pit stays yours.

- Change your mind. Start a tower after three screens of flat parkour. The next ghosts follow the tower; the status line updates what Ghost thinks you are making.

- Ask. Ctrl+Space anywhere: Pewter offers whatever it would have offered, now.

- Play. Start to goal with a fair knight. The completion screen shows time, deaths and coins; later, the hardest jump.

- Finish. Save. A small summary: tiles you drew, ghosts you kept, ghosts you dismissed. (Research only at first; a product feature if people like it.)

  

    14
## Proposed Information Architecture

      Top bar · Select · Paint · Erase · Pan · Undo/Redo · ▶ Play · Save · ? Help
      Level canvas
Tiles · one ghost (faint, dashed) · crossed-out removals for Fix · start and goal markers · optional label on the ghost ("guarded reward")
      Side strip (narrow, collapsible)
        Ghost status · what it thinks you are making · last suggestion and confidence
        Ghost status · "staircase · 2 steps · Tab to keep" · or "quiet" · Ctrl+Space to ask
        Suggestions switch · off / Finish only / Finish + Extend / all

      Status line · "checking the jump at x=112…" · last Play result

       |  | Gone from old Pewter | Why

         | Chat panel, per-box conversations, typing indicator | Nobody read it; the canvas is the channel.

         | Selection boxes, tabs with coordinates, Z-levels, Empty tile and X-hatching | The mode people fought; the model doesn't need a box to know where you are.

         | Controls tab of 15 shortcuts | Replaced by visible modes and three keys that matter.

         | "Save & Reload" | Renamed "Save task"; cheap to keep.

  

    15
## Visual and Interaction Design

### The ghost

- Low opacity (about 35%), dashed 1-px edge in an accent colour, drawn above tiles and below the cursor.

- Removals in a Fix ghost: the existing tile dimmed with a crossed outline, never erased until accepted.

- An Extend ghost beyond the viewport shows a small arrow at the screen edge; scrolling to it is optional.

- Accept animation: ghost tiles snap to full opacity over about 150 ms; no fake delays; respects reduced-motion.

- The optional label sits above the ghost in small type and fades after two seconds.

### Input

- Left-click paints in Paint mode; Select is the default so a first exploratory click does nothing destructive.

- Space-drag or two-finger drag pans; no middle-button requirement; no right-drag anywhere.

- Tab accept, Esc dismiss, Ctrl+Space ask, Ctrl+Z undo (one ghost = one step).

- Painting on a ghost tile accepts just that tile; painting elsewhere dismisses the ghost.

- Works at 1366×768 and on a trackpad, because that is what participants bring.

### Accessibility

- Everything the ghost says is also in the status strip as text.

- Ghost and removal marks don't rely on colour alone (dashed vs. crossed outlines).

- Keyboard-only placement is out of scope for the prototype, but every suggestion control is a key.

### Things we will not do

- No avatar, no personality copy, no "thinking…" bubbles. The study says people watch the canvas; the canvas should be the only thing that changes.

- No more than one ghost at a time, ever, even when the model has two ideas.

- No auto-apply, even for "obvious" fixes.

  

    17
## Research Framing

    Stated the lab's way, with the measures the lab named. Study design is for later; this is what the work is for.

### Questions

- Does an LLM autofill for 2D platformer design make the UX better?

- How do you determine when to autofill? (§7: the model's own confidence, speculative calls, cool-downs.)

- How do we balance speed with certainty? (§7: model size, window size, confidence thresholds, verification depth.)

- Later: does a generative autofill work better? Does making the level purely with an LLM or a generator work better?

### What "better" means

- Satisfaction while making the level.

- How other people rate the level when they play it.

- Supporting signals: how often suggestions are dismissed versus accepted; whether people feel the suggestions prompted ideas they would not have had; diversity across the levels made; difficulty of the levels by obstacle count, configuration and simulation.

    When a study happens, the comparison on the slide is: build a level alone, with the algorithm autofill, with the LLM autofill; then have participants play each other's levels. The build keeps that possible (a condition switch, the log, "Save task") without designing the study now.

  

    18
## How We Will Know the Autofill Is Getting Better

    A development loop, run weekly on the lab's own sessions, long before any study.

       |  | Signal | From | Getting better looks like

         | Accepted vs dismissed, per kind | Ghost log | Acceptance rising; drawn-over dismissals falling within a session

         | Confidence calibration | Stated confidence vs acceptance | High-confidence ghosts accepted more than low; a curve, not a flat line

         | Verified rate | Verifier | Share of model suggestions that pass playability on the first try rising; send-backs falling

         | Variety | Pattern measurements on accepted Extend ghosts | Distinct patterns per session rising; no pattern three times running

         | Ideas prompted | Short question after a session | "Did a suggestion give you an idea you would not have had?" trending yes

         | Satisfaction | Short question after a session | Up, and not below drawing alone

         | Diversity across levels | Expressive-range measures on saved levels | Levels made with Ghost at least as spread out as levels made alone

         | Difficulty | Obstacle counts, configuration, agent simulation | Matches what the drawing was going for; no accidental spikes from suggestions

         | Latency and fallback | Call log | Finish ghosts within 200 ms of the third placement; Extend within 1 s; dropped-for-timeout rate under 10%

         | Hand repair after accept | Edits inside a ghost's cells within 60 s | Falling. The first study's 68% repair rate is the number to beat

### The offline suite

    Recorded sessions are replayed through the model offline: the same windows and placements, scored for playability, pattern fit, variety and calibration. Every prompt, model or window-size change runs through it before it ships. This is how "getting the LLM to perfection" becomes a loop rather than an opinion.

  

    19
## Risks

       |  | Risk | Likelihood | Impact | What we do

         | Suggestions feel like nagging | Medium | High | The contract (§5); per-person thresholds; cool-downs; the pilot tunes the numbers; Ctrl+Space means people can always pull instead of being pushed.

         | Extend is samey (the one-recipe problem returns) | Medium | High | Variety is a request parameter, a metric and a gate: Extend doesn't ship until two level types look different and five ghosts show four kinds.

         | The model is too slow to feel like autocomplete | Medium | High | Speculation, a small model, a short window, a timeout after which the suggestion is simply dropped. Latency and drop rate are logged from day one.

         | The model's confidence means nothing (flat calibration) | Medium | High | Measure weekly; try stated confidence, token probabilities and two-sample agreement; change prompts and examples until the curve bends.

         | Plausible-but-wrong ghosts get accepted | Medium | Medium | Fix catches consequences; the playability agent in phase 4 prevents impossible ghosts; repair-after-accept is tracked.

         | The model misreads what the level is trying to be | Medium | Medium | It states its guess in the status line; the brief carries the measured numbers of the last screens; dismissals feed back.

         | Reference levels raise licensing questions | Low | Medium | Lab-authored and participant levels first; classic levels measured, never shipped.

         | The model draws unplayable or samey sections | High at first | High | Verification drops the unplayable ones and sends them back once; the brief and the offline suite work on variety. This is the core of the work, not a side risk.

         | Scope creep into a game engine | Medium | Medium | Two new elements (goal, sign) early; jump-through platforms and flying enemies only after the autofill is good.

         | Newcomers lost in the old code | Medium | Medium | Copy, not fork; delete first; the companion doc's five-minute tour.

  

    20
## Open Questions

       |  | Question | Why it matters | Who

         | Which model, and how small can it be? | Speed versus certainty. Decided by the offline suite, not by default. | Model stream

         | How is confidence produced: the model's stated number, token probabilities, or agreement across two samples? | Calibration is what makes the timing dial work. | Model stream

         | How big a grid window, and how to summarise the rest of the level? | Context cost against fit to the whole level. | Model stream

         | How much design knowledge fits in the brief before it hurts? | Catalogue, type rules, numbers and examples compete for tokens. | Model stream

         | Should a failed verification go back to the model once, or be dropped? | Latency against a second chance at a good idea. | Team

         | Who draws the first reference levels? | Examples in the brief need a source we own. | Lab

         | Do we keep "Save task"? | Cheap to keep; it was the study's per-task save. | Lab

  

    21
## Where This Can Go

- The generative-algorithm autofill behind the same interface, for the comparison on the lab's slide.

- Pure generation modes (whole level from the LLM or the generator), once the autofill question is answered.

- Reference levels measured into numbers and sliced into examples for the brief; later, a fine-tuned small model trained on accepted ghosts if latency demands it.

- Jev as a cheap timing system, very late, compared against the LLM's own confidence on recorded sessions.

- Play mode with adjustable settings and sharing a level by code, as quality-of-life items when the core loop is solid.

- More elements (jump-through platforms, flying enemies) only when the autofill is good with the ones we have.

  

# Part 2 — Build plan (how)

    01
## Executive Summary

    A new, smaller repository built from Pewter's editor shell, with one level model, a ghost layer, and a language model that draws the next piece of the level as a suggestion. The work of the first quarter is making that LLM autofill as good as it can be.

    The plan document says what Pewter Ghost is and why. This document says how to build it. It assumes the reader has read the plan's first ten sections and knows TypeScript; it does not assume any knowledge of the current Pewter code, which §3 introduces.

### The five decisions this plan rests on

- Copy, don't fork. A new repository seeded by copying the editor shell from 83e2239; chat, selection boxes, tools and dead experiments are never brought over (§4).

- One level model first. One grid with an author on every tile and a stream of placement events. Phase 0, and everything waits on it (G-02).

- The model draws. One structured call takes a grid window and recent placements and returns tiles, entities and a confidence. No rules engine stands in for it and no chooser sits between it and the canvas. It is the research object (§8).

- Nothing unverified is shown. Every suggestion passes a shape check and the physics-exact playtest agent before it becomes a ghost, from Phase 1. If the level itself is unbeatable, Ghost offers the fix (§10).

- The offline suite is the development loop. Recorded sessions replayed through the model and scored for playability, fit, variety and calibration, before every prompt or model change. This is how "get the LLM to perfection" becomes measurable (G-20).

    What is deliberately later. A generative-algorithm autofill as a comparison, pure end-to-end generation, and Jev as a cheap timing system are all behind one small filler interface and are not built in the first quarter. Study design is not in this document beyond keeping a condition switch and the log so a study is possible when the lab wants one.

  

    02
## Guiding Principles

    Rules for the build, taken from the lab's direction and from what the audit and the first study showed.

#### The LLM is the subject
The question is whether an LLM autofill makes designing better. So the model produces the suggestion. Local code validates, verifies, measures and logs; it never decides what to draw. Any shortcut that moves drawing into heuristics changes the question.

#### Confidence sets the moment, not the gate
The model says how sure it is. High shows now, medium at the pause, low when asked. Nothing is hidden for being unsure, because a ghost costs nothing to ignore. Calibration is measured weekly.

#### Verified or not shown
Shape check, then the agent. A failed suggestion goes back to the model once with the failure described, or is dropped. No exceptions, including Finish.

#### One ghost at a time
Never two suggestions on screen. Fix may interrupt a Finish ghost when the problem is an unbeatable level.

#### Pewter may edit your tiles
Fix can remove or move what the person placed. Removals are crossed out, additions faint, one Tab applies both, one undo restores.

#### Instant small, one second big
Finish ghosts within 200 ms of the placement that completes a pattern. Extend and Fix may take up to a second. Painting never blocks on the network.

#### Teach, don't ask
No setup form. Design knowledge (patterns, type rules, difficulty numbers, examples) goes into the model's brief and into the checks on its output, so the model learns what good looks like without the person filling anything in.

#### Smallest model that passes
Do not default to a bigger model. The offline suite decides upgrades. Window size, few-shot count and model size are all dials the suite judges.

#### Reasons on the map
The first study found most participants ignored Pewter's text. Explanations are a five-word caption and, on accept, the agent's drawn route.

#### Later things stay later
Algorithm filler, pure generation, Jev, play-mode settings, sharing by code: behind interfaces, not in the quarter.

  

    03
## The Repository in Five Minutes

    About 10,700 lines of TypeScript. Half is the editor; a quarter is the AI chat and its tools; a quarter is dead code from earlier experiments.

#### The editor (Phaser 3.90, Vite)

- phaser/editorScene.ts (2,582 lines): the tilemap, painting, camera, undo snapshots, copy/paste, play mode with the knight, and the selection-box gestures, all in one file.

- phaser/UIScene.ts (976): toolbar, block palette, chat panel and box tabs, as DOM elements over the canvas.

- phaser/selectionBox.ts (1,959): boxes, their Z-levels and chat histories, and replaceAllBoxes(), which rebuilds the whole map from four overlapping tile stores after every change.

- phaser/ExternalClasses/: Slime and UltraSlime (enemies), Pathfinding, and worldFacts.ts (a prose description of the level for the AI; inaccurate).

- loadingScene.ts, colors.ts, main.ts: boot, assets, wiring. public/ holds the 15-tile Brackeys sheet Pewter draws with and a Kenney sheet (18 px) that is loaded but unused.

#### The AI and the dead weight

- languageModel/chatBox.ts, modelConnector.ts: per-box chat, the system prompt, the Gemini tool loop through LangChain.

- languageModel/tools/: place a tile, place a rectangle, clear, get facts, and several that never worked (the always-failing relativeGeneration was called in 23 of 60 replay turns).

- phaser/gameScene.ts, enemySystem/, regenerator.ts, RegenerationTools.ts, three enemy-generation tools: never reached from the UI. About 5,000 lines.

- The build skips type-checking and ships 107 type errors; the Gemini key is compiled into the public bundle; enemy timers count frames, so slimes act 2.4× faster on a 144 Hz screen.

    The one structural fact to know. There is no single "level". Tiles live in the Phaser layers, a base-map array, a "user tiles" array, and each selection box's list, and a function rebuilds the visible map from all four after every edit. Most of the audit's P0 bugs trace to this (tiles that cannot be removed, edits landing in the wrong place, saves that lose work). Pewter Ghost needs one level in one place with a record of who placed each tile, and a stream of placement events to listen to. That is the first thing to build.

### What else exists and where

       |  | Asset | Where | State | Use in Pewter Ghost

         | Player Physics Fork: playerPhysics.ts, playerController.ts, jumpSolver.ts, movementCapabilities.ts | PartyD1/Pewter-The-Platformer at b36ff59 | Frame-rate independent, coyote time, jump buffer, unit tests; exact jump reach tables | The knight in Play mode; the jump tables the pattern engine and Fix measure against

         | Playtest agent physsim.ts + validate_engine.cjs | audit-prototypes/playtest-agent/ on branch claude/loving-bardeen-n1s3an | Plays a level with the game's own physics; trajectories match the real game to 6e-14 px | Verifies every ghost before it is shown (Phase 1); plays the whole level for Fix; the path overlay

         | Chunk generator chunkgen.py, rule checker reachpy.py, Z3/clingo models with repair() | audit-prototypes/generators/ | Python; ~2 ms per seeded candidate; clingo finds fewest-tile repairs | Rule checker ported as the fast pre-filter; repair() idea for whole-level Fix; the generator itself waits for the algorithm-filler comparison (later)

         | Replay harness run_eval.cjs, scenarios, checks.ts | audit-prototypes/replay-harness/ | Drives the real editor in headless Chromium, scores results automatically | End-to-end tests of painting, ghosts and keys from Phase 0

         | Typed-decision proxy experiment | audit-prototypes/typed-decision-proxy/ | Gemini answering independent yes/no and choice questions over engine-listed features: 60/60, 24/24, 27/30 correct abstentions | Evidence that the model answers typed questions over the grid reliably; the shape of the autofill call's JSON (§8)

         | Grid-context prototype gridContext.ts | audit-prototypes/grid-context-prototype/ | ASCII grid with rulers and legend; raised replay pass rate from 42 to 45 of 48 | The window the model sees (§8)

         | Study instruments: task sheet, interview guide, analysis deck | Lab drive | Five open-ended tasks; 16 interview questions | Baseline numbers to beat (68% hand repair, 40% perceived contribution); no study work now

  

    04
## Fork or Copy?

    Recommendation: a new repository seeded by copying the editor shell, not a git fork. The old repository stays alive and untouched.

#### Why copy

- More than half the code goes (boxes, chat, tools, dead experiments). A fork carries that history, and every "idk how this works" comment, into a codebase two newcomers have to read.

- The new repository gets a clean main, CI with type-checking from the first commit, and a README that describes Pewter Ghost rather than "a demonstration of LLM tool calling".

- The study build stays exactly reproducible in the old repository, which the paper needs.

- The dependency list shrinks: LangChain, the Google SDK and two accidental packages (20, node) are not needed.

#### What is lost, and how to keep it

- git blame on the editor code. An ORIGIN.md names the source commit (83e2239) and the fork commit (b36ff59) so anyone can look back.

- GitHub Pages deployment: copy the workflow, minus the API key in the client bundle. The key moves behind a proxy, which the new design needs anyway (G-09).

- The audit prototypes: they live on a branch of the old repository today (draft PR #1). Phase 0 moves the agent, generator and harness into the new repository's packages/ (G-07).

    If the lab prefers a fork for continuity, do the same deletions in the first commit on a branch named ghost and make it the default. Everything after §5 is identical either way.

  

    05
## Keep, Fix, or Drop

    Piece by piece. "Fix" means the piece comes over and changes in Phase 0; "bring in" means it comes from the fork or the audit.

       |  | Piece | Verdict | Notes | Item

         | Phaser shell: boot, loading, tilemap, camera, palette, Play mode, undo, save/load | keep | The editor people liked. editorScene.ts is split: painting and camera stay; box gestures and chat hooks go; undo moves into the level model. | G-01 G-02

         | Toolbar and block palette (UIScene.ts) | fix | Keep the palette. Remove the chat panel and box tabs. Add a status strip ("ghost: staircase · Tab to accept"). Fix painting under the UI; make modes explicit (Select / Paint / Erase / Pan) so trackpads work. | G-04 G-19

         | Painting (placeTile, continuous strokes) | fix | Keep the feel. Remove the right-click "eyedropper" that silently turns the brush into an eraser. Every stroke becomes placement events the engines listen to. | G-04 G-12

         | Enemies: Slime, UltraSlime, Pathfinding | fix | Keep. Timers become time-based (frame-based today). Soften the UltraSlime for students. Enemies get a patrol span so Extend and Fix can reason about them. | G-06

         | Knight movement | bring in | Replace with the Player Physics Fork's playerPhysics.ts and playerController.ts. Its jumpSolver.ts gives the exact jump tables the pattern engine and Fix need. | G-05

         | Tileset and assets (Brackeys) | keep | The 15-tile Brackeys sheet Pewter already uses, so the study's look carries over. Add a goal flag and a sign from the Kenney sheet already in public/ (18 px; resample to 16). | G-01

         | Save format (JSON with tiles and enemies) | fix | Keep the shape; add authorship per tile and the suggestion history; validate on load (a bad enemy entry currently wipes the level silently). "Save & Reload" becomes "Save task", since it is the study's per-task save step. | G-08

         | GitHub Pages workflow | fix | Copy it; stop passing the key into the build; add tsc --noEmit, lint and tests to CI. | G-01 G-09

         | Selection boxes, Z-levels, Empty markers, replaceAllBoxes() | drop | The whole concept goes. One level model replaces the four stores. | G-02

         | Chat: chatBox.ts, modelConnector.ts, LangChain, all AI tools | drop | No chat. One structured autofill call through a thin client and the proxy; the model returns tiles and a confidence, which are validated and verified before anything is shown. | G-14

         | worldFacts.ts | drop | Its facts were wrong (enemies listed as terrain). The model sees an ASCII grid of the level with entities marked, built from the level model. | G-13

         | gameScene.ts, enemySystem/, regeneration, enemy-generation tools, Z3 web experiments | drop | Dead. Tag the old repository so nothing is lost. | —

         | Audit prototypes: playtest agent, chunk generator, replay harness, eval scorer, typed-decision experiment | bring in | The agent proves a section is beatable and verifies every ghost. The rule checker is the fast pre-filter. The harness drives the real UI in a browser. The generator waits for the algorithm-filler comparison. They need a home in the new repository in week 1. | G-07 G-34 G-16

    Rough count: about 3,500 lines kept and reshaped, about 7,000 dropped, about 2,000 brought in from the fork and the audit, and perhaps 5,000 new. The new repository ends up smaller than the old one.

  

    06
## Architecture

    Painting produces events; the model produces a suggestion; validation and the agent decide whether it may be shown; confidence decides when; the ghost layer shows one; accepting writes back to the level.

```

flowchart LR
  P["Painting (Phaser editor)"] -->|"placement events"| LM[("Level model
one grid · entities · author per tile")]
  LM --> WB["Window builder
ASCII grid · rulers · recent placements · knight limits · design brief"]
  WB -->|"request"| F{"Filler
(interface)"}
  F --> LLM["LLM autofill
(the one built now)"]
  F -.-> ALG["Algorithm filler
(later)"]
  LLM -->|"tiles · entities · confidence · label"| V["Validator
shape · bounds · overlap · measurements"]
  V -->|"ok"| PA["Playability
rule check → agent in a worker"]
  V -->|"fail"| LLM
  PA -->|"fail, once"| LLM
  PA -->|"verified"| SM["Suggestion manager
confidence → timing · one ghost · cool-downs"]
  SM --> GL["Ghost layer
faint tiles · crossed removals · Tab / Esc / draw-to-dismiss"]
  GL -->|"accept (command)"| LM
  LM -->|"idle"| PT["Whole-level patrol
agent plays start → frontier"]
  PT -->|"blocked at"| LLM
  SM & LM & LLM --> LOG["Log
every call, ghost, outcome, latency"]
  LLM -.->|"HTTPS"| PX["Proxy
key · tokens · pinned model · log sink"]

```

#### Level model
One grid, one entity list, start and goal, and for every tile who placed it (person, accepted ghost and which suggestion). Every change is a command with undo. The renderer draws from it; nothing else writes to Phaser layers. Replaces the four stores and replaceAllBoxes().

#### Window builder
A pure function from the level and the last placements to the request the model sees: a 24×12 ASCII window with rulers and a legend, the last 8–12 placements with timing, the knight's jump limits, the measured numbers of the last screen, the design brief, and the last few ghosts and their outcomes.

#### Filler interface and the LLM filler
fill(request) → Promise<Suggestion | null>. The LLM filler posts the request to the proxy, which calls a pinned model in JSON mode, and parses the answer. One in flight, newest wins, a timeout after which the answer is dropped. The algorithm filler and Jev implement the same interface later; nothing else in the editor knows which filler is active.

#### Validator and playability
Shape: in bounds, on grid, no overlap with authored tiles except in a Fix, entities on valid surfaces. Measurements: density and gap width within what the drawing has established. Then the rule check and the playtest agent in a Web Worker with a time cap. A failure goes back to the model once with the reason, then is dropped.

#### Suggestion manager and ghost layer
The manager holds one verified suggestion, decides from its confidence whether to show now, at the pause, or on request, enforces cool-downs, and logs. The ghost layer draws it at low opacity with a dashed edge, crossed-out removals, and a caption, and handles Tab, Esc, Ctrl+Space, paint-on-ghost and draw-to-dismiss.

#### Log and proxy
Append-only events batched to the proxy and downloadable at session end: every call with its request hash, answer, confidence and latency; every ghost shown and how it ended; placements, undo, play. The proxy holds the key, pins the model and keeps every exchange so the offline suite can replay it.

### Repository layout

```
pewter-ghost/
├── ORIGIN.md                   # source commits, what was copied, what was dropped
├── apps/editor/src/
│   ├── level/                  # LevelModel, commands, authorship, save format v2
│   ├── editor/                 # scenes split from editorScene.ts: paint, camera, play, ui
│   ├── ghost/                  # GhostLayer, keys, captions, path overlay
│   ├── fill/                   # Filler interface, LLM filler, window builder, brief, validator
│   ├── verify/                 # rule check, agent worker bridge, whole-level patrol
│   ├── suggest/                # SuggestionManager, confidence policy, config
│   ├── research/               # event log, export, condition switch
│   └── player/                 # Player Physics Fork files, unchanged where possible
├── packages/
│   ├── physsim/                # playtest agent (from the audit), runs in a worker
│   ├── measure/                # density, gaps, leniency, linearity, verticality, difficulty numbers
│   └── jump-tables/            # exported from jumpSolver.ts; shared by editor, measure, physsim
├── proxy/                      # Cloudflare Worker: key, tokens, /fill, /log
├── prompts/                    # versioned system prompt, brief fragments, few-shot examples
├── eval/                       # offline suite: recorded requests, scorers, reports
└── tests/e2e/                  # Playwright, from the audit's replay harness
```

  

    07
## Data Model and Contracts

    Four shapes everyone builds against. Agree them in week 1 and the three streams run in parallel from week 2.

#### Level and placement events

```
Level {
  w: 200, h: 20,
  cells: Uint8Array,                 // tile id per cell, 0 = empty
  authors: Uint8Array,               // 0 none · 1 person · 2 accepted ghost
  provenance: Map,
  entities: [{id, kind: "slime"|"ultraslime"|"coin"|"fruit"|"flag"|"sign", x, y}],
  start: {x,y}, goal?: {x,y},
  history: Command[]
}
PlacementEvent { t: ms, x, y, tile, author, stroke: id, tool: "paint"|"erase" }
```

#### FillRequest (what the model sees)

```
FillRequest {
  grid: string,                      // 24×12 ASCII window, rulers, legend
  origin: {x, y},                    // window's top-left in level coords
  recent: [{dt, x, y, tile, tool}],  // last 8–12
  frontier: {x, y, idleMs},
  knight: {maxGapStand, maxGapRun, maxRise},
  measured: {density, gapHist, verticality, rewardSpacing, pressure},
  brief: string,                     // design knowledge (§9), versioned
  lastGhosts: [{kind, label, outcome}],
  mode: "auto" | "requested" | "patrol"   // patrol = whole-level fix
}
```

#### Suggestion (what the model returns)

```
Suggestion {
  act: boolean,
  kind: "finish" | "extend" | "fix",
  adds:    [{x, y, tile}],           // level coords after origin offset
  removes: [{x, y}],                 // fix only; drawn crossed out
  entities: [{kind, x, y}],
  confidence: 0..1,
  label: string,                     // ≤ 6 words; the caption
  // filled in locally:
  id, requestHash, filler: "llm"|"algo"|"jev", latencyMs,
  verified: boolean, path?: [{x, y}] // agent's route, drawn on accept
}
```

#### Verdict (validator and agent)

```
Verdict {
  ok: boolean,
  stage: "shape" | "measure" | "rules" | "agent",
  reason?: string,                   // "gap at x=41 is 9 wide; knight clears 6"
  path?: [{x, y}],
  ms: number
}
// On !ok the reason is appended to the request and the model is
// asked once more; a second failure drops the suggestion.
```

    Coordinates in the model's answer are window-relative and converted locally. The audit's typed-decision experiment showed the model reliable at reading rulers and answering over a labelled grid; the first thing the offline suite measures is how often its tile coordinates are where it meant them to be.

  

    08
## The Autofill Call

    The research object. One structured request while the person draws, answered with tiles and a confidence, fast enough to feel instant and safe enough to be wrong.

### Timing budget

       |  | Step | Budget | Notes

         | Placement → request built | < 5 ms | Pure function; the brief is a cached string.

         | Model call (JSON mode, roughly 1,200 input tokens, ≤ 300 output) | target 500 ms, timeout 900 ms | Speculative on every placement; one in flight, newest wins. Most calls are superseded, which is fine.

         | Validator | < 5 ms | Shape and measurements.

         | Rule check | < 5 ms | Jump tables over the suggestion's surfaces.

         | Agent in a worker | cap 300 ms | Search from the nearest standable tile before the suggestion to the far side. Over cap: treat as fail.

         | Send-back on failure | one more call | Only when the first answer arrived under 500 ms; otherwise drop.

         | Reconciliation | < 2 ms | If the person drew on the suggestion's cells since the request, drop it.

         | Show | by confidence | High: now. Medium: next pause (≥ 800 ms idle). Low: hold; show if idle ≥ 2.5 s or on Ctrl+Space.

### The prompt, in outline

- Role. "You are an autofill for a 2D platformer level editor. The person is drawing. Suggest the next piece as tiles, or say nothing. Your suggestion appears faint and is accepted with Tab; being wrong costs little, being unplayable or repetitive costs trust."

- How to read the grid. Legend, rulers, what each tile does, where the knight is, which cells are the person's and which were accepted ghosts.

- The knight. Jump limits as numbers, with two worked examples of a reachable and an unreachable gap.

- The brief (§9): patterns, what the drawing seems to be, difficulty numbers, what was recently accepted and dismissed, the variety rule.

- Kinds. When to finish, when to extend, when to fix, and that a fix may remove the person's tiles if it says why.

- Confidence. "How sure are you that the person wants this here, now. 0.9: they are clearly mid-pattern and this completes it. 0.5: plausible next stretch. 0.2: a guess." Examples at each level.

- Output. The Suggestion JSON only. Six few-shot examples from recorded sessions, two of them act: false, one a fix with removals.

### Where confidence comes from

    Three candidates, compared in G-27 on the same recorded sessions: the model's stated number; the mean token log-probability of the tile list where the API exposes it; and agreement between two samples at a modest temperature (same cells in both: high; disjoint: low). The one whose curve against acceptance is steepest wins. Until then, the stated number is used.

    Why speculative. Waiting for a pause before calling would add the call's latency to the pause and Finish ghosts would arrive late. Calling on every placement means the answer is usually ready before the person stops. A 40-minute session is a few hundred calls; at a small model's prices, cents. The suite records how often a superseded answer would have been identical to the kept one, which tells us if we can call less often.

  

    09
## The Design Brief: Teaching the Model What Good Looks Like

    The style and level-type material survives in one role: as text and numbers the model reads, and as checks on what it returns. No form for the person.

#### Static part (versioned in prompts/)

- Pattern catalogue. Twelve to twenty named patterns with a one-line rule and a tiny ASCII example each: staircase, gap run, pillar hop, rising steps, guarded reward, coin arc, coin ladder, risky coin over pit, rest, reveal, dead end with reward, one-way drop, flow run, enemy gate.

- Type rules. For parkour, maze, collect-a-thon, story and speedrun: density, rhythm, gap range relative to the knight's limits, verticality, reward spacing, enemy pressure.

- Classic styles as rules. What makes a stretch read as classic Mario or Sonic, as statements about rhythm, gaps, rewards and enemy direction. No level data.

- Placement rules. Coins on the arc the knight would take, never flat on a floor in a coin level; enemies with ≥ 4 tiles of patrol and never on a landing; a rest every two to three screens.

#### Dynamic part (built per request)

- What the drawing looks like so far: the measured numbers for the last two screens (packages/measure) and the patterns detected in them.

- The model's own last guess at what the level is trying to be, shown in the status line so the person can see it.

- History: the last five ghosts, kind, label and outcome, with the rule that an Extend must differ from them.

- Later, examples: lab-authored reference levels sliced at rests into small ASCII chunks, retrieved by similarity to the current window and appended as "sections others have drawn here" (G-31).

### The same knowledge as the check

    The validator runs the measurements on the suggestion merged into the level. A suggestion that pushes density or gap width outside a band around what the drawing has established fails at the measure stage with the numbers in the reason, and the model gets one more try. The offline suite scores every suggestion on the same measures, so a prompt change is judged against the catalogue, not by eye. Difficulty is a number from the same package (gap-to-limit ratio, rise, enemy proximity to landings, platform width), reported per screen and used both in the brief and in G-24.

  

    10
## Playability Before Anything Is Shown

    Every ghost is played by the game's own physics before it appears. If the level cannot be finished, Ghost offers the repair.

- Rule check. Every standable surface in the suggestion reachable from the one before it by the jump tables. Ported from the audit's reachpy.py; milliseconds. Catches most failures cheaply.

- Agent. packages/physsim in a Web Worker: the fork's stepMovement plus the line-by-line port of Phaser's tile collision, searching for an input sequence from the nearest standable tile before the suggestion to the first standable tile after it. Cap 300 ms; over cap counts as fail. Trajectories match the real game to 6e-14 px, validated in the audit.

- On failure the Verdict's reason is appended to the request and the model is asked once more. A second failure drops the suggestion and logs it; dropped-for-playability is a model-quality metric.

- On accept the agent's route is drawn for two seconds. This is the explanation people actually watch.

- Whole-level patrol. After 3 s idle, the agent plays from start to the frontier in the worker. If blocked, the request goes to the model in mode: "patrol" with the blocking point and the reason, and the answer is shown as a Fix ghost there. Fewest-tile repairs are preferred by the brief; the audit's clingo repair() result (two tiles for a 14-wide pit) is the kind of answer expected.

- In Play mode the agent's route for the current section is available on a key.

    The rule checker alone gave false "beatable" on 16 of 34 tunnel and wall cases in the audit, so it is a pre-filter, not the verdict. The agent is the verdict.

  

    11
## Fix: When Ghost Edits Your Tiles

    Fix stays in. Ghost may remove or move what a person placed, for playability first and for quality second.

#### Two sources of Fix

- Patrol fixes (§10): the level cannot be finished; the model is asked for the repair at the blocking point. These may interrupt a Finish ghost.

- Model-initiated fixes: the model, seeing the window, returns kind: "fix" on its own: a too-wide gap it can see coming, a cluster of enemies beyond what the brief allows, coins flat on a platform in what looks like a coin level, a dead frontier. These wait for a pause like any other suggestion.

#### Rules of engagement

- Removals are drawn crossed out, additions faint, in one Suggestion; Tab applies both as one undoable command.

- Never fix something placed in the last 3 s.

- One Fix per problem per minute; a drawn-over dismissal mutes that problem until its cells change.

- The caption states the measurement, not an opinion: "gap 9 · knight clears 6".

- A Fix is verified like anything else: the repaired section must be playable by the agent.

  

    12
## Confidence, Speed and Certainty

    How "when to autofill" and "speed versus certainty" become numbers in one config file.

       |  | Setting | Start value | What moving it does | Judged by

         | showNowAbove | 0.75 | Lower: more ghosts mid-stroke. Higher: more wait for the pause. | Drawn-over dismissals per 10 min; Finish acceptance

         | showAtPauseAbove | 0.4 | Below this a ghost waits for a long pause or a request. | Acceptance of low-confidence ghosts when they do show

         | pauseMs | 800 | What counts as a pause. | Per-person drawing tempo in the log

         | longPauseMs | 2500 | When low-confidence ghosts may show. | Same

         | callTimeoutMs | 900 | When to give up on the model. | Drop rate; latency distribution

         | agentCapMs | 300 | Verification depth. | Over-cap rate on real suggestions

         | sendBackIfUnderMs | 500 | Whether a failed answer gets a second try. | Second-try pass rate vs added latency

         | cooldownAfterDismissMs | 4000 | Silence on the same structure after a dismissal. | Dismissals in a row

         | windowCols × windowRows | 24 × 12 | Context size vs fit. | Suite: playability and fit vs tokens

         | model | smallest JSON-mode model available | Speed vs quality. | Suite, every candidate model, same sessions

    Per-person adjustment comes later: two drawn-over dismissals in a row raise showNowAbove for that session, two accepts lower it, within bounds. The first tuning is global and done from the lab's own sessions.

  

    13
## Measurements: One Package for Brief, Checks and Eval

    packages/measure turns a grid into numbers. The brief reads them, the validator enforces them, the suite scores with them.

       |  | Measure | Definition | Used for

         | Density | Solid tiles ÷ cells, per screen | Type inference; clutter checks

         | Gap histogram | Widths of gaps between standable surfaces, as a fraction of the knight's running limit | Difficulty; Fix for too-wide gaps; variety

         | Rise histogram | Height changes between consecutive surfaces vs max rise | Difficulty; verticality

         | Leniency | Share of surfaces where a mistimed jump still lands (from the agent's search slack) | Difficulty

         | Linearity | Fit of surface heights to a line, per screen | Type inference (maze vs parkour); diversity across levels

         | Reward spacing | Tiles between collectables along the route; share of coins on arcs vs on floors | Collect-a-thon rules; Fix for floor coins

         | Pressure | Enemies within 3 tiles of a landing ÷ landings | Enemy placement rules; difficulty

         | Pattern tags | Which catalogue patterns a window matches | Brief; variety rule; suite

         | Difficulty | Weighted sum of gap ratio, rise, pressure, platform width; calibrated later against Play deaths | Brief; status line; diversity across levels

    These are the platformer metrics from the expressive-range and Mario-AI-evaluation literature on the lab's reading list, so the lab's results read in the field's own terms.

  

    14
## Proxy, Logging and the Event Schema

    One small server, one append-only log. Everything the development loop needs is in here from Phase 1.

#### The proxy

- A Cloudflare Worker (or campus server) with /fill and /log. /fill forwards to a pinned model with a fixed JSON schema and the versioned prompt; the client never sees the key.

- Per-session tokens from the launcher URL; rate limits per token; refuses without one.

- Stores every request and answer with the session id and prompt version, so the suite can replay any session against a new prompt or model.

- CI fails if the built bundle contains a key pattern.

#### Log events

           |  | Event | Fields

             | session | id, commit, prompt version, model id, filler, config snapshot

             | place / erase | t, x, y, tile, stroke, author

             | fill.call | t, requestHash, superseded?, latency, act, kind, confidence, tiles count, verdict stage, reason, sendBack?

             | ghost.show | t, suggestionId, kind, confidence, shownBecause: now · pause · longPause · requested · patrol, cells, label

             | ghost.end | t, suggestionId, outcome: accepted · partial(cells) · esc · drawn-over · replaced · timeout, dwell

             | patrol | t, beatable?, blockedAt

             | play.start / play.end | t, reached goal?, deaths

             | undo, save | what was undone (own tiles vs accepted ghost); level snapshot id

    From these the development signals compute directly: acceptance by kind and by confidence band (calibration), drawn-over rate, verified-first-try rate, send-back pass rate, drop rate, latency, hand repair inside a ghost's cells within 60 s, patterns per session, and expressive-range measures on saved levels. The same log supports a study later without changes.

  

    20
## Dependency Graph

    What blocks what. Three roots (repo, level model, proxy); the streams meet at the suggestion manager.

```

flowchart TD
  G01["G-01 repo + CI"] --> G02["G-02 level model"] --> G03["G-03 renderer from model"]
  G01 --> G04["G-04 painting fixes"] --> G12["G-12 placement events"]
  G01 --> G05["G-05 fork knight + jump tables"] --> G06["G-06 enemies"]
  G01 & G05 --> G07["G-07 agent · rule check · harness"]
  G02 --> G08["G-08 save v2"]
  G01 --> G09["G-09 proxy v1"]
  G02 --> G10["G-10 contracts · filler interface · stub"]
  G10 --> G11["G-11 ghost layer"]
  G12 & G02 --> G13["G-13 window builder"]
  G13 & G09 --> G14["G-14 LLM filler + prompt v1"]
  G14 & G05 --> G15["G-15 validator"]
  G15 & G07 --> G16["G-16 playability verifier"]
  G16 & G11 --> G17["G-17 confidence policy + manager"]
  G17 --> G18["G-18 log"]
  G11 --> G19["G-19 status strip · captions · path overlay"]
  G18 --> G20["G-20 offline suite v1"]
  G05 --> G22["G-22 measure package"]
  G22 & G14 --> G21["G-21 design brief v1"]
  G16 --> G23["G-23 whole-level patrol + Fix"]
  G21 & G11 --> G24["G-24 model-initiated Fix + rules"]
  G21 & G20 --> G25["G-25 variety"]
  G21 & G22 --> G26["G-26 collectables + enemies rules"]
  G20 --> G27["G-27 confidence calibration"]
  G20 --> G28["G-28 model + window selection"]
  G18 --> G29["G-29 dogfood + dashboard"]
  G27 & G28 & G29 --> G30["G-30 prompt iteration"]
  G22 & G08 --> G31["G-31 reference examples"]
  G16 --> G32["G-32 send-back + latency tests"]
  G18 --> G33["G-33 condition switch"]
  G10 & G07 -.-> G34["G-34 algorithm filler"]
  G14 -.-> G35["G-35 pure generation"]
  G10 & G20 -.-> G36["G-36 Jev timing test"]
  G06 & G08 -.-> G37["G-37 play settings + share code"]
  G20 & G29 -.-> G38["G-38 distilled small model"]

```

    Critical path: G-01 → G-02 → G-10 → G-11 alongside G-12 → G-13 → G-14 → G-15 → G-16 → G-17. Both must land by week 6 for the Phase 1 milestone. The prompt (G-14) can be drafted in week 3 against hand-made windows before the builder exists.

  

    21
## Development Order

    Week by week for a 10-week quarter. Three people; each week names what each stream does.

       |  | Week | Editor and ghost layer | Verification and measurements | Model and evaluation | Milestone

         | 1 | G-01 repo, deletions, CI; start G-02 | G-05 fork knight; G-07 agent, rule check, harness; jump-tables package | G-09 proxy skeleton; agree contracts (§7); G-10 config and filler interface | Compiles, deploys, no boxes

         | 2 | G-02, G-03 level model and renderer; G-04 painting fixes | G-06 enemies; agent in a worker on a fixture; first e2e tests | G-10 stub shows a hard-coded ghost; G-08 save v2 schema; prompt v0 drafted on hand-made windows | Phase 0 exit

         | 3 | G-11 ghost layer: draw, Tab, Esc | G-12 placement events; G-15 validator shape checks | G-13 window builder; G-14 LLM filler through the proxy | First model-drawn ghost (unverified, dev only)

         | 4 | G-11 draw-to-dismiss, paint-on-ghost; G-19 status strip | G-16 verifier: rule check + agent worker + send-back | G-17 confidence policy and manager; G-18 log | Verified ghosts only

         | 5 | G-19 path overlay on accept; polish | G-22 measure package v1 | G-20 offline suite v1 on first dogfood recordings | Suite runs

         | 6 | Lab dogfood, bug fixes | Agent cap tuning; over-cap analysis | Prompt v1 from dogfood; latency tuning | Phase 1 exit · demo to the lab

         | 7 | G-24 removal ghosts and Fix rules of engagement | G-23 whole-level patrol + Fix request | G-21 design brief v1 (catalogue, type rules, numbers) | Unbeatable level gets a Fix ghost

         | 8 | Status line shows the model's guess at level type | G-26 collectable and enemy rules in validator | G-25 variety rule and check; G-27 calibration experiments begin | Two drawings, two different Extends

         | 9 | Polish; onboarding hint | Difficulty number v1; measurement bands tuned | G-27 result; G-28 model and window selection | Phase 2 exit

         | 10 | G-29 dogfood sessions and dashboard; G-30 prompt iteration; G-32 latency budget tests; G-33 condition switch kept cheap; quarter review | Phase 3 begins · quarter review

         | Q2 | G-30 continues weekly; G-31 reference examples; then, in the lab's order, G-34 algorithm filler, G-37 quality of life, G-35 pure generation, G-36 Jev (very late), G-38 distilled model if latency demands | Comparisons

  

    22
## Who Does What

#### Editor and ghost layer
Best owned by Pewter's author: the level model, the split of editorScene.ts, the ghost layer and its keys, the status strip, the path overlay, the Fix rendering. Phase 0 is mostly this person; from Phase 1 they also run dogfooding.
Items: G-01 G-02 G-03 G-04 G-08 G-10 G-11 G-19 G-24 G-33 G-37

#### Verification and measurements
Pure TypeScript, test-first: placement events, the agent in a worker, the rule check, the validator, the measure package, whole-level patrol, collectable and enemy rules. No Phaser knowledge needed to start; a good first stream for a newcomer.
Items: G-05 G-06 G-07 G-12 G-15 G-16 G-22 G-23 G-26 G-32 G-34

#### Model and evaluation
The proxy, the window builder, the prompt and the brief, the LLM filler, confidence policy, the log, the offline suite, calibration and model selection, weekly prompt iteration, reference examples. The second newcomer fits here if they lean toward the research side.
Items: G-09 G-13 G-14 G-17 G-18 G-20 G-21 G-25 G-27 G-28 G-29 G-30 G-31 G-35 G-36 G-38

    The three streams meet at the FillRequest, Suggestion and Verdict shapes (§7). Agree them in week 1, keep them in one file with a changelog. Weekly: a 30-minute session where everyone draws a level with the current build and reads the suite's report together.

  

    23
## The First Two Weeks, Concretely

- Create the repository with the layout in §6. Copy src/phaser, main.ts, public/, the Vite config and the Pages workflow (without the key). Write ORIGIN.md.

- Delete src/languageModel, src/enemySystem, gameScene.ts, regenerator.ts, RegenerationTools.ts, worldFacts.ts, selectionBox.ts. Make it compile. Expect a day untangling box gestures from the pointer handlers.

- Add tsc --noEmit, ESLint and Vitest to CI. Fix the type errors that survive the deletions.

- Write level/LevelModel.ts with grid, entities, authorship and commands; route placeTile through it; render from it; delete the base and user tile arrays and the snapshot undo.

- Bring in the fork's four player files; wire the controller into Play mode; export the jump tables as packages/jump-tables.

- Bring in physsim.ts as packages/physsim and get it running in a Web Worker with a time cap on a fixture level; port reachpy.py as the rule check; bring the replay harness in as tests/e2e.

- Write the four contracts from §7 as types; write suggest/config.ts with the numbers from §12; write the Filler interface and a stub that returns a hard-coded staircase so Ctrl+Space shows a ghost and Tab commits it with author = ghost.

- Draft prompt v0 and three hand-made FillRequest windows; call the model from a script through the proxy skeleton; look at the tiles it returns. This is the first look at the research object and it should happen in week 2, not week 4.

- Remove the eyedropper; stop painting under the UI; add tool modes; make enemy timers time-based. Run the regression tests.

  

    24
## Testing Strategy

    Five layers, each owned by the stream that writes the code it tests. The old repository had no tests; the new one gates every merge.

       |  | Layer | What | Tooling | Gate

         | Unit | Level model commands; window builder; validator; measurements; rule check; confidence policy; log schema; answer parsing with window-to-level coordinate conversion | Vitest | Every PR

         | Property | Random commands + undo = identity; every suggestion that passes the validator and agent is reachable by the rule check too; every patrol Fix makes the level beatable and creates no new block | fast-check | Every PR

         | Golden | Window text for fixture states; brief text per prompt version; measurements on fixture levels | Vitest snapshots | Every PR

         | End-to-end | Paint, undo, play, save, reload; ghost show, Tab, Esc, draw-to-dismiss, paint-on-ghost; Fix with removals; model answers replayed from recordings | Playwright (the audit harness) | Every PR; nightly against the live model

         | Offline suite | Recorded requests through the live model: playability first try, send-back pass rate, coordinate accuracy, pattern fit, variety, calibration, latency, schema misses | eval/ | Weekly; before any prompt, model or window change

         | Physics | Agent trajectories vs the real game on fixture levels (6e-14 px in the audit); jump tables vs agent | Vitest + harness | On any change under player/ or physsim

### Latency budget as a test

    A Playwright test paints a staircase at 300 ms per tile with recorded model answers delayed by 500 ms and asserts the Finish ghost is on screen within 200 ms of the third placement. A second delays the answer by 1,200 ms and asserts it was dropped and logged. A third feeds an unplayable recorded answer and asserts nothing was shown and the send-back was logged. These three are the contract behind "verified or not shown" and "instant small, one second big".

  

    25
## The Evaluation Loop

    How "get the LLM to perfection" runs week to week. No study design here; the loop is for the lab's own sessions.

- Record. Every lab session logs every request and answer through the proxy. By week 6 there are hundreds of real windows with real outcomes.

- Replay. The suite feeds recorded requests to the current prompt and model and scores the answers without a person in the loop: did it validate, did it pass the agent first try, were the coordinates where the model meant them, which patterns did it use, how did it differ from the previous answer in the same session, what confidence did it state.

- Compare. Two prompt versions, two models or two window sizes run on the same requests; the report shows the deltas per measure. No change ships that lowers playability-first-try or flattens calibration.

- Watch people. The weekly 30-minute session: acceptance by kind and confidence band, drawn-over rate, hand repair inside ghost cells, "did a suggestion give you an idea you would not have had", "how did that feel". These are the slide's signals (dismiss vs accept, unique ideas prompted, satisfaction) measured early and often.

- Level outputs. Saved levels from each session measured with packages/measure: diversity across levels (expressive range) and difficulty by obstacle count, configuration and agent simulation. These are the slide's level-difference measures.

- Change one thing. Prompt text, few-shots, brief contents, window size, thresholds, model. One at a time, through the suite, then into the next week's sessions.

    The condition switch (G-33) and "Save task" are kept because they are cheap and make a study possible later. Nothing else here is study machinery.

  

    26
## Risk Analysis

       |  | Risk | Likelihood | Impact | Mitigation | Owner

         | The model draws unplayable sections most of the time | High at first | High | Verification keeps them off screen; dropped-for-playability is tracked as the first quality metric; knight limits with worked examples in the prompt; send-back with the reason; the brief's placement rules | Model

         | The model draws the same thing every time (the audit's 36-of-36) | High at first | High | History and the variety rule in the brief; a validator check for repeats; a suite failure if any pattern recurs three times; reference examples later | Model

         | Stated confidence means nothing | Medium | High: the timing dial fails | G-27 compares stated confidence, log-probabilities and two-sample agreement; thresholds tuned to whichever bends | Model

         | Coordinates off by one or mirrored | Medium | Medium | Rulers every column, legend, window-relative coordinates, coordinate-accuracy measure in the suite, a few-shot that shows the conversion | Model

         | Too slow on the real network | Medium | Medium | Smallest model that passes; speculation; short window; drop on timeout; latency tests; distilled model later if needed | Model

         | Agent over its time cap on long or vertical sections | Medium | Medium | Cap at 300 ms; bounded search window; rule check first; over-cap tracked and the cap tuned | Verification

         | Ghosts feel like nagging | Medium | High | The ghost contract; confidence-based timing; cool-downs; drawn-over rate watched weekly; Ctrl+Space so pull always exists | Editor

         | Fix feels like being corrected | Medium | Medium | Captions state measurements; 3 s grace; one Fix per problem per minute; always undoable | Editor

         | Splitting editorScene.ts breaks the painting feel | Medium | Medium | E2E tests before the split; strokes, undo and play after every change; the author does the split | Editor

         | Scope creep into the comparisons or a game engine | Medium | Medium | Later items stay behind the filler interface; two new elements (flag, sign) only; everything else after the autofill is good | All

         | Model or API version changes mid-quarter | Medium | Low | Pinned model id in the proxy; suite before any change; recorded answers in e2e | Model

  

    27
## Definition of Done

#### For any work item

- Type-checks, lints, unit and property tests pass; e2e tests added or updated where the UI changed.

- Log events added for any new user-visible behaviour, with a schema test.

- Any threshold lives in the config file, not the code; any prompt text lives in prompts/ with a version.

- No path by which an unverified suggestion reaches the ghost layer.

- A one-paragraph note in docs/decisions.md if a contract in §7 changed.

#### For the first quarter

- Phase 0–2 exits met as written in §15–§17.

- Zero unplayable ghosts shown in any logged session.

- The suite runs weekly on ≥ 300 recorded requests and its report is read together.

- Acceptance rises with stated (or derived) confidence in the lab's sessions.

- No key in the bundle; proxy rate-limited; model id pinned.

- A 10-minute demo any lab member can give without the author present.

  

    28
## Open Questions and Decisions Needed Now

       |  | Question | Why it matters | Who decides | By when

         | Copy or fork | This document assumes copy; a fork changes only week 1 | Lab | Week 1

         | Where the proxy runs | Cloudflare Worker is quickest; a campus server keeps recordings on campus | Lab | Week 1

         | Which model to start with | Gemini is already set up and has JSON mode; any model with JSON output and ideally log-probabilities works. The suite decides the final choice; the start just has to be small and fast | Model stream | Week 2

         | Stated confidence vs log-probabilities vs two samples | Determines the timing dial | Model stream, from G-27 | Week 9

         | Window size and how to summarise the rest of the level | Tokens vs fit | Model stream, from G-28 | Week 9

         | Send back once, or drop? | Latency vs a second chance | Team, from G-32 | Week 10

         | Who draws the first reference levels | Examples in the brief need a source we own | Lab | Q2

         | Does Finish ever place entities? | Currently the brief allows coins in a Finish (completing an arc) but no enemies | Lab | Phase 2

  

# Part 3 — Work items

## G-01 — New repository seeded from the editor shell, with CI (Phase 0, from new)
- **What changes:** Create pewter-ghost with the layout in §6. Copy src/phaser, main.ts, public/, the Vite config and the Pages workflow from 83e2239. Never copy languageModel/, enemySystem/, gameScene.ts, regenerator.ts, RegenerationTools.ts, worldFacts.ts, selectionBox.ts. Add ORIGIN.md. CI runs tsc --noEmit, ESLint, Vitest and Playwright on every PR; the deploy job fails if dist/ contains a key pattern. Add a flag and a sign tile from the Kenney sheet to the Brackeys palette.
- **Why:** More than half the old code is boxes, chat and dead experiments; two of three team members are new. The old build ships 107 type errors and the key in the bundle.
- **User impact:** None yet; this is the ground.
- **Research impact:** The study build stays reproducible in the old repository; the new one is the research artifact.
- **Approach:** Copy, delete, make it compile; expect a day untangling box gestures from pointer handlers in editorScene.ts and UIScene.ts.
- **Files:** apps/editor/* · ORIGIN.md · .github/workflows/ci.yml · deploy.yml
- **Depends on:** —
- **Complexity:** M
- **Risks:** Hidden coupling between painting and box code; budget two days.
- **How to test:** CI green on a smoke e2e test (boot, paint one tile, save).
- **How to measure:** 0 tsc errors; 0 key patterns in dist/; about 4,000 lines after deletion.

## G-02 — Level model with authorship and command undo (Phase 0, from roadmap W-08)
- **What changes:** level/LevelModel.ts: one grid, one entity list, start and goal, authors per cell (none · person · ghost), provenance per cell (suggestion id), a command log. Commands: paint, erase, placeEntity, removeEntity, applySuggestion(adds, removes, entities). Each has do and undo. The model emits PlacementEvents and change diffs.
- **Why:** The old editor keeps tiles in four stores and rebuilds the map after each edit; most P0 audit bugs trace to it. Ghost needs one truth and an author on every tile.
- **User impact:** Predictable edits; undo that always works.
- **Research impact:** Every tile attributable: accepted-ghost cells vs own cells is the basis of every acceptance and repair measure.
- **Approach:** Pure TypeScript, no Phaser imports. Property test: random commands then undo all = identity. applySuggestion is one command so Tab is one undo step.
- **Files:** apps/editor/src/level/LevelModel.ts · commands.ts · events.ts
- **Depends on:** G-01
- **Complexity:** M
- **Risks:** Event granularity; emit per tile with a stroke id.
- **How to test:** Unit + property tests; golden serialisation.
- **How to measure:** 0 code paths write Phaser layers directly (lint rule).

## G-03 — Renderer reads from the level model (Phase 0, from new)
- **What changes:** editor/render.ts subscribes to model diffs and updates the Phaser tilemap layer and entity sprites. Delete the base-map array, the user-tiles array, the snapshot undo and every direct putTileAt outside the renderer.
- **Why:** Closes the loop opened by G-02.
- **User impact:** What you see is the level.
- **Research impact:** —
- **Approach:** Diff-driven; full redraw only on load.
- **Files:** apps/editor/src/editor/render.ts · scenes/EditorScene.ts
- **Depends on:** G-02
- **Complexity:** S–M
- **Risks:** Low.
- **How to test:** E2E: paint, undo, redo, load fixture; screenshot comparison.
- **How to measure:** Renderer is the only module importing Phaser tilemap APIs.

## G-04 — Painting fixes and explicit tool modes (Phase 0, from roadmap W-03)
- **What changes:** Remove the right-click eyedropper that silently switches the brush to an eraser. Paint only on canvas pointer events; stop the stroke when the pointer leaves the canvas or is over DOM UI. Explicit modes: Select, Paint, Erase, Pan, with keys 1–4 and a visible indicator.
- **Why:** Audit ED-01/02/03 and UX-04; almost every study participant hit editor bugs.
- **User impact:** Tools do what they say.
- **Research impact:** Removes editor noise from acceptance and repair measures.
- **Approach:** One brush state; one pointerdown handler; DOM hit-test.
- **Files:** apps/editor/src/editor/paint.ts · ui/Toolbar.ts
- **Depends on:** G-01
- **Complexity:** S
- **Risks:** Paint feel; test at 60 and 144 Hz.
- **How to test:** E2E from the audit's scenarios.
- **How to measure:** 0 incidents in dogfood.

## G-05 — Bring in the fork's knight and export the jump tables (Phase 0, from Player Physics Fork)
- **What changes:** Copy playerPhysics.ts, playerController.ts, jumpSolver.ts and movementCapabilities.ts from b36ff59 with their tests. Wire the controller into Play mode. Export the solver's reach tables as packages/jump-tables, consumed by the window builder (knight limits in the request), the validator, the rule check and the agent.
- **Why:** The old knight is frame-rate dependent. Every 'can the knight make this' answer in the system must come from one source.
- **User impact:** Consistent jumps; coyote time and jump buffer.
- **Research impact:** Playability judgements are reproducible.
- **Approach:** Minimal edits; table export as a build step with a checked-in JSON and a regeneration test.
- **Files:** apps/editor/src/player/* · packages/jump-tables/
- **Depends on:** G-01
- **Complexity:** S
- **Risks:** Tuning differences from the study's knight; keep old constants in config.
- **How to test:** Fork's unit tests; table regeneration test; e2e Play run.
- **How to measure:** Agent and in-game trajectories agree (G-07).

## G-06 — Enemies: time-based timers, patrol spans, softer UltraSlime (Phase 0, from roadmap W-14)
- **What changes:** Delta-time timers. Each enemy gets a patrol span from the floor it stands on, stored in the model and shown in the ASCII window. UltraSlime softened. Enemies are entities, not tiles.
- **Why:** Timers fire 2.4× faster on 144 Hz; the model and the validator need to reason about where an enemy will be.
- **User impact:** Fair enemies on any screen.
- **Research impact:** Pressure becomes measurable.
- **Approach:** Elapsed ms; patrol span from surface detection.
- **Files:** apps/editor/src/entities/* · level/entities.ts
- **Depends on:** G-02, G-05
- **Complexity:** S
- **Risks:** Low.
- **How to test:** Identical behaviour at simulated 60 and 144 Hz.
- **How to measure:** —

## G-07 — Bring in the playtest agent, rule check and browser harness (Phase 0, from audit prototypes)
- **What changes:** physsim.ts into packages/physsim, running in a Web Worker with a time cap; validate_engine.cjs as its parity test. reachpy.py ported to TypeScript as the rule check. run_eval.cjs, scenarios and checks.ts into tests/e2e as Playwright fixtures. chunkgen.py and the Z3/clingo models kept under eval/py for the later algorithm filler and as reference.
- **Why:** The agent is the verdict on playability (§10) and it already exists and matches the game to 6e-14 px. The harness drove 48 replay tasks.
- **User impact:** None yet.
- **Research impact:** Verification exists from week 1.
- **Approach:** Point physsim at player/ and jump-tables; worker wrapper with postMessage and a cap; one test proves a fixture level beatable and a wall not.
- **Files:** packages/physsim/* · apps/editor/src/verify/rules.ts · tests/e2e/*
- **Depends on:** G-01, G-05
- **Complexity:** M
- **Risks:** Worker build config; a day of plumbing.
- **How to test:** Parity test; fixture tests; harness smoke test.
- **How to measure:** Fixture verification under 100 ms in the worker.

## G-08 — Save format v2 and 'Save task' (Phase 0, from roadmap W-31)
- **What changes:** JSON with version, grid, authors, provenance, entities and a suggestion-history summary. Schema-validated on load; a bad file shows a message and loads nothing. 'Save & Reload' becomes 'Save task' with an explicit reload. Import of v1 saves with author = person.
- **Why:** The old loader wipes the level silently on a bad enemy entry; authorship must persist; 'Save task' is cheap to keep.
- **User impact:** Saves that never lose work.
- **Research impact:** Saved levels carry authorship for the level-output measures.
- **Approach:** Zod or a hand schema; a v1 migration.
- **Files:** apps/editor/src/level/save.ts · ui/Toolbar.ts
- **Depends on:** G-02
- **Complexity:** S
- **Risks:** Low.
- **How to test:** Round-trip; malformed-file tests from the audit's verify/ set.
- **How to measure:** 0 silent load failures.

## G-09 — Proxy v1: key, tokens, /fill and /log (Phase 0, from roadmap W-01)
- **What changes:** A Cloudflare Worker (or campus server). /fill forwards a FillRequest to a pinned model in JSON mode with the versioned prompt and returns the parsed Suggestion; /log takes event batches. Per-session tokens from the launcher URL; rate limits; stores every request and answer with session and prompt version.
- **Why:** The key leaves the bundle; the suite needs every exchange recorded; the model id must be pinned somewhere.
- **User impact:** None.
- **Research impact:** The recordings the offline suite replays.
- **Approach:** Plain fetch handlers; KV or R2; a token script.
- **Files:** proxy/src/* · apps/editor/src/fill/client.ts
- **Depends on:** G-01
- **Complexity:** S–M
- **Risks:** CORS; open proxy if tokens are skipped.
- **How to test:** Integration against a mocked upstream; token refusal.
- **How to measure:** 0 keys in dist/; 100% of sessions recorded.

## G-10 — Contracts, config, Filler interface and a stub (Phase 0, from new)
- **What changes:** The Level, PlacementEvent, FillRequest, Suggestion and Verdict types (§7) with doc comments. suggest/config.ts with the numbers in §12. fill/Filler.ts: fill(request) → Promise<Suggestion | null>. A StubFiller returning a hard-coded staircase so Ctrl+Space shows a ghost and Tab commits it with author = ghost.
- **Why:** The streams need the shapes before they can work in parallel; the ghost layer needs something to show; the comparisons later need the interface to exist from day one.
- **User impact:** A ghost appears and can be accepted, proving the loop.
- **Research impact:** Filler swap is a config value.
- **Approach:** One types file with a changelog header.
- **Files:** apps/editor/src/fill/types.ts · Filler.ts · suggest/config.ts
- **Depends on:** G-02
- **Complexity:** S
- **Risks:** Over-designing; keep to §7.
- **How to test:** Type tests; e2e: Ctrl+Space then Tab places tiles with author = ghost.
- **How to measure:** Contract changes after week 2 ≤ 3.

## G-11 — Ghost layer (Phase 1, from new)
- **What changes:** A Phaser layer above the tilemap drawing the active Suggestion: adds at 35% opacity with a dashed edge, removes as crossed-out tiles, entities as faint sprites, one short caption near the anchor. Tab accepts all, Esc dismisses, Ctrl+Space requests. Painting on a ghost cell accepts that cell; painting elsewhere dismisses. Fades in over 120 ms. Extend ghosts anchor at the frontier; the camera nudges, never jumps.
- **Why:** The whole interaction is this layer.
- **User impact:** Suggestions visible without being in the way.
- **Research impact:** Partial accepts and drawn-over dismissals are the two most informative outcomes.
- **Approach:** Separate tilemap layer with alpha; graphics overlay for dashes and crosses; one input module.
- **Files:** apps/editor/src/ghost/GhostLayer.ts · ghost/input.ts · editor/camera.ts
- **Depends on:** G-10, G-03
- **Complexity:** M
- **Risks:** Grey tiles over grass; subtle outline; test in light and dark rooms.
- **How to test:** E2E for every key and gesture; screenshots.
- **How to measure:** Dogfood: 'could you see the ghost?' yes ≥ 90%.

## G-12 — Placement event stream, pauses and the frontier (Phase 1, from new)
- **What changes:** A rolling window of the last 12 placements with timestamps, stroke ids and tool; pause detection at config.pauseMs and longPauseMs; frontier tracking (rightmost authored column near the last stroke; topmost for vertical sections).
- **Why:** The request carries this; the confidence policy reads the pauses.
- **User impact:** —
- **Research impact:** Pause and frontier are logged.
- **Approach:** Pure functions with a small state object.
- **Files:** apps/editor/src/fill/stream.ts
- **Depends on:** G-04, G-02
- **Complexity:** S
- **Risks:** Low.
- **How to test:** Unit with synthetic sequences.
- **How to measure:** —

## G-13 — Window builder (Phase 1, from audit grid-context)
- **What changes:** Build the FillRequest: a 24×12 ASCII window around the frontier with column and row rulers every column and a legend (from the audit's gridContext.ts), authored vs accepted-ghost cells distinguished, entities marked with patrol spans, the last 8–12 placements with deltas, frontier and idle time, knight limits from jump-tables, measured numbers (G-22, stubbed as zeros until then), the brief string (G-21, a one-paragraph placeholder until then), last ghosts and outcomes, and mode.
- **Why:** The model can only draw well about what it can see. The audit's grid format raised the replay pass rate from 42 to 45 of 48.
- **User impact:** —
- **Research impact:** The request is the unit the suite replays.
- **Approach:** Pure function with golden tests; token count asserted.
- **Files:** apps/editor/src/fill/window.ts
- **Depends on:** G-12, G-02
- **Complexity:** S–M
- **Risks:** Window placement when drawing moves left or vertically; centre on the last stroke, bias toward the frontier.
- **How to test:** Golden windows for fixture states; token-count test.
- **How to measure:** Request ≤ 1,300 tokens with brief v1.

## G-14 — LLM filler and prompt v1 (Phase 1, from new)
- **What changes:** LLMFiller posts the request to /fill; one in flight, newest wins; AbortController; timeout at config.callTimeoutMs; parses the Suggestion, converts window coordinates to level coordinates, rejects schema misses. Prompt v1 in prompts/fill.v1.md with the outline in §8 and six few-shots from hand-made windows (replaced by recorded ones in Phase 2). A dev overlay shows the last answer, confidence and latency.
- **Why:** This is the research object.
- **User impact:** Ghosts drawn by the model.
- **Research impact:** Every answer recorded for the suite.
- **Approach:** Thin client; JSON mode; strict schema; prompt versioned and hashed into the log.
- **Files:** apps/editor/src/fill/LLMFiller.ts · proxy/src/fill.ts · prompts/fill.v1.md
- **Depends on:** G-13, G-09
- **Complexity:** M
- **Risks:** Coordinate errors; token growth; the audit's same-recipe behaviour. All measured in G-20.
- **How to test:** E2E with recorded answers; schema fuzz; coordinate-conversion unit tests.
- **How to measure:** Median latency ≤ 600 ms; schema misses < 2%; coordinate accuracy ≥ 95% in the suite.

## G-15 — Validator (Phase 1, from new)
- **What changes:** verify/validate.ts: shape (in bounds, on grid, no overlap with authored cells unless kind is fix, entities on valid surfaces, removes only in fix), repeat check against last ghosts (same cells or same pattern tag as the last two), and measurement bands (density and gap width of the merged window within a band around the drawing's last two screens; stub bands until G-22). Returns a Verdict with stage and reason.
- **Why:** Cheap failures should never reach the agent or the screen, and the reason text is what the model gets on send-back.
- **User impact:** —
- **Research impact:** Stage of failure is a model-quality signal.
- **Approach:** Pure functions; the reason strings are written for the model to read.
- **Files:** apps/editor/src/verify/validate.ts
- **Depends on:** G-14, G-05
- **Complexity:** S–M
- **Risks:** Bands too tight reject good ideas; start wide, tune from the suite.
- **How to test:** Unit on fixtures; property: every validator pass is a well-formed level.
- **How to measure:** Share of answers failing at shape falls over the quarter.

## G-16 — Playability verifier with send-back (Phase 1, from audit physsim)
- **What changes:** verify/playability.ts: rule check (reachability by jump tables over the suggestion's surfaces), then the agent in the worker from the nearest standable tile before the suggestion to the first after, cap config.agentCapMs. On fail, if the first answer arrived under config.sendBackIfUnderMs, append the Verdict reason to the request and call the filler once more; else drop. Returns verified Suggestion with path, or null. Nothing reaches the manager without verified: true.
- **Why:** Verified or not shown, from the first ghost.
- **User impact:** No ghost you cannot beat.
- **Research impact:** Playability-first-try and send-back pass rate are the first two model-quality metrics.
- **Approach:** Worker bridge with a cap; the rule check as pre-filter; code structure makes the unverified path impossible (the manager's type requires a VerifiedSuggestion).
- **Files:** apps/editor/src/verify/playability.ts · packages/physsim/worker.ts
- **Depends on:** G-15, G-07
- **Complexity:** M
- **Risks:** Over-cap on long sections; bound the search window to the suggestion plus two tiles each side.
- **How to test:** Fixtures: a beatable and an unbeatable suggestion; property: verified ⇒ rule check passes; e2e with an unplayable recorded answer asserts nothing shown.
- **How to measure:** Over-cap rate < 5%; 0 unverified ghosts shown (asserted by log).

## G-17 — Confidence policy and the suggestion manager (Phase 1, from new)
- **What changes:** suggest/SuggestionManager.ts: holds at most one verified suggestion; shows now if confidence ≥ showNowAbove, at the next pause if ≥ showAtPauseAbove, else after longPauseMs or on Ctrl+Space; reconciles against cells drawn since the request; enforces cool-downs and Fix interruption rules; logs every decision with shownBecause.
- **Why:** This is 'when to autofill' and 'speed versus certainty' as code.
- **User impact:** Confident ghosts appear while you draw; tentative ones wait until you pause.
- **Research impact:** shownBecause joins with outcome to give calibration.
- **Approach:** Small state machine: idle → holding → showing → cooling; all numbers from config.
- **Files:** apps/editor/src/suggest/SuggestionManager.ts · config.ts
- **Depends on:** G-16, G-11
- **Complexity:** M
- **Risks:** Thresholds wrong at first; that is what G-27 and G-29 tune.
- **How to test:** Unit: state machine with synthetic confidences and pauses; e2e latency budget tests (§24).
- **How to measure:** Finish ghost within 200 ms of the completing placement when confidence is high.

## G-18 — Log v1 (Phase 1, from roadmap W-05)
- **What changes:** research/log.ts with the events in §14; batched to /log every 5 s and on save; download at session end; a completeness checker that replays a scripted session and asserts every expected event. Every fill.call carries the request hash so the suite can join answers to requests.
- **Why:** The development loop reads this from week 4.
- **User impact:** None.
- **Research impact:** Acceptance by confidence band, drawn-over rate, verified-first-try, send-back pass, drop rate, latency, hand repair, all compute from here.
- **Approach:** Hooks in the model, the filler, the verifier, the manager, the ghost layer and Play mode.
- **Files:** apps/editor/src/research/log.ts · schema.ts · eval/metrics.ts
- **Depends on:** G-17
- **Complexity:** M
- **Risks:** Payload size (small).
- **How to test:** Completeness checker in CI; schema tests.
- **How to measure:** 100% of sessions complete.

## G-19 — Status strip, captions and the path overlay (Phase 1, from new)
- **What changes:** A one-line strip under the toolbar: what Ghost thinks the level is (from the model's answer), 'ghost: staircase · Tab to accept · Esc to dismiss' while a ghost is shown. The first three ghosts in a session carry a slightly longer caption. On accept, the agent's route is drawn for two seconds. In Play mode a key shows the route for the current section.
- **Why:** The study found participants ignored text; the route is the explanation people watch.
- **User impact:** You always know what Tab will do and how a section is meant to be beaten.
- **Research impact:** Caption shown is logged.
- **Approach:** DOM element bound to manager state; graphics overlay for the path.
- **Files:** apps/editor/src/ui/StatusStrip.ts · ghost/path.ts
- **Depends on:** G-11, G-16
- **Complexity:** S
- **Risks:** Low.
- **How to test:** E2E text and overlay assertions.
- **How to measure:** People can state what Tab does after 5 minutes (dogfood question).

## G-20 — Offline suite v1 (Phase 1, from audit replay harness)
- **What changes:** eval/: replay recorded FillRequests through the live model (or a candidate prompt/model/window); score each answer: schema ok, coordinate accuracy (did the tiles land where the ASCII suggested), validator stage, rule check, agent first try, pattern tags, difference from the previous answer in the session, stated confidence; report deltas between two configurations; store the markdown report per run. Weekly in CI and before any prompt, model or window change.
- **Why:** 'Get the LLM to perfection' needs a measurement that runs without a person.
- **User impact:** None.
- **Research impact:** The core research instrument before any study.
- **Approach:** Requests from the proxy's recordings; scorers reuse verify/ and measure/; a runner per configuration.
- **Files:** eval/src/* · eval/data/*
- **Depends on:** G-18
- **Complexity:** M
- **Risks:** Early recordings come from lab members, not students; note it and widen later.
- **How to test:** The suite is the test.
- **How to measure:** ≥ 300 recorded requests by week 6; report produced weekly.

## G-21 — Design brief v1 (Phase 2, from new)
- **What changes:** prompts/brief/: the static part (pattern catalogue with tiny ASCII examples, type rules, classic styles as rules, placement rules for coins and enemies) and the builder for the dynamic part (measured numbers for the last two screens, detected patterns, the model's last guess at level type, last five ghosts with outcomes, the variety rule). Versioned; hashed into the log.
- **Why:** The old Pewter had no notion of difficulty or variety. This is how the model learns what good looks like without a form for the user.
- **User impact:** Ghosts that fit what you are drawing and differ from the last ones.
- **Research impact:** Brief version is a variable the suite compares.
- **Approach:** Markdown fragments assembled by fill/brief.ts; token budget asserted.
- **Files:** prompts/brief/* · apps/editor/src/fill/brief.ts
- **Depends on:** G-22, G-14
- **Complexity:** M
- **Risks:** Too long hurts latency and attention; measure both in the suite.
- **How to test:** Golden brief for fixture states; token test; suite A/B of brief v0 vs v1.
- **How to measure:** Pattern fit and variety up in the suite; latency within budget.

## G-22 — Measure package (Phase 2, from new)
- **What changes:** packages/measure: density, gap and rise histograms as fractions of knight limits, leniency from agent search slack, linearity, reward spacing and share of coins on arcs, pressure, pattern tags against the catalogue, a difficulty number. Pure functions over a grid; used by the window builder, the validator bands, the status line and the suite.
- **Why:** One source of numbers for brief, checks and eval, in the field's own terms.
- **User impact:** The status line's difficulty and type guess have numbers behind them.
- **Research impact:** Diversity across levels and difficulty by configuration, the slide's level-difference measures, compute from here.
- **Approach:** Port the audit's analyses; tests against hand-labelled fixtures.
- **Files:** packages/measure/src/*
- **Depends on:** G-05
- **Complexity:** M
- **Risks:** Pattern tagging is fuzzy; start with six patterns and grow.
- **How to test:** Fixtures with hand labels; property: measures stable under translation.
- **How to measure:** Tags agree with two lab members' labels ≥ 80%.

## G-23 — Whole-level patrol and playability Fix (Phase 2, from audit clingo repair)
- **What changes:** After 3 s idle, the agent plays start → frontier in the worker (cap 1 s). If blocked, a FillRequest in mode 'patrol' is sent with the blocking point and the Verdict reason; the answer is verified as a Fix (the repaired section must be beatable) and shown at the blocking point, allowed to interrupt a Finish ghost. The brief asks for fewest-tile repairs.
- **Why:** The lab asked for suggestions that make the level playable if the person did not. People leave gaps the knight cannot clear and do not notice.
- **User impact:** A faint bridge where you cannot jump, with the measurement in the caption.
- **Research impact:** Patrol fixes accepted vs dismissed; levels beatable at save.
- **Approach:** verify/patrol.ts scheduling; manager interruption rule; fallback local proposer (bounded search over ≤ 3 tile edits, from the audit's repair idea) if the model's fix fails twice.
- **Files:** apps/editor/src/verify/patrol.ts · suggest/SuggestionManager.ts
- **Depends on:** G-16
- **Complexity:** M
- **Risks:** Patrol cost on long levels; incremental from the last known beatable point.
- **How to test:** Fixtures with a blocking gap; property: accepted patrol fix ⇒ level beatable to frontier.
- **How to measure:** Levels beatable at save ≈ 100% in Ghost sessions; patrol fix acceptance.

## G-24 — Model-initiated Fix, removals, rules of engagement (Phase 2, from new)
- **What changes:** Ghost layer draws removes crossed out in the same Suggestion as adds; Tab applies both as one undoable command. Manager rules: model-initiated fixes wait for a pause; never fix cells placed in the last 3 s; one Fix per problem per minute; a drawn-over dismissal mutes the problem until its cells change; captions state the measurement. The brief tells the model when a fix is warranted (gap beyond limits, enemy cluster beyond pressure band, coins on floors in a coin-looking level, dead frontier).
- **Why:** Fix stays in, and editing a person's tiles needs clearer manners than adding to them.
- **User impact:** You can see what would go and what would come, and undo it in one step.
- **Research impact:** Fix outcomes separable by problem class from the label.
- **Approach:** GhostLayer removal rendering; manager Fix policy in config; brief fragment.
- **Files:** apps/editor/src/ghost/GhostLayer.ts · suggest/SuggestionManager.ts · prompts/brief/fix.md
- **Depends on:** G-21, G-11
- **Complexity:** S–M
- **Risks:** Feels like correction; captions give numbers; dismiss rate watched separately.
- **How to test:** E2E: Fix shown, Tab, undo restores exactly.
- **How to measure:** Fix dismiss rate < 50%; undo-after-Fix rate.

## G-25 — Variety (Phase 2, from new)
- **What changes:** History of the last five ghosts in the brief with the rule that an Extend must differ in pattern tag from the last two accepted; validator rejects an Extend whose tags match both; the suite fails if any tag appears three times running in a session. Two-sample mode for Extend behind a flag: ask twice at modest temperature, keep the one less like the history.
- **Why:** The audit's 36-of-36 same-recipe result is the failure to design against. Extend is where the model can give an idea.
- **User impact:** The next-screen idea is not the last one again.
- **Research impact:** Patterns per session is a primary signal.
- **Approach:** Brief fragment; validator rule; suite scorer; optional two-sample in the filler.
- **Files:** prompts/brief/variety.md · verify/validate.ts · eval/src/variety.ts · fill/LLMFiller.ts
- **Depends on:** G-21, G-20
- **Complexity:** S–M
- **Risks:** Forced variety producing nonsense; the agent and bands still gate it.
- **How to test:** Suite rule; unit on the validator check.
- **How to measure:** Distinct patterns per session ≥ 5; no tag three times running.

## G-26 — Collectable and enemy rules (Phase 2, from new)
- **What changes:** In the brief: coins on the arc the knight would take between two surfaces (the arc given as a small table of offsets per gap width from jump-tables), coin ladders and risky coins over pits, never flat on a floor in a coin-looking level; enemies with ≥ 4 tiles of patrol and never within 2 tiles of a landing. In the validator: the same as checks with reasons. In the measure package: share of coins on arcs.
- **Why:** The lab named collectables as the thing to get right; the study saw coins laid flat on platforms.
- **User impact:** Coins that make you jump; enemies that are fair.
- **Research impact:** Share of coins on arcs is a difficulty signal the first study lacked.
- **Approach:** Arc offsets exported from jumpSolver's trajectory; brief fragment; validator checks.
- **Files:** packages/jump-tables/arcs.json · prompts/brief/placement.md · verify/validate.ts
- **Depends on:** G-21, G-22
- **Complexity:** S–M
- **Risks:** Arcs clipping ceilings; the agent catches it.
- **How to test:** Unit: every arc coin reachable by the agent on fixtures.
- **How to measure:** Share of accepted coins on arcs rising.

## G-27 — Confidence calibration experiments (Phase 2, from new)
- **What changes:** On the same recorded sessions compare three confidence sources: the model's stated number; mean token log-probability of the tile list where the API exposes it; agreement between two samples (shared cells ÷ union). Plot each against acceptance from the log. Pick the steepest; set showNowAbove and showAtPauseAbove from the curve.
- **Why:** The timing dial only works if confidence means something.
- **User impact:** Ghosts show at the right moments more often.
- **Research impact:** The lab's 'when to autofill' answered with a curve.
- **Approach:** eval/src/calibration.ts; a flag in the filler for the source.
- **Files:** eval/src/calibration.ts · fill/LLMFiller.ts · suggest/config.ts
- **Depends on:** G-20
- **Complexity:** M
- **Risks:** Log-probabilities unavailable on the chosen API; then two-sample vs stated only.
- **How to test:** The experiment is the test.
- **How to measure:** Acceptance in the top confidence band ≥ 1.5× the bottom band.

## G-28 — Model and window-size selection (Phase 2, from new)
- **What changes:** Run the suite across candidate models (smallest first) and window sizes (16×10, 24×12, 32×14, each with and without a one-line summary of the rest of the level). Choose the smallest model and window that meet the playability-first-try, coordinate-accuracy and latency targets. Pin the choice in the proxy.
- **Why:** Speed versus certainty decided by evidence, not by defaulting to a bigger model.
- **User impact:** Faster ghosts at the same quality.
- **Research impact:** A documented trade-off table.
- **Approach:** Suite runner over a matrix; one report.
- **Files:** eval/src/matrix.ts · proxy/src/fill.ts
- **Depends on:** G-20
- **Complexity:** S–M
- **Risks:** Model availability changes; re-run on change.
- **How to test:** —
- **How to measure:** Chosen configuration meets targets; table in docs/.

## G-29 — Weekly dogfood sessions and dashboard (Phase 3, from new)
- **What changes:** A 30-minute weekly session where every lab member draws a level with the current build, answers three questions (did a suggestion give you an idea you would not have had; how did that feel; what annoyed you), and the log is pulled. A static dashboard from the logs: acceptance by kind and confidence band, drawn-over rate over session time, verified-first-try, send-back pass, drop rate, latency, hand repair inside ghost cells, patterns per session, and the measure package over saved levels (diversity, difficulty).
- **Why:** The slide's signals (dismiss vs accept, unique ideas, satisfaction, diversity, difficulty) measured early and often on ourselves.
- **User impact:** —
- **Research impact:** The human half of the development loop.
- **Approach:** eval/metrics.ts output rendered with a small chart library; no server.
- **Files:** eval/dashboard/* · docs/dogfood.md
- **Depends on:** G-18
- **Complexity:** S
- **Risks:** Lab members are not students; note it, widen when the lab wants to.
- **How to test:** Snapshot on a fixture log.
- **How to measure:** Session held every week from week 4.

## G-30 — Prompt and few-shot iteration (Phase 3, from new)
- **What changes:** Each week: read the dashboard and the suite report; change one thing in prompts/ (text, few-shots from recorded sessions, brief fragment, window size, thresholds); run the suite; ship if playability-first-try and calibration did not drop and the target measure rose. Keep a changelog with the numbers.
- **Why:** This is the work of 'getting the LLM to perfection' as a routine rather than an event.
- **User impact:** Steadily better ghosts.
- **Research impact:** An auditable record of what changed what.
- **Approach:** docs/prompt-changelog.md; suite report linked per entry.
- **Files:** prompts/* · docs/prompt-changelog.md
- **Depends on:** G-27, G-28, G-29
- **Complexity:** ongoing
- **Risks:** Changing two things at once; the rule is one.
- **How to test:** The suite.
- **How to measure:** Three consecutive weeks of improvement on the primary measures.

## G-31 — Reference examples in the brief (Phase 3, from new)
- **What changes:** Lab-authored reference levels (three or four per type) saved in format v2; measured with the measure package; sliced at rests into small ASCII chunks tagged with patterns and numbers; at request time, retrieve the two or three most similar chunks to the current window and append them to the brief as 'sections others have drawn here'.
- **Why:** Showing good sections beats describing them; the lab wanted reference levels fed in and learned, later.
- **User impact:** Ghosts that look like well-made levels.
- **Research impact:** Example retrieval is a variable the suite compares.
- **Approach:** Slicing in packages/measure; retrieval by measured-number distance; token budget.
- **Files:** packages/measure/src/slice.ts · apps/editor/src/fill/examples.ts · levels/reference/*
- **Depends on:** G-22, G-08
- **Complexity:** M
- **Risks:** Examples that only fit their source; the agent and bands still gate.
- **How to test:** Suite A/B with and without examples.
- **How to measure:** Pattern fit and variety up with examples; latency within budget.

## G-32 — Send-back and latency tuning (Phase 3, from new)
- **What changes:** Decide from data whether a failed answer goes back once or is dropped: second-try pass rate vs added latency, by kind. Tune callTimeoutMs, agentCapMs and sendBackIfUnderMs. Keep the three latency-budget e2e tests (§24) green.
- **Why:** Latency against a second chance at a good idea is a trade the data should make.
- **User impact:** Fewer dropped ghosts, no slower.
- **Research impact:** —
- **Approach:** Dashboard cut by kind; config change; tests.
- **Files:** suggest/config.ts · tests/e2e/latency.spec.ts
- **Depends on:** G-16
- **Complexity:** S
- **Risks:** Low.
- **How to test:** The latency tests.
- **How to measure:** Drop rate < 10%; Finish within 200 ms kept.

## G-33 — Condition switch, kept cheap (Phase 3, from new)
- **What changes:** A config value set by launcher token: filler = llm | algo | none, and the status strip never reveals it. 'Save task' kept. Nothing else: no study instruments, no tasks, no surveys in this quarter.
- **Why:** Makes a study possible later at near-zero cost now.
- **User impact:** —
- **Research impact:** Assignable conditions when the lab wants them.
- **Approach:** Token → config override in the proxy.
- **Files:** proxy/src/sessions.ts · suggest/config.ts
- **Depends on:** G-18
- **Complexity:** S
- **Risks:** Low.
- **How to test:** E2E per filler value.
- **How to measure:** —

## G-34 — Generative-algorithm filler (Phase Later, from audit chunkgen.py)
- **What changes:** AlgoFiller behind the Filler interface: port chunkgen.py and the rule checker; detect repeats and open structures locally for Finish; generate profile-parameterised chunks for Extend; a simple timing rule (repeat of 3, pause at frontier) producing a confidence-like number. Same validator, same verifier, same ghost layer.
- **Why:** The comparison on the lab's slide: does a generator do as well without a model?
- **User impact:** Same ghosts, different brain.
- **Research impact:** The 'with algo' condition.
- **Approach:** packages/chunks from eval/py; local detectors.
- **Files:** packages/chunks/* · apps/editor/src/fill/AlgoFiller.ts
- **Depends on:** G-10, G-07
- **Complexity:** L
- **Risks:** Thin vocabulary looks samey; build only when the LLM filler is good.
- **How to test:** Property: every chunk passes the rule check; e2e.
- **How to measure:** Comparable acceptance and variety numbers to the LLM filler on the same sessions.

## G-35 — Pure generation modes (Phase Later, from new)
- **What changes:** 'Generate level' with the LLM (whole-level in windows, verified screen by screen) and with the algorithm. Set aside by the lab for now.
- **Why:** The slide's third question, for later.
- **User impact:** —
- **Research impact:** The 'pure' conditions.
- **Approach:** Reuses the filler and verifier over successive windows.
- **Files:** apps/editor/src/fill/generate.ts
- **Depends on:** G-14
- **Complexity:** M
- **Risks:** —
- **How to test:** —
- **How to measure:** —

## G-36 — Jev as a cheap timing system (very late) (Phase Later, from audit typed-decision)
- **What changes:** JevTimer implements the 'show now / wait / hold' decision from the same request, replacing confidence as the timing source for a session, offline first on recorded sessions against the LLM's own confidence, then live only if it matches or beats it at lower cost.
- **Why:** A possible cost reduction once we know what good timing looks like. Explicitly very late per the lab.
- **User impact:** None unless it goes live.
- **Research impact:** A timing comparison.
- **Approach:** Same interface; same suite.
- **Files:** apps/editor/src/suggest/timers/jev.ts · eval/src/compare.ts
- **Depends on:** G-10, G-20
- **Complexity:** M
- **Risks:** Access and terms.
- **How to test:** The suite.
- **How to measure:** Agreement with acceptance vs the LLM's confidence, and cost per session.

## G-37 — Play mode settings and sharing by code (Phase Later, from new)
- **What changes:** Adjustable game settings in Play mode (gravity, speed, enemy aggression) stored with the level; a share code that encodes the level compactly (or a short id resolving through the proxy) for passing levels between people.
- **Why:** On the lab's project slide; quality of life once the core loop is solid.
- **User impact:** Tune the feel; send a level with a code.
- **Research impact:** Makes play-through by others easy when the lab wants it.
- **Approach:** Settings in save v2; base64 of a compressed grid or a proxy-stored id.
- **Files:** apps/editor/src/editor/play.ts · level/share.ts · proxy/src/levels.ts
- **Depends on:** G-06, G-08
- **Complexity:** S–M
- **Risks:** Settings change playability; the agent must use the same settings.
- **How to test:** Round-trip tests.
- **How to measure:** —

## G-38 — Distilled small model (Phase Later, from new)
- **What changes:** If latency or cost demands it: fine-tune a small model on accepted ghosts and suite-passing answers from recorded sessions, behind the same filler, judged by the same suite.
- **Why:** The eventual answer to speed versus certainty if prompting alone cannot get there.
- **User impact:** Faster ghosts.
- **Research impact:** A trained artifact of the lab's own data.
- **Approach:** Export (request, accepted answer) pairs; fine-tune; pin in the proxy.
- **Files:** eval/src/export.ts · proxy/src/fill.ts
- **Depends on:** G-20, G-29
- **Complexity:** L
- **Risks:** Data volume; overfitting to lab members.
- **How to test:** The suite.
- **How to measure:** Same quality at lower latency.
