# Pewter Ghost UI before the restyle: inventory and constraints

This document lists what the Pewter Ghost editor draws on screen today and what a restyle toward the Pewter Platformer look must not break. It reflects main at `d1c01ba`, which includes `bccdd3c` (automatic dev token). It was written from the source and from running both apps. Nothing here changes app code.

- Screenshots of the current UI are in `docs/look/before/`. The old app is described in `docs/look/OLD_LOOK.md`, with screenshots in `docs/look/reference/`. §4.6 covers where OLD_LOOK's recommended layout conflicts with the tests.
- The screenshots were taken with Playwright Chromium 1194 using `deviceScaleFactor: 1`, waiting about 4 s after `load` on `npx vite --port 5311`. The script is outside the repo at `/tmp/claude-0/look-work/shoot-new.cjs`.
- Baseline before any restyle work: `npx vitest run` passes 89 files and 1328 tests. `npx tsc --noEmit -p .` is clean. The e2e result is in §8.

| Screenshot | What it shows |
| --- | --- |
| `before/new-1440.png`, `before/new-1920.png` | The default view with the AI off: plain URL, empty storage, no token, so a human-only session. Automated browsers always get this. Since `bccdd3c`, a person's browser also gets it when no local proxy is running, and logs `Failed to load resource: net::ERR_CONNECTION_REFUSED`. The status strip is hidden and the first-run hint toast is showing. The canvas overflows the stage (§3.1). |
| `before/new-ai-1440.png`, `before/new-ai-1920.png` | The default view with the AI on: an llm session with `/session` mocked as in the e2e harness and the loop paused. Since `bccdd3c`, a person's browser at the plain dev URL gets this when `npm run dev:ai` (the local proxy) is up. The strip reads "quiet · Ctrl+Space to ask". |
| `before/new-ghost-1440.png`, `before/new-ghost-1920.png` | `?fresh=1&filler=stub`, with the loop paused and a hand-made verified "staircase" ghost shown through `window.__pewter.ghost.show`. It shows faint tiles, a faint coin, the dashed outline, the caption "staircase · Tab", the strip with its teaching line, and "Ghost thinks: parkour". |
| `before/new-help-1440.png`, `before/new-settings-1440.png`, `before/new-share-1440.png` | The Help (Keys), Play settings and Share code dialogs. |
| `before/new-paint-sign-1440.png` | Paint mode with the Sign brush. The mode pill reads "Paint · sign" and the sign-text field is open in the palette. |
| `before/new-play-1440.png` | Play mode: Stop button, disabled chrome, the HUD pill, the knight at Play zoom and the strip saying "playing · Esc to edit". |
| `before/new-dev-1440.png` | `?dev=1`: the dev overlay at the stage's top-left. |

---

## 1. Page structure

```
<body>
  div#app.pg-app                               (flex column, 100vh)
    div.pg-toolbar-slot
      header.pg-toolbar[role=toolbar]          (Toolbar.ts, 48 px, white, bottom border)
    div#ghost-status.pg-status-slot[aria-live] (layout.ts; StatusStrip mounts here; hidden while :empty)
      div#pg-ghost-strip.pg-ghost-strip[data-tone]
    main.pg-main                               (flex row)
      div.pg-palette-slot                      (left, 172 px, white, right border, scrolls)
        aside.pg-palette
      div#pg-stage.pg-stage                    (flex 1, overflow hidden, background #8fd3ff)
        canvas                                 (Phaser, Scale.RESIZE, parent = #pg-stage)
        div.pg-toasts[role=status]             (absolute bottom-right, z 5)
        div.pg-ghost-overlay                   (absolute inset 0, pointer-events none, z 4)
          div.pg-ghost-caption / button.pg-ghost-arrow
        div#pg-ghost-dev.pg-ghost-dev          (only with ?dev=1, top-left, z 6)
  div.pg-backdrop > div.pg-dialog[role=dialog] (appended to <body> while a dialog is open, z 20)
```

The old app is laid out differently:

- The page is dark (`#08080f`) and uses Space Grotesk loaded from Google Fonts.
- A small uppercase label, "PEWTER PLATFORMER", sits above the canvas.
- The canvas is a fixed, centred 1280x720 Phaser CANVAS.
- Phaser DOM elements float over the canvas: a right-hand panel with Chat, Blocks and Controls tabs, and a bottom toolbar with Play, Deselect, Save, Load and Save & Reload.
- A minimap sits at the canvas's top-left.

---

## 2. Every file that produces visible UI

All paths are under `apps/editor/`.

| File | What it renders | How it is mounted | DOM ids, classes and attributes it creates |
| --- | --- | --- | --- |
| `index.html` | `<title>Pewter Ghost</title>`, `favicon.png` and an empty `div#app`. There are no fonts and no inline CSS. | Vite root (`vite.config.ts` sets `root: apps/editor`, `base: "./"`). | `#app` |
| `src/style.css` | All chrome CSS: tokens `--pg-bg #eef2f7`, `--pg-panel #fff`, `--pg-ink #1d2738`, `--pg-muted #5b6678`, `--pg-line #d5dce6`, `--pg-accent #3b6ef5`, `--pg-play #1f9d55`, `--pg-warn`, `--pg-error #c53030`, `--pg-radius 8px`, `--pg-swatch 32px`, `--pg-toolbar-h 48px`. Fonts are `system-ui`. Breakpoints: at 1440 px or less `.pg-brand` is hidden; at 1100 px or less button labels are hidden and the palette is 140 px. | Imported first in `main.ts:13`. | Styles `.pg-app .pg-toolbar .pg-brand .pg-group .pg-spacer .pg-btn(.pg-active .pg-temp .pg-btn-primary .pg-btn-play .pg-btn-quiet .pg-btn-small) .pg-icon .pg-status-slot .pg-main .pg-palette-slot .pg-stage .pg-palette .pg-palette-group .pg-palette-list .pg-palette-item .pg-swatch .pg-swatch-eraser .pg-sign-text .pg-toasts .pg-toast(-warn,-error,-out,-details,-actions) .pg-backdrop .pg-dialog(-wide,-head,-body,-actions) .pg-help-lead .pg-help-foot .pg-keys .pg-code .pg-share-status .pg-error .pg-settings-row .pg-settings-value .pg-settings-apex` |
| `src/main.ts` | Boot. It builds the layout, the toasts, the toolbar and the palette, binds shortcuts, starts Phaser and owns every toast and confirm dialog text (§4.3). | `buildLayout(#app)` (`:75`). `Toasts(layout.stage)` (`:76`). The Phaser config (`:145-156`) uses `parent: layout.stage`, `backgroundColor "#8fd3ff"`, `pixelArt`, `Scale.RESIZE` and scenes `[LoadingScene, EditorScene, UIScene]`. `window.__pewter` is set at `:158`. `Toolbar` is created at `:275` and `Palette` at `:276`. The palette swatches get their image from the `pg-tiles` texture as a data URL (`:329-330`). | Writes localStorage `pewter-ghost:hint` (`:356`). |
| `src/ui/layout.ts` | The page skeleton. | Called once from `main.ts`. | `.pg-app` on `#app` (`:17`), `.pg-toolbar-slot` (`:18`), `#ghost-status.pg-status-slot[aria-live=polite]` (`:20`), `.pg-palette-slot` (`:21`), `#pg-stage.pg-stage` (`:22`), `main.pg-main` (`:23`). |
| `src/ui/dom.ts` | Nothing. It provides `h()` (attributes; `on*` keys become listeners; `text` sets textContent) and `clear()`. | Used by every `ui/*.ts` file. | n/a |
| `src/ui/Toolbar.ts` | The top bar. From the left: brand "Pewter Ghost"; mode radio group Select / Paint / Erase / Pan, each with an icon (⬚ ✎ ⌫ ✥), a label and a `<kbd>` key 1-4; "↶ Undo" and "↷ Redo"; "▶ Play", which becomes "■ Stop" in Play; "Save task" (dark primary), "Reload", "Load…" and "Share code"; a spacer; then "⚙ Settings" and "? Help". In Play it disables modes, Undo, Redo, Save, Reload, Load and Share. | Appended to `.pg-toolbar-slot`. `update()` runs on every model or mode change and on play start and end (`main.ts:278-327`). | `header.pg-toolbar[role=toolbar][aria-label=Editor]` (`:66`), `.pg-brand` (`:67`), `.pg-group[role=radiogroup]` (`:40`), `button.pg-btn.pg-mode[role=radio][data-mode=select\|paint\|erase\|pan][title]` (`:45-50`), `span.pg-icon` and `kbd` (`:52-54`), `button.pg-btn[data-cmd=undo\|redo\|play\|save\|reload\|load\|share\|settings\|help]` (`:60`), `.pg-btn-play` and `.pg-btn-primary`, `.pg-spacer` (`:79`). State classes are `.pg-active` and `aria-checked` (`:88-90`), `.pg-temp` (the Space-pan mode, `:89`), `.pg-playing` on the header (`:99`), and `disabled`. |
| `src/ui/Palette.ts` + `paletteItems.ts` | The left block palette in five groups. Terrain: Block, Grass half, Dirt, Grass, Question. Collectables: Coin, Fruit. Enemies: Slime, Ultra slime. Markers: Goal flag, Sign, Start, plus the sign-text input. Tools: Eraser. Each item is a 32 px pixelated swatch from the `pg-tiles` composite with a label under it. Choosing an item switches to Paint, or to Erase for the eraser. | Appended to `.pg-palette-slot`. The swatch image is set after boot by `setTileImage()`. | `aside.pg-palette[aria-label=Palette]` (`:33`), `section.pg-palette-group > h4` (`:37`), `.pg-palette-list` (`:35`), `button.pg-palette-item[data-item=<id>][title][aria-pressed]` (`:51-55`, `:79`), `span.pg-swatch` with inline `--frame` (`:46-48`), `.pg-swatch-eraser`, `span.pg-palette-label` (`:59`), `input.pg-sign-text[placeholder="Sign text"][value="Hello!"][maxlength=120]` (`:21-28`, hidden unless the brush is sign). CSS vars `--pg-tiles-url` and `--pg-swatch` are set on the aside (`:86-87`). Item ids: `block grass_half dirt grass question coin fruit slime ultraslime flag sign start eraser` (`paletteItems.ts:39-53`). |
| `src/ui/StatusStrip.ts` | The ghost status line under the toolbar. On the left is the main text (from `ghost/caption.ts stripText`). On the right, in italics, is "Ghost thinks: …". It is bold with a dashed square before it in the `ghost` tone and green in the `play` tone. In human-only sessions (`mode: "off"`) it is removed, so the slot is `:empty` and hidden. | `new StatusStrip(api.statusSlot)` in `ghost/session.ts:133`. It injects its own `<style id="pg-status-strip-style">` (`:16-32`). | `#pg-ghost-strip.pg-ghost-strip[data-tone=ghost\|quiet\|play]` (`:45-46`), `.pg-ghost-strip-main[title]` (`:48`), `.pg-ghost-strip-guess` (`:50`). |
| `src/ui/HelpOverlay.ts` | The "Keys" dialog: a lead line, a 16-row key table (`HELP_KEYS`, `:6-20`), a foot note and "Got it". | `toggleHelp()` from `[data-cmd=help]`, `?`, `F1` or `h`. | Dialog `id="pg-help"` (`:44`), `p.pg-help-lead`, `table.pg-keys` with `kbd`, `p.pg-help-foot`, `.pg-dialog-actions`, `button.pg-btn.pg-btn-primary` "Got it". |
| `src/ui/Toast.ts` | Corner messages in the stage's bottom-right. Info toasts close after 3.5 s; warn toasts use the same default unless a duration is given; error toasts stay until closed. A toast may carry a details list, action buttons and a "×" close button. | `new Toasts(layout.stage)` (`main.ts:76`). `EditorApi.notify` also routes here. | `.pg-toasts[role=status][aria-live=polite]` (`:15`), `.pg-toast.pg-toast-<info\|warn\|error>[data-kind]` (`:27`), `.pg-toast-text`, `ul.pg-toast-details`, `.pg-toast-actions`, `.pg-btn.pg-btn-small`, `.pg-btn-quiet[aria-label=Close]`, and `.pg-toast-out` while fading. Each toast has `pointer-events: auto`. |
| `src/ui/Dialog.ts` | The generic modal: a backdrop, a head with an `h2` and "×", and a body. While it is open, editor and ghost shortcuts are off (`isDialogOpen`). A capture-phase `keydown` closes it on Escape (`:22-28`). It focuses the first textarea, input or primary button. | Appended to `document.body`. | `.pg-backdrop` (`:36`), `.pg-dialog(.pg-dialog-wide)[role=dialog][aria-modal][aria-label=<title>][id?]` (`:32`), `.pg-dialog-head > h2` and a close `button.pg-btn.pg-btn-quiet` (`:33`), `.pg-dialog-body` (`:29`). |
| `src/ui/ShareDialog.ts` | The "Share code" dialog. Under "This level" are the code textarea, a status line and "Copy". Under "Open a level from a code" are a warning, the paste textarea, a status line and "Open this level". | `openShareDialog()` from `[data-cmd=share]`. | Dialog `id="pg-share"` (wide, `:74`), `textarea#pg-share-out.pg-code[readonly]` (`:19`), `p.pg-share-status` (`:20`, `:43`), `textarea#pg-share-in.pg-code[placeholder="Paste a code (pg1.…)"]` (`:42`), `.pg-error` added on failure (`:56`), and buttons "Copy" and "Open this level". |
| `src/ui/PlaySettingsPanel.ts` | The "Play settings" dialog: four range sliders (Gravity, Run speed, Jump power, Enemy aggression), each with its value and a hint, then an apex line, "Reset" and "Done". | `openPlaySettings()` from `[data-cmd=settings]`. | Dialog `id="pg-play-settings"` (`:56`), `.pg-settings-row` (`:41`), `input[type=range]#pg-set-<key>[data-setting=<key>]` with keys `gravityScale speedScale jumpScale enemyAggression` (`:24-32`), `.pg-settings-value`, `small`, `p.pg-settings-apex`. |
| `src/editor/EditorScene.ts` | The level (through `render.ts`), the camera, painting and Play. It also draws the hover cursor: a 1 px dark rim plus a coloured rect (white for paint, red with an X for erase, grey for pan, blue for select). In Paint mode it adds a 50%-alpha preview of the brush tile (`:267-291`). It emits the mode, hover, inspect, HUD and play events used by UIScene (`:50-56`). When Play ends at the goal it raises the "Goal! …" toast (`:229-237`). | The second Phaser scene. Its camera background is `SKY_COLOR` (`:89`). | None. Everything is drawn on the canvas. |
| `src/editor/LoadingScene.ts` | "Loading…" (14 px, `#24324a`) above a 200x6 progress bar, centred on the sky colour. | The first scene. It builds textures and then starts the editor. | None. |
| `src/editor/UIScene.ts` | In-canvas pills drawn as Phaser text that does not zoom. They use a 13 px system-ui font, colour `#f4f7fb`, background `#1d2738d9` and padding 8/4. The mode indicator sits at (10,10) and reads "Select", "Paint · grass", "Pan (Space)" and so on. The hover line at the bottom-left reads "x 12 · y 7", and in Select mode a click shows the inspector line "(x, y) grass · placed by you" for 2.5 s. In Play the HUD at (10,10) reads "♥♥♥♥♥ coins 0/3 deaths 0 1.8s Esc / Q to stop (no goal flag yet)". Sign text appears as a cream bubble at top-centre. | Launched by `EditorScene.create()` and kept on top. | Phaser object name `mode-indicator`. No DOM. |
| `src/editor/render.ts` | Everything else on the level: the tile layer (`pg-tiles`), the grid TileSprite (`pg-grid`) over the level only, entity sprites, the start marker, the goal marker (flag frame at alpha 0.6) and enemy patrol marks. Slimes get a green dashed span (`0x9be15d`), ultra slimes a pink one (`0xff6fae`), and an enemy with no floor gets a red cross (`:177-201`). In Play it hides the grid, entities, markers and patrols. | `new Renderer(scene, model)` in `EditorScene.create`. | None. |
| `src/editor/camera.ts` + `cameraMath.ts` | View placement and zoom (§3). | `CameraController`. | None. |
| `src/editor/assets.ts` | It loads `phaserAssets/pewterPlatformerTilesetExtended.png` (the Brackeys strip, 240x16, 15 frames), `tilemap_packed.png` (Kenney, 18 px frames) and `pellets.png`. It builds `pg-tiles` (16 frames x 16 px) and `pg-grid` (16x16 with a 1 px top and left line in `rgba(20,40,70,0.11)`). The start marker is drawn in code as a green pennant (`:22-35`). | Called from `LoadingScene` and again, safely, from `EditorScene`. | None. |
| `src/editor/constants.ts` | Asset keys, the `FRAME` map, `FRAME_SOURCES`, `ENTITY_FRAME`, `DEPTH` (background 0 is unused, grid 5, tiles 10, entities 20, markers 25, ghost 30, ghostCaption 35, cursor 40, player 50, pellets 55, hud 100), `SCENE` keys and `SKY_COLOR = 0x8fd3ff`. | Imported. | None. |
| `src/editor/newLevel.ts` | The starter level (§3.4). | `starterSnapshot()` in `main.ts:96`. | None. |
| `src/editor/play.ts` | Play mode inside the editor scene: the knight sprite, live enemies, pellets, pickups and signs, plus the HUD data. Its camera follows at zoom `clamp(viewport.h / 192, 1, 5)`, which keeps 12 tiles in view vertically (`camera.ts:195`). | `PlayController`. | None. |
| `src/ghost/GhostLayer.ts` | The single active suggestion. Added tiles are the real frames at alpha 0.35; entities at 0.45. They sit inside a dashed outline: light `#fff` dashes on a dark rim. Removals are dimmed and get a red cross on a dark rim inside a dashed red box (`#ff4d5a`). It fades in over 120 ms and never pulses. A DOM caption sits above the anchor and fades after 2 s. A DOM edge arrow (➜, round, dashed border, "N tiles") appears when the ghost reaches past the view. | Built by `GhostSession` (`ghost/session.ts:126`). It draws at `DEPTH.ghost`. | `div.pg-ghost-caption(.pg-in .pg-out .pg-fix)` (`:91`), `button.pg-ghost-arrow[aria-label="Scroll to the suggestion"][tabindex=-1]` holding `span` and `small` (`:93-101`). |
| `src/ghost/overlay.ts` | The DOM layer over the canvas for the caption and arrow. | Appended to `#pg-stage` (`:24`). | `div.pg-ghost-overlay[aria-hidden=true]` (`:22`). |
| `src/ghost/styles.ts` | Injected CSS for the caption, arrow and dev overlay. It uses system-ui and dark translucent pills with dashed white borders. | `injectGhostStyles()` creates `<style id="pg-ghost-style">` (`:5`). | `.pg-ghost-overlay` (z 4), `.pg-ghost-caption`, `.pg-ghost-arrow`, `.pg-ghost-dev` (z 6). |
| `src/ghost/path.ts` | The route overlay: a yellow line (`#ffd23f`) on a dark rim, with dots at turns and a ring at the end. It shows for 2 s after Tab, and in Play while `R` is held. | A Phaser Graphics object at `DEPTH.ghost + 1`. | None. |
| `src/ghost/caption.ts` | Every word the ghost says (strip and caption). See §4.4. | Pure functions. | None. |
| `src/ghost/devOverlay.ts` | With `?dev=1`, a monospace panel at the stage's top-left: fills, manager state, threshold, last answer, filler, confidence, latency and verdict. It is never shown to participants. | `new DevOverlay(api.stage)` (`ghost/session.ts:134`). | `div#pg-ghost-dev.pg-ghost-dev` (`:78-80`). |
| `src/ghost/session.ts` | Wires the layer, strip, dev overlay, keys and routes together. It owns the toasts "No checked route for this section yet." (`:298`) and "That suggestion could not be applied." (`:391`). | `app.attachEditor(api, startGhost)` (`main.ts:159`). | Sets `window.__pewter.ghost` (`:434-454`). |

---

## 3. The canvas today

### 3.1 Renderer and sizing
- The renderer is `Phaser.AUTO`, which means WebGL; `?renderer=canvas` forces Canvas. `pixelArt: true`. Phaser is 3.90.0 in both repos. The old app used `Phaser.CANVAS` at `resolution = min(devicePixelRatio, 2)` with a fixed 1280x720 canvas.
- `Scale.RESIZE` uses `#pg-stage` as its parent, so the canvas is meant to fill the stage.
- **Existing sizing bug.** In human-only sessions the canvas is never resized to the stage. That covers the default URL with no token, `?filler=none`, and the e2e specs `painting`, `saveload` and `condition-none`.
  - How it happens: `main.ts:150` takes the stage size before the toolbar and palette mount, so the game is created at window size. Phaser's 500 ms poll only refreshes when the parent's size *changes*, and it has already recorded the final stage size.
  - What it costs: the canvas stays window-sized, and the stage's `overflow: hidden` cuts off the right 172 px and the bottom 48 px.
  - When it corrects itself: in llm and stub sessions, mounting the status strip shrinks the stage, which fires the poll and fixes the size.

  Measured after 4 s:

  | Viewport | Session | Stage (CSS px) | Game / canvas | Zoom after `home()` | Rightmost tile column fully on screen |
  | --- | --- | --- | --- | --- | --- |
  | 1366x768 | stub (strip on) | 1193x693 | 1193x693 | 1.883 | 36 |
  | 1366x768 | human-only | 1193x720 | **1365x768** | 2.087 | **32** |
  | 1440x900 | stub | 1267x825 | 1267x825 | 2.242 | 31 |
  | 1440x900 | human-only | 1267x852 | **1439x900** | 2.446 | **28** |
  | 1920x1080 | stub | 1747x1005 | 1747x1005 | 2.731 | 36 |
  | 1920x1080 | human-only | 1747x1032 | **1919x1080** | 2.935 | **33** |

  A restyle that moves chrome should create the game after the chrome is in place, or call `game.scale.refresh()` (or use a ResizeObserver) once layout settles. Fixing this changes the human-only zoom: at 1366x768 it becomes 1.957, with columns up to 35 visible.

  When the size does correct itself in llm sessions, the zoom is only clamped (`camera.onResize`), not refitted. It stays at the pre-resize value until something calls `home()`. In `new-ai-1440.png` the zoom is 2.446 against a fit of 2.242. The e2e helper calls `home()` after ready, so tests always get the fitted zoom.

### 3.2 Zoom and camera (`camera.ts`, `cameraMath.ts`)
- The level is 200x20 tiles of 16 px, 3200x320 world px (`contracts.ts:14-16`).
- `home(start)` sets zoom to `clamp(fitZoom, 1, 4)`, where `fitZoom = viewport.h / (320 + 48)`, so the whole level height fits with 24 px of sky above and below. It then centres x at `start.x*16 + 0.3*viewWidth`. Clamping leaves the left edge of the view at x = -3 tiles (48 px of padding), so 3 columns of grid-less sky show left of column 0.
- The zoom range is from `max(0.1, fit*0.5)` to `max(8, fit)`. Ctrl or Cmd plus the wheel, or a pinch, zooms around the pointer. `+` and `-` zoom by 1.25x, and `Ctrl+0` resets. A plain wheel pans sideways when the level fits vertically. WASD and the arrow keys pan at 600 px/s, three times faster with Shift. Space-drag and two-finger drag pan. The camera may show 48 px past every level edge.
- In Play the camera follows the knight at `clamp(viewport.h/192, 1, 5)` (about 3.6x at 693 px), with bounds `(0, -64, 3200, 384)`. The edit view is restored afterwards.
- The old app is different: zoom is fixed at 2.25 at start (minimum 2.25, maximum 10) on a fixed 1280x720 canvas. That shows exactly 20 rows, the camera is bounded to the map with no padding and starts at the top-left, and Play keeps zoom 2.25.

### 3.3 Background colour, grid and backdrop
- The sky is a flat `#8fd3ff`, set in three places: the Phaser config (`main.ts:148`), the camera (`EditorScene.ts:89`, `SKY_COLOR`) and the CSS `.pg-stage` background.
- The grid is a `pg-grid` TileSprite covering the level only, at DEPTH 5, which is under the tiles. Each cell has a 1 px line on its top and left edges in `rgba(20,40,70,0.11)`. Lines therefore scale with zoom, to about 2 px at 2x. The old grid was black dotted lines across the whole view plus a red edge rectangle (`editorScene.ts:1052-1080` in the old repo).
- **Background images:** `public/phaserAssets/background/{bg,far,buildings,foreground}.png` exist in both repos and are loaded by **neither** app. The old `gameScene.ts` parallax is commented out and never loaded.
  - The old look's sky, cloud scallops and water bands come from a different source: the `Background_Layer` tile layer of `pewterPlatformerDefaultMap.json`.
  - That layer uses Brackeys strip frames 9-13 (gids 10-14) and the 32x16 `pewterPlatformerTilesetBackgroundExtras.png` (gids 16-17).
  - Per row (first column): rows 0-2 frame 9, row 3 frame 10, rows 4-9 frame 11, row 10 frame 12, rows 11-14 frame 13, row 15 extras gid 17, rows 16-19 extras gid 16.
  - The new app draws none of this. Frames 9-13 are not in `pg-tiles`, and `DEPTH.background` (0) is free for a render-only decoration layer that must stay out of the LevelModel.
- The gaps at tile corners show the sky, because Brackeys tiles have transparent corners. In the old app the background layer shows through instead.

### 3.4 Default new level (`newLevel.ts`)
- The level is 200x20 with the start at (2, 14) (`LevelModel.ts:52`).
- There is a 12-column start platform at x 0-11 and a 12-column goal platform at x 188-199. Each has grass at y = 15 and dirt at y 16-19.
- The goal flag entity is at (196, 14).
- Template cells have author NONE, and x 12-187 is empty sky.
- The old default map is a full-width ground across all 200 columns (grass row 15, dirt rows 16-19) on top of the background layer.
- Keep the starter as it is:
  - `newLevel.test.ts:16-18` asserts the flag at `LEVEL_W - 4` and an empty middle.
  - `condition-none.spec.ts:24` relies on the gap ("Unbeatable on purpose").
  - The ghost fixtures are recorded against this level.
- The green pennant visible near the start in the screenshots is the **start marker**, not the goal flag.

### 3.5 Tileset and frames
The tile frame size is **16 px**.

`pg-tiles` is a 256x16 composite canvas texture. For terrain, the frame index equals the TileId:

| Frame | Item | Source |
| --- | --- | --- |
| 1 | Block | Kenney (6,0); the Brackeys "Block 1" frame is blank |
| 2 | Coin | Brackeys frame 1 |
| 3 | Fruit | Brackeys frame 2 |
| 4 | Grass half | Brackeys frame 3 |
| 5 | Dirt | Brackeys frame 4 |
| 6 | Grass | Brackeys frame 5 |
| 7 | Question | Brackeys frame 6 |
| 8 | Ultra slime | Brackeys frame 7 |
| 9 | Slime | Brackeys frame 8 |
| 10 | Flag | Kenney (11,5) |
| 11 | Sign | Kenney (6,4) |
| 12 | Knight | Brackeys frame 14 |
| 13 | Start | drawn in code |

Kenney frames are 18 px, resampled to 16 px. The palette swatches show the same texture through CSS at 32 px.

---

## 4. What the tests depend on

Sources: `tests/e2e/support/*.ts`, `tests/e2e/specs/*.ts`, the `apps/editor/src/**/__e2e__/*.cjs` scripts (`bootCheck`; `loopCheck` and `ghostCheck`, which CI runs) and the unit `*.test.ts` files. Rename any of these only together with its tests.

### 4.1 DOM selectors

| Selector | Used at |
| --- | --- |
| `canvas` | `tests/e2e/specs/smoke.spec.ts:12` |
| `#pg-stage canvas` (must be over 300x200) | `apps/editor/src/editor/__e2e__/bootCheck.cjs:60` |
| `[data-item="${item}"]` (`Editor.pick`) | `tests/e2e/support/editor.ts:199`. Through `pick()`: `grass` at `condition-none.spec.ts:15`, `ghost-keys.spec.ts:39`, `latency.spec.ts:66,111,146`, `painting.spec.ts:21,91`, `patrol-fix.spec.ts:23,65`, `saveload.spec.ts:37`; `dirt` at `painting.spec.ts:41,94`, `saveload.spec.ts:64,121`; `block` at `painting.spec.ts:66`, `saveload.spec.ts:39`; `coin` at `saveload.spec.ts:41` |
| `[data-item="grass"]` | `smoke.spec.ts:14` (must be visible right after boot), `loopCheck.cjs:186`, `bootCheck.cjs:87,143`, `ghostCheck.cjs:260` |
| `[data-item="dirt"]` | `painting.spec.ts:69`, `bootCheck.cjs:102` |
| `[data-item="block"]` | `painting.spec.ts:70` |
| `[data-item="coin"]` (bounding box; a stroke is dragged across it) | `painting.spec.ts:79`, `bootCheck.cjs:120`; clicked at `bootCheck.cjs:160` |
| `[data-mode="paint"]` | `painting.spec.ts:54,74` |
| `[data-mode="select"]` | `painting.spec.ts:59` |
| `[data-cmd="undo"]` (must become `disabled` when there is nothing to undo) | `painting.spec.ts:107,109,111` |
| `[data-cmd="redo"]` | `painting.spec.ts:112,113` |
| `[data-cmd="save"]` (visible at boot; click triggers a download) | `smoke.spec.ts:13`, `saveload.spec.ts:57`, `bootCheck.cjs:241` |
| `[data-cmd="load"]` (click opens a file chooser) | `saveload.spec.ts:70,79,103` |
| `[data-cmd="share"]` | `saveload.spec.ts:114,125,136`, `bootCheck.cjs:246` |
| `[data-cmd="help"]` | `painting.spec.ts:71`, `bootCheck.cjs:192` |
| `[data-cmd="settings"]` | `bootCheck.cjs:235` |
| `[data-cmd="play"]` (focusable; Tab must not move focus off it while a ghost shows; read back through `activeElement.getAttribute("data-cmd")`) | `ghostCheck.cjs:216,217,219` |
| `input[data-setting="gravityScale"]` (`.fill("1.25")`) | `bootCheck.cjs:236` |
| `#pg-help` (visible after Help; innerText must match `/Tab/` and `/Ctrl \+ Space/`; Escape closes it) | `painting.spec.ts:72`, `bootCheck.cjs:193,194,195` |
| `#pg-share-out` (textarea; `.value` starts with `pg1.`) | `saveload.spec.ts:115,116`, `bootCheck.cjs:247` |
| `#pg-share-in` (textarea, `.fill()`) | `saveload.spec.ts:126,137` |
| `getByRole("button", { name: "Open this level" })` | `saveload.spec.ts:127,138` |
| `#pg-share .pg-share-status.pg-error` | `saveload.spec.ts:139` |
| `.pg-toast` filtered by `hasText` "Loaded", "converted from an old Pewter save" or "Opened the shared level" | `saveload.spec.ts:72,81,128` |
| `.pg-toast-error` | `saveload.spec.ts:105` |
| `#ghost-status` (visible in llm sessions; innerText never names the filler; in `none` it must not match `/ghost\|asked\|stub\|llm\|algo\|none/i`) | `smoke.spec.ts:15,27`, `condition-none.spec.ts:38`, `loopCheck.cjs:136`, `ghostCheck.cjs:172,209` |
| `#ghost-status #pg-ghost-strip` (visible) | `ghostCheck.cjs:173` |
| `#pg-ghost-dev` (visible with `?dev=1`) | `ghostCheck.cjs:174` |
| `.pg-ghost-caption` (visible while a ghost shows) | `ghostCheck.cjs:205` |
| `.pg-ghost-arrow` (visible for an off-screen Extend ghost, gone after Esc) | `ghostCheck.cjs:333,337` |
| localStorage `pewter-ghost:autosave` (v2 JSON) | `bootCheck.cjs:188` (key defined at `ui/saveTask.ts:11`; also `pewter-ghost:task-save` `:12`, `pewter-ghost:hint` `main.ts:356`) |

### 4.2 Keys the tests press
- `1`, `2` and `3` switch modes: `painting.spec.ts:34,48,61`, `saveload.spec.ts:66`, `bootCheck.cjs:101,136,165`, `ghostCheck.cjs:273`.
- `p` starts and stops Play; `q` and `Escape` stop it: `bootCheck.cjs:171,181,208,214,226`, `ghostCheck.cjs:357,364`.
- `r` shows the route in Play: `ghostCheck.cjs:361`.
- `Tab` accepts a ghost, `Escape` dismisses it or closes a dialog, and `Control+Space` asks for a suggestion: `ghost-keys.spec.ts:76,100,116,126-129`, `patrol-fix.spec.ts:55,86`, `condition-none.spec.ts:26`, `painting.spec.ts:73`, `saveload.spec.ts:118,140`, `ghostCheck.cjs:218,250,280-285,307,335`.
- `Control+z`, `Control+Shift+z` and `Control+y` undo and redo: `painting.spec.ts:99-104`, `ghost-keys.spec.ts:89`, `patrol-fix.spec.ts:96`, `bootCheck.cjs:112-116,157`, `ghostCheck.cjs:238,310`.

Any new chrome must not take these keys, steal focus into a text field, or swallow Tab or Escape. A tab panel that uses Tab or Escape for its own navigation would break the ghost keys.

### 4.3 Visible text the tests read

**Toasts** are matched by substring:

| Text | Source | Read at |
| --- | --- | --- |
| "Loaded …" | `main.ts:218` → `:113` | `saveload.spec.ts:72` |
| "(converted from an old Pewter save)" | `main.ts:106` | `saveload.spec.ts:81` |
| "Opened the shared level" | `main.ts:228` | `saveload.spec.ts:128` |
| Error toast "… failed: …" | `main.ts:102` | `saveload.spec.ts:105` |

**Status strip** (`ghost/caption.ts`):

| Text | Read at |
| --- | --- |
| "quiet · Ctrl+Space to ask" | `smoke.spec.ts:25`, `ghost-keys.spec.ts:105,130`, `ghostCheck.cjs:172,286` |
| `/^ghost: staircase up to a ledge/` | `ghost-keys.spec.ts:71` |
| "Ghost thinks: climbing" | `ghost-keys.spec.ts:72` |
| "Ghost thinks: parkour" | `ghostCheck.cjs:208` |
| `/^asked/` | `ghost-keys.spec.ts:128`, `ghostCheck.cjs:284` |
| `/6 of 7 left/` | `ghost-keys.spec.ts:146` |
| `/3 of 4 left/` | `ghostCheck.cjs:267` |
| `/Tab keeps them/` | `ghostCheck.cjs:207,259` |
| "ghost: pillar · Tab to accept · Esc to dismiss" | `ghostCheck.cjs:278` |

These are read through `window.__pewter.ghost.strip()`, which returns `StatusStrip.text`, not the DOM. Even so, the DOM and the text must stay the same: §8 of the plan requires that everything the ghost says is also in the strip.

**Canvas caption:** "staircase · Tab" (`ghostCheck.cjs:204`) and "pillar" (`:279`).

**Help dialog:** must contain "Tab" and "Ctrl + Space" (`bootCheck.cjs:195`).

**Unit tests that pin UI words** (vitest, node environment, no DOM):
- `ghost/caption.test.ts:16-18,38-40,46-57,61-65,73`: caption and strip strings.
- `editor/modes.test.ts:62-64`: `describeMode` returns "Paint · grass", "Erase" and "Pan (Space)".
- `ui/paletteItems.test.ts:9-27`: item ids, groups, `brushLabel` "grass", and `activeItemId` mapping erase to "eraser".
- `ghost/devOverlay.test.ts:9-34`: dev overlay lines.
- `editor/newLevel.test.ts:9-27`: the starter level.

### 4.4 `window.__pewter` hooks
`window.__pewter` is set at `main.ts:158`. `api` is added on editor-ready (`main.ts:319`) and `ghost` in `ghost/session.ts:438`. **Do not rename any part of this object.**

| Hook | Used at |
| --- | --- |
| `__pewter.api` / `.app` / `.ghost` present (the ready check) | `tests/e2e/support/editor.ts:96`, `loopCheck.cjs:125`, `bootCheck.cjs:57`, `ghostCheck.cjs:141,148,150` |
| `app.ready` (promise) | `editor.ts:98`, `loopCheck.cjs:128` |
| `app.loop.setSuspended` | `editor.ts:89` |
| `app.loop.activeFiller` | `smoke.spec.ts:19,47`, `condition-none.spec.ts:13` |
| `app.session.fromProxy` and `.sessionId` | `smoke.spec.ts:19,47` |
| `app.eventLog.events()` | `editor.ts:210`, `loopCheck.cjs:184,200` |
| `app.flushLog()` | `smoke.spec.ts:35` |
| `config` | `latency.spec.ts:45` |
| `model.tileAt`, `.authorAt`, `.snapshot`, `.undoDepth`, `.provenanceAt`, `.entities`, `.entitiesAt`, `.start` | `editor.ts:105,109,114,118`, `saveload.spec.ts:24`, `ghost-keys.spec.ts:83`, `loopCheck.cjs:138-139`, `bootCheck.cjs:75,98,163,178,200-206,221`, `ghostCheck.cjs:155-156,225,230,235,240,289,311` |
| `modes.mode` | `editor.ts:203`, `loopCheck.cjs:200`, `bootCheck.cjs:88,137` |
| `settings.get()` | `bootCheck.cjs:238` |
| `scene.camera.home(model.start)` | `editor.ts:126`, `loopCheck.cjs:185`, `bootCheck.cjs:156`, `ghostCheck.cjs:170` |
| `scene.camera.centerPx` | `bootCheck.cjs:147,150,154` |
| `scene.play.knightSprite`, `scene.play.stats` | `bootCheck.cjs:177,212` |
| `api.camera.tileToScreen` / `.viewTiles` / `.screenToTile` / `.nudgeTo` | `editor.ts:137,151`, `loopCheck.cjs:143,156,171,200`, `bootCheck.cjs:66-76,148`, `ghostCheck.cjs:163,317,328` |
| `api.game.canvas.getBoundingClientRect()`, `api.game.scale.width` and `.height` (tile-to-page mapping) | `editor.ts:137-138,152-153`, `bootCheck.cjs:68-70`, `loopCheck.cjs:143-171` |
| `api.isPlaying()`, `api.on("play:end")` | `bootCheck.cjs:173,183,204,232`, `ghostCheck.cjs:359,366` |
| `ghost.show`, `.current`, `.layer`, `.strip`, `.route`, `.history`, `.accept`, `.dismiss`, `.request` | `editor.ts:223,244,248,254,258`, `loopCheck.cjs:203-249,296`, `ghostCheck.cjs:157-159,231-367` |

### 4.5 Geometry the tests assume
Tests click and drag on tiles at the e2e viewport of **1366x768** (`playwright.config.ts:64,74`; the browser checks use the same) after `camera.home(model.start)`. The pointer binding paints only when `document.elementFromPoint(x, y) === canvas` (`editor/pointer.ts:84-90`). So **every tile below must be on uncovered canvas** at 1366x768:

| Tiles | Spec |
| --- | --- |
| x 12-31, y 14-15 | `condition-none:16-25`, `patrol-fix:25` (row 15, x 26-31), `latency` (12-14, 12-14) |
| x 14-26, y 6-12 | `painting` (x 14-21, rows 7-12), `saveload` (x 14-26, rows 6-12) |
| (26, 6) | `ghost-keys.spec.ts:149` |
| (30, 6) and (21, 12) | `ghostCheck.cjs:261,268` |
| x 12-22, y 8-15 | `patrol-fix:67`, the ghost-keys FINISH cells |
| `view.x + 6 .. +16`, rows 8-13 | `bootCheck.cjs:77-79` (`view.w > 14` required) |

The rightmost column needed is **x = 31**. With the camera as it is (left edge at -3 tiles), the uncovered canvas must be at least `552 × zoom` CSS px wide from its left edge, where `zoom = clamp(canvasHeight/368, 1, 4)`. Roughly, uncovered width must be at least 1.5 × canvas height.

Today, human-only sessions have only 1 column to spare (32 visible) because of the sizing bug, and llm/stub sessions have 5 (36).

An old-style panel floating over the right of the canvas would cover columns 27 and up. A 340 px panel on a 1280x720 canvas leaves about 925 px uncovered, which reaches column 26 at zoom 1.96. That breaks `condition-none`, `patrol-fix` and `ghostCheck`. Options:
- put the panel beside the canvas instead of over it;
- or change `home()` and the hard-coded coordinates in the specs together.

The toasts (`pointer-events: auto`, bottom-right of the stage) also block painting under them. The first-run hint toast is up for 8 s at the start of every e2e run, because storage is cleared. Today it sits below row 15 at 1366x768; a restyle must keep it off rows 6-15 in columns 12-31, or make it non-blocking.

`viewTiles()`, the edge arrow and the Extend `nudgeTo` all assume the whole Phaser canvas is visible. Chrome drawn over the canvas makes the ghost think covered tiles are on screen.

### 4.6 Conflict with OLD_LOOK.md §12 (fixed 1280x720, zoom 2.25, 340 px panel over the canvas)

Here is that layout at the e2e viewport of 1366x768:
- The canvas sits at (43, ~36). That fits, since the label (23.5 px) plus 720 px is 743.5 px.
- Each tile is 36 px.
- The panel at canvas x 925-1265 leaves 925 px of uncovered canvas.
  - With the old camera (view starts at column 0), columns 0-25 are clickable: column 25's centre is at 918 px.
  - With today's `home()` (left edge at column -3), only columns up to 22 are clickable.

These test steps would then land on the panel instead of the canvas. A drag stops, and a click is eaten:

| Test step | Tiles |
| --- | --- |
| `condition-none.spec.ts:25` | drag x 26-31, y 15 |
| `patrol-fix.spec.ts:25` | drag x 26-31, y 15 (the recorded patrol fixture depends on this level) |
| `ghost-keys.spec.ts:149` | click (26, 6), "painting elsewhere dismisses" |
| `saveload.spec.ts:65` and `:122` | drag x 24-26, rows 8 and 6 |
| `ghostCheck.cjs:268` | click (30, 6) |

Also, the ghost-keys FINISH cells (x 15-21) and the patrol Fix cells must stay out from under the panel, or people will not see the ghost.

There are three ways to make the old layout and the tests agree. Each is a deliberate choice:
- (a) Move those hard-coded columns left, to x 20 or less, in the same commit as the restyle. Re-check `patrol-fix`: its fixture must still replay onto an unbeatable level.
- (b) Make the panel not cover the level. For example, set `cameras.main.setViewport(0, 0, 925, 720)` so the camera, `viewTiles` and the edge arrow all agree with what is visible. Then also shift `home()` so it shows columns 7-31, or the test points still fail.
- (c) Lower the zoom so 32 or more columns fit in 925 px. That needs zoom 1.8 or less, which breaks "20 rows exactly fill the canvas".

In every case the old minimap at canvas (10,10) collides with the mode pill and the dev overlay (§6.4). The bottom toolbar covers only rows 18-19, which no test uses.

---

## 5. Features the new UI has that the old did not

Each of these must survive the restyle. "Old home" suggests where it fits in the old layout: dark page, title label, fixed canvas, right panel with tabs, bottom floating toolbar and minimap.

| Feature | Where it is now | Old home |
| --- | --- | --- |
| **Tool modes** Select, Paint, Erase, Pan on keys 1-4, with the active one always visible (G-04). The radio group uses `data-mode`, `.pg-active` and `.pg-temp` for Space-pan. | Toolbar, left | Bottom floating toolbar, in the gap after "▶ Play" where "✕ Deselect" was (the selection box is gone). Use the old `.pt-tbtn` pill style with a highlighted active state. |
| **In-canvas mode pill** ("Select", "Paint · grass", "Pan (Space)") | UIScene at (10,10) | Same corner, unless the minimap returns there. Then move the pill under the minimap or to the top-right. |
| **Undo and Redo buttons** (the old app only had Ctrl+Z/Y in its Controls tab). They need `data-cmd` and must disable when empty. | Toolbar | Bottom toolbar, next to the modes |
| **Play / Stop toggle**, red "■ Stop" in Play | Toolbar `data-cmd=play` | The old green "▶ Play" at the bottom-left of the toolbar, with a red Stop state |
| **Save task**: download a v2 file, keep a copy, toast with "Reload from save" | Toolbar, primary | The old green "💾 Save" slot; the label may stay "Save task" |
| **Reload** from the last Save task, with a confirm dialog | Toolbar | The old orange "↺ Save & Reload" slot. The meaning is different: it no longer saves first. |
| **Load…** (v2 file, or a v1 old-Pewter save, which is converted) | Toolbar | The old blue "📂 Load" slot |
| **Share code**: a `pg1.` code dialog to copy or open a level | Toolbar to `#pg-share` | Bottom toolbar after Load, or a panel tab. The dialog id and fields must keep their names. |
| **Settings**: play settings dialog with four sliders | Toolbar, right | A panel tab or toolbar button; keep `data-cmd=settings` and `data-setting` |
| **Help**: Keys dialog `#pg-help` | Toolbar, right | It replaces the old "Controls" tab's content. `[data-cmd=help]` must open `#pg-help`, and Escape must close it. |
| **Palette**: Block, Goal flag, Sign (with text field), Start, labelled Eraser; labels under swatches | Left sidebar | The old "Blocks" tab in the right panel (icon tiles in dark rounded squares, groups Collectables / Blocks / Enemies, Eraser on top). It must be **visible by default** with no tab click, because `smoke.spec.ts:14` and every `pick()` click `[data-item]` directly. Add Markers (Goal flag, Sign, Start). The panel must not cover the canvas (§4.5). |
| **Start marker** (green pennant, drawn in code) and **goal flag** at 60% (Kenney); **sign** sprite | Canvas | Same; the old app had no markers |
| **Enemy patrol marks** (dashed span; red cross when there is no floor) | Canvas | Same |
| **Ghost layer**: faint tiles, dashed outline, crossed removals, caption, edge arrow, route overlay | Canvas plus `.pg-ghost-overlay` | Same. These are fixed by the plan's accessibility rules (dashed vs crossed, not colour alone), so restyle the caption and arrow pills only to match the old dark panel style. |
| **Ghost status strip** `#ghost-status` (main text plus "Ghost thinks: …") | A full-width line under the toolbar | Where the old chat log sat: the top of the right panel under the tabs, or a single line in the title-label row above the canvas. It must stay a live region, be visible in llm sessions, and be empty and hidden in `none`. |
| **Dev overlay** (`?dev=1`) | Stage top-left, z 6 (it overlaps the mode pill) | Top-left is the old minimap's spot. Move one of them if the minimap comes back. |
| **Toasts** (load, save, warnings, Play "Goal! …", restored-session, first-run hint) | Stage bottom-right | The old app spoke through chat bubbles. Toasts could take that look (dark rounded card, Space Grotesk) at the top of the panel, or stay in a canvas corner clear of rows 6-15 (§4.5). The hint text says "Pick a block **on the left**" (`main.ts:349`); update it if the palette moves. |
| **Dialogs** (Help, Share, Settings, Reload confirm) | Light modal cards | Restyle as dark cards like the old `.pt-chatbox` panel. Keep `role=dialog`, the ids, Escape-to-close, and `isDialogOpen` gating. |
| **Play HUD** (hearts, coins x/y, deaths, timer, "Esc / Q to stop", "no goal flag yet"), **sign bubble** | UIScene pills | The old Play showed "Coins: 0" in yellow and "HP: 3" in red with a black stroke at the top-left. The HUD could take that styling. |
| **Hover coordinates** and the **Select-mode inspector** ("(x, y) grass · placed by you") | UIScene, bottom-left | Same corner (old bottom-left is under the floating Play button, so lift it) |
| **Cursor rect per mode** and the **brush preview** | Canvas | Same |
| **Space-drag / two-finger pan, pinch zoom, WASD and arrows, `+` and `-`, Ctrl+0** | Input | Same. The old app panned with WASD and a fixed zoom range. |
| **Autosave** and the "Restored your level…" toast with "Start a new level" | `main.ts:334-347` | Same |
| **Route on R in Play**, and on accept | Canvas | Same. Note that old `R` meant "deselect" and old `P` meant "Z-level up". The new key meanings win. |

The old look has things the new one lacks. They are listed here as context for whoever restyles. The old-app inventory itself is in `docs/look/reference/`.
- The dark page `#08080f` and Space Grotesk.
- The "PEWTER PLATFORMER" label above the canvas.
- The fixed 1280x720 centred canvas.
- The background tile layer: sky, cloud scallops and water bands.
- The black dotted grid.
- The minimap with its red view rectangle.
- The right panel with tabs.
- The floating bottom toolbar with coloured buttons.

Chat, Deselect and the selection box were removed on purpose (plan §G-04, §G-19) and must not come back.

---

## 6. Defects in the current UI (found while taking the screenshots)
1. **The canvas overflows the stage in human-only sessions** (§3.1): the right 172 px and bottom 48 px are clipped, and at 1440x900 columns 29 and up are hidden.
2. **The mode pill and hover pill are blank at boot.** `EditorScene.create()` emits `pg:mode` before `UIScene.create()` subscribes (`EditorScene.ts:144-146`), so the indicator is an empty dark box until the first mode change. The hover pill (`UIScene.ts:32`) is also visible but empty at the bottom-left. Both show as small dark rectangles in `new-1440.png` and `new-ghost-1440.png`.
3. The first-run hint says "Grey tiles are suggestions", but ghost tiles are faint copies of the real tiles, not grey.
4. With `?dev=1` the dev overlay (stage 8,8) covers the mode pill (canvas 10,10).

---

## 7. Restyle constraints checklist
- Keep every id, class, `data-*` attribute, label and text in §4, and the whole `window.__pewter` shape. If one must change, change its spec, `support/editor.ts` and the `__e2e__/*.cjs` scripts in the same commit.
- Chrome must be plain DOM outside the canvas, or DOM over it. Never draw chrome inside Phaser, because clicks would then reach the canvas. The painting spec asserts that clicking the palette, the toolbar and Help changes nothing, and that a stroke dragged over `[data-item=coin]` stops for good (`painting.spec.ts:65-88`, `bootCheck.cjs:118-128`).
- Keep the tiles in §4.5 uncovered at 1366x768. A right panel over the canvas breaks e2e unless coordinates and the camera change together; §4.6 gives the exact numbers for OLD_LOOK's 1280x720 layout and three ways to resolve them. Make sure Phaser's game size equals the visible canvas: fix §3.1 or size the canvas explicitly.
- Keyboard: no new key bindings on 1-4, P, Q, R, H, ?, F1, +, -, Tab, Escape, Space, Ctrl+Space, Ctrl+Z, Ctrl+Y, Ctrl+S, Ctrl+0, WASD or the arrow keys. Toolbar buttons must stay `<button>`s that never keep Tab (`ghostCheck.cjs:216-220`).
- The status strip and ghost styles inject their own CSS (`StatusStrip.ts:17`, `ghost/styles.ts:7`). Either restyle there or override from `style.css`. Do not remove the `#ghost-status:empty { display: none }` behaviour, because `condition-none` must show nothing.
- **Fonts:** the old app loads Space Grotesk from fonts.googleapis.com.
  - e2e and the CI checks fail on any console error; `realErrors` only filters favicon errors (`support/editor.ts:47`).
  - A blocked font request can log a resource error, so self-host the woff2 under `apps/editor/public/` (OFL licence) or keep a system-font fallback with no network dependency.
  - No local copy exists in either repo or on this machine.
- Plan requirements:
  - "Works at 1366×768 and on a trackpad" (PLAN.md:427).
  - "Everything the ghost says is also in the status strip" (:431).
  - "Ghost and removal marks don't rely on colour alone" (:433).
  - "The palette is the one people know" (:359).
- Keep the `starterSnapshot()` semantics (§3.4), `TILE_PX = 16`, the frame map and `DEPTH`. Any old-style background layer is render-only, at `DEPTH.background`, and never written into the LevelModel or saves.

---

## 8. Baseline
- `npx vitest run`: 89 files, 1328 tests, all pass.
- `npx tsc --noEmit -p .`: clean.
- `npx playwright test -c tests/e2e/playwright.config.ts`: 30 tests, **all pass on a quiet tree**.
  - The first full run gave 27 passed and 3 failed: `smoke` and `saveload` with "Execution context was destroyed, most likely because of a navigation", and `patrol-fix` with "Cannot read properties of undefined (reading 'ghost')". All three happened because a parallel commit (`bccdd3c`) edited `apps/editor/src/session.ts` and `suggest/config.ts` during the run, and Vite full-reloaded the page.
  - Re-running `smoke`, `saveload` and `patrol-fix` afterwards: 8 of 8 pass.
  - Do not edit files under `apps/editor/` while e2e or the `__e2e__` checks are running.
- Running the e2e suite: about 3.2 minutes, one worker, Chromium 1194 from `/opt/pw-browsers`. It starts its own Vite on a free port.
