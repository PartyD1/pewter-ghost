# Pewter Platformer: the old look, itemized

This is the reference for restyling Pewter Ghost so it looks like Pewter Platformer. Every value comes from the old source
(`/home/user/pewter-platfomer`, commit `47b7a93`, files under `src/`) or was measured from the running old app
(`http://localhost:5301/Pewter-The-Platformer/`) with Playwright Chromium at device pixel ratio 1.
Reference screenshots are in [`reference/`](reference/).

Pewter Ghost replaces the old chat AI that worked through selection boxes with ghost autofill. Everything else should match what is listed here.

> **About fonts in the screenshots.** Chromium in this sandbox cannot reach Google Fonts directly. To get the real font, the
> Google Fonts CSS and the Space Grotesk `.woff2` files (the same URL the app requests) were downloaded with `curl` and served to the page
> with Playwright request routing. The old app itself was not changed. The screenshots therefore show Space Grotesk as real users see
> it. Monospace text (`JetBrains Mono`/`Fira Code`/`Consolas`) is never loaded by the app, so it falls back to the OS monospace font
> (DejaVu Sans Mono in these shots). Emoji use the OS emoji font (Noto Color Emoji here).

---

## 0. The look in 15 points (checklist)

1. A near-black page `#08080f`. A **fixed 1280×720 canvas** is centred on it, with no border, radius or shadow, and it **never scales**.
2. A small label, **"PEWTER PLATFORMER"**, sits above the canvas's top-left: Space Grotesk 13px/500, uppercase, letter-spacing 0.15em, `rgba(255,255,255,.45)`.
3. Pixel art at **camera zoom 2.25**, which makes one 16px tile 36 screen px. The 20-row map exactly fills the 720px height.
4. The background is **bands of flat tiles, with no parallax**. From the top: white, a cloud edge, light blue `#1498dc`, a wave edge, dark blue `#1950c0`, then a grass row and 4 dirt rows.
5. A **dotted black grid** every 16 world px. Each dash is 0.4×1.2 world px, repeated every 4 px (about 1×3 screen px every 9 px).
6. A **red line about 2px high along the bottom edge of the canvas**. It is the bottom of the grid's red edge rectangle, drawn with `0xf00000` at width 2.
7. A **minimap** at canvas (10,10), 480×48, with no frame. It shows the whole map at zoom 0.15, with a faint red rectangle marking the main view.
8. A **floating right panel**, 340×700, at canvas (925,10). It is dark and translucent (`rgba(6,6,16,.78)`) but **not blurred**, with radius 14 and a heavy shadow.
9. The panel header shows **"✦ pewter"** in lavender `#c4aaff` with a violet glow. Small inline tabs **Chat / Blocks / Controls** sit at the right, and the active tab is a violet pill.
10. A **bottom toolbar of floating pill buttons** with no bar background. Their bottoms line up with the panel's bottom (canvas y 710). **▶ Play** (green) is on the left; **✕ Deselect** (neutral), **💾 Save** (green), **📂 Load** (blue) and **↺ Save & Reload** (orange) are on the right.
11. Toolbar buttons are 36px tall with 10px radius and semi-opaque coloured fills. They have a 1px tinted border and a deep drop shadow, and lift 2px on hover.
12. The Blocks tab shows **sprite-icon buttons** (46×35, dark `#111122`) under tiny uppercase section headings. Above them sit red-tinted **Eraser 🗑️ / Empty** text buttons.
13. The Controls tab is a list of **monospace key chips** (`#18182e`), each with a right-aligned description.
14. Hovering a tile fills it **red at 50% alpha with a 2px red outline** (the Z-level 1 colour). Selection boxes use the same Z-level colours with a 30% fill and a small "Box" tab above them.
15. In Play mode, the panel, toolbar, minimap, grid and red line disappear. Small **glass HUD pills** appear: hearts and coins at top-left, plus `B 👁️ OFF` and `Q Exit` at top-right.

---

## 1. Screenshot index (`docs/look/reference/`)

| File | What it shows |
|---|---|
| `01-default-1440x900.png` | Default editor view at 1440×900, Chat tab, nothing selected |
| `01a-chat-tab-panel-crop.png` | Right panel, Chat tab, welcome bubble |
| `01b-title-label-crop.png` | "PEWTER PLATFORMER" label above the canvas |
| `01c-minimap-crop.png`, `01d-minimap-crop-zoom-source.png` | Minimap (top-left of canvas) |
| `01e-canvas-bottom-edge-crop.png` | Bottom of canvas: toolbar and red bottom line |
| `01f-toolbar-crop.png` | Toolbar at rest |
| `01g-canvas-top-left-grid-crop.png` | Dotted grid over white and light-blue sky |
| `02-default-1920x1080.png` | Default view at 1920×1080 (canvas does not grow) |
| `02b-default-1280x720-no-scaling.png` | 1280×720 viewport: no scaling, toolbar cut off, page scrolls |
| `02a-chat-input-focused-no-box-warning.png` | Input focused (violet ring) and amber "select a region" temp message |
| `03-tab-blocks-1440x900.png`, `03a-tab-blocks-panel-crop.png` | Blocks tab |
| `03b-blocks-hover-grass.png` | Hover state of a block button (Grass Block) |
| `04-tab-controls-1440x900.png`, `04a-tab-controls-panel-crop.png` | Controls tab |
| `04b-tab-hover-inactive.png` | Hover on an inactive tab (note the green border quirk, §9) |
| `05-block-selected-painting-1440x900.png` | Grass Block selected, mid-stroke painting, red hover highlight |
| `05a-blocks-placed-all-kinds-1440x900.png` | Every palette item placed (coins, fruit, ? block, grass-half, both slimes) |
| `05b-blocks-panel-selected-state.png` | Selected block button (violet, with focus ring) |
| `06-hover-play.png` … `06-hover-reload.png` | Hover state of each toolbar button |
| `07-selection-box-active-1440x900.png`, `07a-selection-box-dragging.png`, `07b-selection-box-chat-tab.png` | Right-drag selection box: red Z1 fill, dashed border, green "Box[…]" tab |
| `08-play-mode-1440x900.png`, `08c-play-mode-running-jump.png`, `08e-play-mode-1920x1080.png` | Play mode: knight, slimes, pellets, HUD |
| `08a-play-hud-left-crop.png`, `08b-play-hud-right-crop.png`, `08d-play-hint-hover.png` | Play HUD pills (and hover) |
| `09-ui-hidden-U-key-1440x900.png` | After pressing **U**: panel, toolbar and minimap hidden |
| `10-chat-bubbles-sample-injected-dom.png` | Bubble styles: user, AI with markdown, typing indicator. *Sample text was injected into `#chat-log` with the app's own classes for illustration; no model call.* |
| `11-zoomed-in-wheel-3.25x.png` | After 10 wheel notches (zoom 3.25): grid and tiles scale, red bottom line out of view |

---

## 2. Page and frame

### 2.1 Document
`index.html`:
- `<title>Pewter Platformer</title>` (line 7). Favicon `/favicon.png` (24×24 PNG) (line 5).
- Fonts: `preconnect` to `fonts.googleapis.com` and `fonts.gstatic.com`, then a stylesheet
  `https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap` (lines 8-13).
- DOM (lines 15-24):
  ```html
  <div id="app">
    <div class="container">
      <div id="emoji" class="emoji-container"><p class="app-title">Pewter Platformer</p></div>
      <div class="content-container"><div id="phaser"></div></div>
    </div>
  </div>
  ```

### 2.2 Global CSS (`src/style.css`)
| Rule (line) | Values |
|---|---|
| `:root` (1-16) | `font-family: "Space Grotesk", system-ui, -apple-system, sans-serif; line-height: 1.5; font-weight: 400; color-scheme: dark; color: #e2e8f0; background-color: #08080f; font-synthesis: none; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale` |
| `body` (18-27) | `margin: 0; display: flex; justify-content: center; align-items: center; min-width: 320px; min-height: 100vh; background-color: #08080f; position: relative` |
| `.container` (29-35) | `display: flex; flex-direction: column; align-items: center; width: 100%; gap: 0` |
| `.emoji-container` (37-45) | `display: flex; justify-content: flex-start; padding: 0 0 4px 4px; width: 1280px; max-width: 100%; text-align: left; box-sizing: border-box` |
| `.app-title` (47-56) | `font-family: "Space Grotesk", sans-serif; font-size: 13px; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase; color: rgba(255,255,255,0.45); margin: 0; user-select: none` |
| `.content-container` (58-63) | `display: flex; flex-direction: row; justify-content: center; gap: 1rem` |
| `#phaser` (65-67) | `margin: 0` |
| `button` (69-79) | `border-radius: 8px; border: 1px solid transparent; padding: .6em 1.2em; font-size: 1em; font-weight: 500; font-family: inherit; background-color: #1a1a1a; cursor: pointer; transition: border-color .25s` |
| `button:hover` (81-83) | `border-color: #127803`. This **leaks** onto inactive panel tabs (§9). |
| `button:focus, button:focus-visible` (85-88) | `outline: 4px auto -webkit-focus-ring-color`. Gives a focus ring on clicked block and toolbar buttons (§9). |
| `#llm-chat`, `#chat-history`, `#llm-chat-form…` (90-124) | Legacy and unused. Do not reproduce. |

### 2.3 The "PEWTER PLATFORMER" label
- The source text is "Pewter Platformer" and it is shown uppercase. Space Grotesk 13px, weight 500, letter-spacing 0.15em (1.95px), `rgba(255,255,255,0.45)`, line-height 19.5px (1.5 from `:root`).
- Position: the wrapper is 1280px wide with `padding: 0 0 4px 4px`. The text starts **4px right of the canvas's left edge**, and its 19.5px line box ends **4px above the canvas top**.
- Measured at 1440×900: label box at (84, 74.75), about 166×19.5. Canvas top-left at (80, 98.25).

### 2.4 Canvas framing, centring and sizing
- The Phaser canvas is **1280×720 CSS px, with a 1280×720 backing store** and `image-rendering: pixelated` (set by `pixelArt: true`). It has **no border, radius or shadow**. The page colour `#08080f` surrounds it on all sides.
- The label and canvas are centred as one column by `body { display:flex; center; min-height:100vh }`. The canvas is an inline element, so `#phaser` is about 727px tall (a baseline gap of about 4px under the canvas). That makes the stack 23.5 + ~727px, centred vertically.
- Measured canvas positions:
  - 1440×900: (80, 98.25)
  - 1920×1080: (320, 188.25)
  - 1280×720: (0, 23.5). The document is 751px tall, so the page scrolls and the toolbar is cut off at the bottom of the viewport (`02b`).
- **Resize and scaling: none.** There is no `scale` config (`src/main.ts:66-89`), so Phaser uses `Scale.NONE`. The canvas never grows or shrinks. On bigger screens the dark margins simply get larger.
- `resolution: Math.min(devicePixelRatio, 2)` is passed (main.ts:63, 68), but Phaser 3.90 ignores it: `node_modules/phaser/src/core/Config.js` has no `resolution` key. The backing store stays 1280×720 and HiDPI screens upscale it with pixelated rendering.
- The **red bottom border line** is not CSS. It is drawn inside the canvas by the grid code; see §3.6.

---

## 3. Canvas (Phaser)

### 3.1 Game config (`src/main.ts:63-91`)
`type: Phaser.CANVAS` (the Canvas renderer, not WebGL), `render.pixelArt: true`, arcade physics (`gravity 0`, `debug: false`), `width: 1280, height: 720`,
`parent: #phaser`, `dom.createContainer: true` (DOM elements are overlaid on the canvas),
`scene: [LoadingScene, EditorScene, UIScene, GameScene]`. There is no `backgroundColor`, so it is Phaser's default black. That black is never visible
because the map always fills the view.

Phaser's DOM container is an absolutely positioned `div` of 1280×720 placed exactly over the canvas, with
`overflow:hidden; pointer-events:none; transform: scale(1,1)`. The panel, toolbar and play HUD are children of it.

`LoadingScene` (`src/phaser/loadingScene.ts:9-31`) has **no visuals**: no progress bar or logo. The canvas is black for the moment of loading. It loads:
| Key | File | Notes |
|---|---|---|
| `tileset` | `pewterPlatformerTilesetExtended.png` | 240×16, 15 frames of 16×16 |
| `extras-tileset` | `pewterPlatformerTilesetBackgroundExtras.png` | 32×16, 2 frames |
| `defaultMap` | `pewterPlatformerDefaultMap.json` | Tiled JSON |
| `spritesheet` | `pewterPlatformerTilesetExtended.png` | The same image as 16×16 spritesheet frames, used for the player and enemies |
| `pellets` | `pellets.png` | 48×16, 3 frames of 16×16 |

`EditorScene.preload` (editorScene.ts:232-248) also loads `tilemap_packed.png` as 18×18 frames (`tilemap_tiles`) and the
`platformer_characters` atlas. **Both are unused** for rendering. The look uses **16×16 frames at scale 1** (`TILE_SIZE = 16`, `SCALE = 1.0`, editorScene.ts:62-63).

### 3.2 Camera
- `minZoomLevel = 2.25`, `maxZoomLevel = 10`, `zoomLevel = 2.25` (editorScene.ts:76-78).
  2.25 = 720 / 320, so the **20-row map exactly fills the canvas height**. The view is 568.9 × 320 world px (about 35.5 columns).
- Bounds are `(0, 0, map.widthInPixels = 3200, map.heightInPixels = 320)`. The camera calls `centerOn(0,0)`, which is clamped by the bounds, so the view starts at the **map's top-left** (551-561).
- Mouse wheel: ±0.1 zoom per notch, clamped to 2.25-10 (579-604), centred on the camera.
- Panning: W/A/S/D move 10 screen px per frame ÷ zoom, ×4 with Shift (`cameraMotion`, 1026-1044). Middle-drag also pans (823-926).

### 3.3 Tileset frames (exact colours sampled from the PNGs)
| GID | Frame | Meaning (palette name) | Main colours |
|---|---|---|---|
| 1 | 0 | transparent ("Block 1") | — |
| 2 | 1 | **Coin** | gold `#fbc41b`, `#fff21b`, outline `#1b1b1b` |
| 3 | 2 | **Fruit** (green apple) | `#03991f`, `#4dbd27`, dark `#231c19` |
| 4 | 3 | **Grass-Half Block** (thin platform) | `#4dbd27`, `#95d836`, `#231d16` |
| 5 | 4 | **Dirt Block** | `#b66b3a`, `#d89e58`, `#67332d`, outline `#231c19` |
| 6 | 5 | **Grass Block** (dirt with grass top) | `#b66b3a`, `#67332d`, `#4dbd27`, `#231c19` |
| 7 | 6 | **Question Block** | `#231c19`, `#b66b3a`, `#67332d`, `#d89e58` |
| 8 | 7 | **Ultra Slime** (pink and red, purple) | `#120c0a`, `#e65f69`, `#6f2c77` |
| 9 | 8 | **Slime Enemy** (lime) | `#161320`, `#bad200`, `#6da200` |
| 10 | 9 | sky, white | `#ffffff` |
| 11 | 10 | white to light-blue cloud edge | `#ffffff` / `#1498dc` |
| 12 | 11 | sky, light blue | `#1498dc` |
| 13 | 12 | light to dark blue wave edge | `#1498dc` / `#1950c0` |
| 14 | 13 | sky, dark blue | `#1950c0` |
| 15 | 14 | **Knight (player)** | `#0e0d0e`, grey `#b3aaa1`, gold `#eba724`, red plume |
| 16 | Extras 0 | underground fill | `#231c19` |
| 17 | Extras 1 | underground top | `#231c19`, `#14462d` |

### 3.4 Default map and how it is loaded
- `this.make.tilemap({ key: "defaultMap" })` (editorScene.ts:487). Tilesets are added as
  `addTilesetImage("pewterPlatformerTilesetExtended", "tileset", 16, 16, 0, 0)` and `addTilesetImage("Extras", "extras-tileset", 16, 16, 0, 0)` (491-507).
- Layers are created in this order, which gives the draw order (509-525). All have depth 0 and scroll factor 1:
  1. `Background_Layer` (both tilesets)
  2. `Ground_Layer`
  3. `Collectables_Layer`
- The map is **200 × 20 tiles of 16 px (3200 × 320 world px)**. `pewterPlatformerDefaultMap.json` is byte-identical in both repos.
- Background_Layer, row by row:
  - rows 0-2: gid 10 (white)
  - row 3: gid 11 (cloud edge)
  - rows 4-9: gid 12 (light blue)
  - row 10: gid 13 (wave edge)
  - rows 11-14: gid 14 (dark blue)
  - row 15: gid 17
  - rows 16-19: gid 16 (dark brown, hidden by the ground)
- Ground_Layer: row 15 is all gid 6 (grass), rows 16-19 are all gid 5 (dirt), across the full 200 columns. Everything else is empty.
- Collectables_Layer is empty.
- On screen at zoom 2.25, each row is 36px tall. That gives about 108px of white, a cloud edge, 216px of light blue, a wave edge, 144px of dark blue, then 180px of ground.

### 3.5 Background and parallax
**There is no parallax and no image background in the running app.** The "sky" is the tile layer above, at scroll factor 1.
`public/phaserAssets/background/{bg,buildings,far,foreground}.png` (ansimuz, CC0) are only referenced by `GameScene`
(`src/phaser/gameScene.ts:242-267`, which is commented out). `GameScene` is never started, and LoadingScene never loads those images. Do not add parallax.

### 3.6 Grid and the red edge line (`drawGrid`, editorScene.ts:1052-1107)
The grid is redrawn **every frame** in editor mode (`update()`, line 1328) into `gridGraphics` at **depth 10** (564-566). That puts it above all tile layers and below selection boxes.
It is drawn only over the tile-snapped main-camera view:
`startX = floor(view.x/16)*16`, `endX = ceil((view.x+view.w)/16)*16`, and the same for Y.
- **Dots:** `fillStyle(0x000000, 1)`, `dotSpacing = 4`, `dotLength = 0.4`, `dotWidth = 1.2`.
  - Vertical lines at every 16 px column use `fillRect(x-0.2, y-0.2, 0.4, 1.2)` every 4 px down.
  - Horizontal lines at every 16 px row use `fillRect(x-0.2, y-0.2, 1.2, 0.4)` every 4 px across.
  - At zoom 2.25 that is about 0.9 × 2.7 screen px dashes every 9 px, every 36 px. Because the Canvas renderer anti-aliases, they read as **dark grey/black dotted lines**: about `#8c8c8c` on white and `#0b5379`/`#062d42` on `#1498dc` (`01g`).
- **Red edge rectangle:** `lineStyle(2, 0xf00000, 1)` (`edgewidth = 2`) with `strokeRect(startX-2, startY-2, endX-startX+2, endY-startY+2)`.
  - Left and top edges sit off-map at -2 and are invisible. The right edge sits just past the view.
  - The **bottom edge sits at world y = 320**, the map's bottom, which is also the bottom of the view at zoom 2.25. Half of the 2px stroke falls inside the view, so it shows as a **~2px red line along the very bottom of the canvas**. At 1440×900 it is page rows 816-817, colour about `#eb0503`.
  - This is the "red bottom border line". It disappears when you zoom in (`11`) and in Play mode, because the grid is cleared.
  - The same rectangle, together with the grid dots that exist only inside the main view, appears in the minimap as the camera rectangle (§3.8).

### 3.7 Hover highlight, empty markers and painting
- `highlightBox` is a graphics object at **depth 101** (814-815). On pointer move it uses Z-level colour `currentZLevel` (default 1, red `0xff0000`):
  `fillStyle(color, 0.5)` + `lineStyle(2, color, 1)`, then `strokeRect` and `fillRect` of the hovered 16×16 tile (1733-1757).
  It only highlights when `x < 36 && y < 20`. That limit is hard-coded (1724), so nothing is highlighted past column 35.
- Painting with the left button places the selected tile **every frame while held** (1336-1360). There is no preview or ghost; tiles appear instantly.
  Coins and Fruit go to `Collectables_Layer`. Terrain and enemies go to `Ground_Layer`. In the editor, enemies are plain tiles 8 and 9.
- The "Empty" marker (`redrawEmptyTileOverlay`, 97-130) is drawn at **depth 50**. It is a 1px red `0xff0000` diagonal from top-left to bottom-right, plus a 1px white `0xffffff` diagonal from top-right to bottom-left, across the tile.

### 3.8 Minimap (`createMinimap`, editorScene.ts:2342-2363)
- `this.cameras.add(10, 10, 3200*0.15, 320*0.15)` gives a **480 × 48 px camera at canvas (10,10)**, with `setZoom(0.15)` (`minimapZoom`, line 84), `setName("minimap")`,
  `setBackgroundColor(0x002244)` and bounds equal to the map. It is a second camera, rendered after the main camera (so on top), in the canvas's top-left.
- It shows the **entire map**: 3200 px × 0.15 = 480. The background colour `#002244` is never visible because the tiles cover it all.
- It has **no border, frame, radius or shadow**. Its top 3 rows are white, so they merge with the white sky behind. It reads as a thin floating strip: about 7px of white, then light blue, dark blue, and a grass/dirt band (`01c`).
- **Camera rectangle:** nothing extra is drawn. The main view shows up as a faint pink/red outline: the red edge rect at 0.3px, plus a slightly dotted tint where the grid is drawn.
  At the default view it spans canvas x 10 to about 96.
- Everything in world space appears in it: tiles, selection boxes, the hover highlight and grid dots.
- It is removed in Play mode (`startGame`, 256) and recreated on exit (2195). Pressing **U** toggles it, together with the UI (623-629).

### 3.9 Selection boxes (`src/phaser/selectionBox.ts`)
These are part of the old chat flow, but they are visible canvas chrome. Keep them if Ghost keeps selection regions.
- Z-level colours (`src/phaser/colors.ts:3-13`), in order: `0xff0000` red, `0xffa500` orange, `0xffff00` yellow, `0x00ff00` green, `0x0000ff` blue,
  `0x7f00ff` violet, `0xffc0cb` pink, `0x643200` brown, `0x00ffff` cyan. Level 1 is red.
- Box body (`redraw`, 528-597; graphics at depth 100, line 222): `fillStyle(color, 0.3)` over the tile rectangle, plus a 2px border in `color`.
  The border is **dashed** (8 px dash, 4 px gap, in world px) while the box is temporary, and **solid** once finalized (with N, or when a tool call finalizes it).
- "Box" tab (`createTab`, 609-643): a container at **depth 1001** at `(left*16, top*16 - 12)` holding:
  - a background rectangle 48×14 (origin 0,0.5) with a 1px stroke;
  - text `Box`, 10px, white, `resolution: 2`, at x 6. It uses Phaser's default font family `Courier`, so it is monospace.
  - It is in world space, so it **scales with zoom**: at 2.25 the text is about 22px tall.
  - The text becomes `Box[(x1,y1),(x2,y2)]` while active, with `(Nn, Nd, Nz)` counts appended. The width grows to fit, with 8px padding (1457-1520).
  - If the tab would go above the top of the view, it moves inside the box (1024-1039).
- Tab colours:
  | State | Fill | Stroke | Hover fill |
  |---|---|---|---|
  | active | `0x127803` | `0x0f3800` | — |
  | temporary, not active | `0x2b6bff` | `0x123a66` | `0x4d8cff` |
  | finalized, not active | `0x2b2b2b` | `0x111111` | `0x3d3d3d` |
  | has neighbours | `0x00aaff` (active `0x00ff88`) | — | — |
  | intersecting | `0xfff0e6` (active `0xffe0cc`) | 2px `0xffa500` | — |
- Drag preview: a ghost copy of the box's tiles at **alpha 0.75, depth 1002**. Empty cells get red and white X lines at depth 1003 (1772-1806).

### 3.10 Sprites in Play mode
- **Player (knight):** `physics.add.sprite(100, 100, "spritesheet", 14)`, which is tileset frame 14 (gid 15). It is 16×16 at scale 1 (36 screen px at zoom 2.25), with body `setSize(10,14).setOffset(3,1)`,
  and flips with direction (setupPlayer, 1012-1024; 1253-1259). It has no animation frames. After death it respawns at (100,150) after a 600ms pause (2298-2340).
- **Slime Enemy:** `Slime` sprite with spritesheet frame **8** (lime) (`ExternalClasses/Slime.ts:35`). It fires pellets (`pellets` frame 1, `setScale(2)`, lines 130-131).
- **Ultra Slime:** `UltraSlime` with frame **7** (pink) (`UltraSlime.ts:34`). It fires pellets (frame 0, scale 2) and a big "mega" pellet (frame 2, scale 2) (146-161).
- Enemies spawn from ground tiles 8 and 9 when Play starts. The tiles are cleared (276-311).
- **Collectables** stay as tiles: Coin is gid 2 (+1 coin) and Fruit is gid 3 (+1 HP). They are removed on overlap (328-347) and restored when you leave Play.
- **No particle effects** are used. `kenny-particles` is never loaded (the line is commented out in loadingScene.ts:26-27). EffectsManager falls back silently, and only DynamicEnemy uses it, which the normal flow never spawns.
- **No audio** plays in the editor or Play mode. `GameScene` is the only code that calls sounds, and it is dead code.
- Debug overlay (press **G** in Play): the arcade debug graphic, plus a notification text. It is 16px `monospace`, `#00ff00` when on and `#ff6600` when off, on `#000000cc` with 10/5 padding. It is placed at `(worldView.centerX, worldView.y + 50)` with origin (0.5, 0) and `setScrollFactor(0)`, at depth 2000. It fades out over 500ms after 2s (436-476).

### 3.11 Canvas draw order (z-order), bottom to top
| Depth | Object | Source |
|---|---|---|
| 0 | Background_Layer, then Ground_Layer, then Collectables_Layer (creation order) | editorScene.ts:509-525 |
| 0 | Enemy and player sprites (created later, so drawn above the layers) | Slime.ts, editorScene.ts:1013 |
| 10 | Dotted grid and red edge rect | 565 |
| 50 | Empty-tile X markers | 100 |
| 100 | Selection box fill and border | selectionBox.ts:222 |
| 101 | Hover highlight | 815 |
| 1001 | Selection box "Box" tab | selectionBox.ts:643 |
| 1002 / 1003 | Box drag preview layer / preview X marks | selectionBox.ts:1772, 1794 |
| 2000 | Debug notification text | 465 |
| (camera) | Minimap camera, drawn after the main camera | 2347 |
| (DOM) | Phaser DOM container over the canvas: panel `z-index:0`, toolbar `z-index:1001`, play HUD appended afterwards | UIScene.ts:140, 517, 527 |

---

## 4. Bottom toolbar

Markup (`src/phaser/UIScene.ts:517-527`). It is a Phaser DOM element at **(460, 692)** with origin 0.5 and `setDepth(1001)`:
```html
<div class="pt-toolbar">
  <button class="pt-tbtn pt-tbtn-play" id="tbtn-play">▶ Play</button>
  <div class="pt-toolbar-spacer"></div>
  <button class="pt-tbtn" id="tbtn-deselect">✕ Deselect</button>
  <button class="pt-tbtn pt-tbtn-save" id="tbtn-save">💾 Save</button>
  <button class="pt-tbtn pt-tbtn-load" id="tbtn-load">📂 Load</button>
  <button class="pt-tbtn pt-tbtn-reload" id="tbtn-reload">↺ Save & Reload</button>
</div>
```
Glyphs: ▶ U+25B6, ✕ U+2715, 💾, 📂, ↺ U+21BA. The emoji are OS colour emoji.

**Geometry:** `.pt-toolbar` (chatbox.css:485-495) is `display:flex; align-items:center; gap:8px; width:910px; padding:0 16px; background:transparent; border:none; box-sizing:border-box`.
That puts the bar at canvas x 5-915, y 674-710 (36px tall). The bottom (710) lines up with the panel bottom. The right end (915) is 10px left of the panel (925).
`.pt-toolbar-spacer { flex:1 }` (497-499) pushes Play to the far left. The other four buttons sit together on the right, with 8px gaps.
Measured at 1440×900 (page coordinates; canvas at x 80):
| Button | x | width |
|---|---|---|
| Play | 101 | 87.5 |
| Deselect | 482.2 | 118.5 |
| Save | 608.7 | 97.7 |
| Load | 714.4 | 98.7 |
| Save & Reload | 821.1 | 157.9 |

All buttons are 36px tall, and all sit at y 772.25 (canvas y 674).
There is **no bar background**. The buttons float over the map.

**Base pill `.pt-tbtn`** (501-526): `padding:10px 20px; border-radius:10px; border:1px solid rgba(255,255,255,.28); background:rgba(22,22,38,.95);
backdrop-filter: blur(12px) (with the -webkit- prefix); color:#c8c8e8; font: 600 14px/1 "Space Grotesk"; letter-spacing:.02em; white-space:nowrap; user-select:none;
box-shadow: 0 4px 20px rgba(0,0,0,.7), 0 1px 4px rgba(0,0,0,.5); transition: background/border-color/color/transform/box-shadow .12s`.
- Hover (528-536): `background:rgba(36,36,58,.98); border-color:rgba(255,255,255,.45); color:#fff; transform:translateY(-2px); box-shadow: 0 8px 28px rgba(0,0,0,.75), 0 2px 6px rgba(0,0,0,.5)`.
- Active (538-541): `transform:translateY(0); box-shadow: 0 2px 10px rgba(0,0,0,.6)`.
- The "glass" is mostly the blur. With fills at 0.85-0.95 alpha, the buttons look almost solid, slightly tinted by the dirt behind.

**Per-button colour schemes:**
| Button | Rest bg / border / text | Hover bg / border / text | Extra |
|---|---|---|---|
| Play `.pt-tbtn-play` (544-560) | `rgba(22,101,52,.85)` / `rgba(74,222,128,.7)` / `#bbf7d0` | `rgba(22,120,60,.95)` / `#4ade80` / `#ffffff` | weight **700**. Rest shadow `0 4px 20px rgba(74,222,128,.2), 0 2px 8px rgba(0,0,0,.6)`; hover shadow `0 6px 24px rgba(74,222,128,.35), 0 2px 8px rgba(0,0,0,.6)` (a green glow) |
| Deselect (base) | `rgba(22,22,38,.95)` / `rgba(255,255,255,.28)` / `#c8c8e8` | `rgba(36,36,58,.98)` / `rgba(255,255,255,.45)` / `#fff` | — |
| Save `.pt-tbtn-save` (563-572) | `rgba(20,80,45,.85)` / `rgba(74,222,128,.5)` / `#86efac` | `rgba(22,100,55,.95)` / `rgba(74,222,128,.8)` / `#bbf7d0` | — |
| Load `.pt-tbtn-load` (575-584) | `rgba(23,58,110,.85)` / `rgba(96,165,250,.5)` / `#93c5fd` | `rgba(28,72,140,.95)` / `rgba(96,165,250,.8)` / `#bfdbfe` | — |
| Save & Reload `.pt-tbtn-reload` (587-596) | `rgba(100,55,10,.85)` / `rgba(251,146,60,.5)` / `#fdba74` | `rgba(124,68,12,.95)` / `rgba(251,146,60,.8)` / `#fed7aa` | — |

Every button lifts 2px on hover, with the base hover shadow. Play is the exception and uses its green glow shadow. These were verified with computed styles (`06-hover-*.png`).
After a click, the global `button:focus` outline can show (§9).

---

## 5. Right panel

### 5.1 Container
- It is a Phaser DOM element at **(1095, 360)**, origin 0.5 (`UIScene.ts:140`). The panel is 340×700, so it sits at canvas **(925, 10)-(1265, 710)**: 10px from the top and bottom, and 15px from the right edge.
- `.pt-chatbox` (chatbox.css:25-41): `width:340px; height:700px; background:rgba(6,6,16,.78); border:1px solid rgba(255,255,255,.09); border-radius:14px;
  box-shadow: 0 8px 48px rgba(0,0,0,.7), 0 2px 8px rgba(0,0,0,.4); color:#e8e8ff; font-family:"Space Grotesk",system-ui,sans-serif; font-size:14px;
  display:flex; flex-direction:column; box-sizing:border-box; overflow:hidden`.
- It is **translucent but NOT blurred**: there is no `backdrop-filter` on the panel. The map shows through, darkened.
  Measured effective colours are `#3d3d44` over the white sky, `#09263c` over light blue and `#0a1636` over dark blue. The grid dots and tiles stay crisp underneath.
- The 48px black shadow makes a soft dark halo around the panel, which is most visible over the white sky (`01a`).

### 5.2 Design tokens (`chatbox.css:8-22`)
```css
--pt-bg:#0b0b16; --pt-surface:#111122; --pt-raised:#18182e;
--pt-border:rgba(255,255,255,.07); --pt-border-hi:rgba(255,255,255,.13);
--pt-accent:#7c5cfa; --pt-accent-dim:rgba(124,92,250,.18);
--pt-green:#4ade80; --pt-blue:#60a5fa;
--pt-text:#e8e8ff; --pt-text-2:#5e5e8a; --pt-text-3:#2a2a46;
--pt-font:"Space Grotesk", system-ui, sans-serif;
--pt-tileset-url: url("<BASE_URL>phaserAssets/pewterPlatformerTilesetExtended.png")  /* set from JS, UIScene.ts:15-18 */
```

### 5.3 Header (`.pt-chatbox-header`, 44-54)
`display:flex; align-items:center; padding:0 14px 0 16px; height:46px; background:rgba(0,0,0,.25); border-bottom:1px solid rgba(255,255,255,.1);
border-radius:14px 14px 0 0; flex-shrink:0; gap:12px`. Measured at 47px including the border.
- **Brand** `<span class="pt-brand">✦ pewter</span>` (✦ is U+2726, lowercase "pewter") (56-65): `font: 700 13px "Space Grotesk"; letter-spacing:.06em; color:#c4aaff;
  text-shadow:0 0 12px rgba(124,92,250,.5)` (a soft violet glow), `white-space:nowrap; user-select:none`.
- **Tabs** `.pt-tabs-inline` (67-71): `display:flex; gap:2px; margin-left:auto`. Buttons: `#tab-chat` "Chat", `#tab-blocks` "Blocks", `#tab-controls` "Controls".
  - `.pt-tab` (73-89): `padding:5px 11px; border:1px solid transparent; border-radius:6px; background:transparent; color:rgba(180,170,220,.6);
    font: 500 12px "Space Grotesk"; letter-spacing:.01em; transition: color/background/border-color .15s`. Tabs are 26px tall.
  - `.pt-tab.active` (91-95): `background:rgba(124,92,250,.2); color:#fff; border-color:rgba(124,92,250,.4)`.
  - `.pt-tab:hover:not(.active)` (97-100): `color:rgba(220,210,255,.9); background:rgba(255,255,255,.06)`. The border turns **green `#127803`** through the leaked global `button:hover` (§9, `04b`).
  - `:focus` gives `outline:none` (102-105).
  - Switching tabs sets `display` on the content panes: `flex` or `none` (UIScene.ts:704-752). The default is Chat.

### 5.4 Chat tab
- `.pt-chat-log` (129-140): `flex:1 1 auto; overflow-y:auto; padding:16px 14px 8px; display:flex; flex-direction:column; gap:10px`.
  The scrollbar is thin: `scrollbar-color: rgba(124,92,250,.2) transparent`, and WebKit gets a 3px track with thumb `rgba(124,92,250,.25)` and radius 2 (142-148).
- **AI bubble** `.pt-msg-ai` (151-159, 172-179): `padding:10px 13px; border-radius:10px` with **bottom-left radius 3px**; `font-size:13.5px; line-height:1.6;
  background:#111122; border:1px solid rgba(255,255,255,.13); color:#e8e8ff; align-self:flex-start; max-width:96%`. It has no label or avatar.
- **User bubble** `.pt-msg-human` (162-169): `background:rgba(96,165,250,.12); border:1px solid rgba(96,165,250,.22); color:#c7dcff; align-self:flex-end;
  max-width:88%`, with **bottom-right radius 3px** (`10`).
- Markdown in bubbles (`src/languageModel/chatBox.ts:14-35`) supports `**bold**` (weight 600) and inline code. Code gets `background:rgba(255,255,255,.08); padding:1px 6px; radius 4px;
  monospace 12px`. Lists get `margin:5px 0 2px; padding-left:18px`, with `li` margin 3px (181-205).
- Welcome message (static, `src/main.ts:54-58`): *"Hello there! I'm Pewter, your friendly platformer level design assistant. I can help you create amazing levels
  by placing and clearing tiles, and even tell you about the world. To get started, please draw a selection box on the map!"*
- **Typing indicator:** `<div id="pt-typing-indicator" class="pt-msg-ai"><span class="pt-typing-dots"></span></div>` (UIScene.ts:500-506). See §8 for the animation.
- **Temporary warning** `.pt-temp-message` (469-479): `color:#fbbf24; font-style:italic; font-size:12px; background:rgba(245,158,11,.08);
  border:1px solid rgba(245,158,11,.2); padding:8px 12px; border-radius:8px; align-self:stretch`. Text: "⚠️ Select a region on the map first (right-click and drag)."
  It shows for 3s, then fades over 0.5s (UIScene.ts:314-327; `02a`).
- **Input area** `.pt-chat-input-area` (208-213): `padding:10px 14px 14px; border-top:1px solid rgba(255,255,255,.07)`. It is 64px tall.
- **Input** `#chat-input.pt-chat-input` (215-241): `width:100%; padding:11px 14px; font: 400 13px "Space Grotesk"; border:1px solid rgba(255,255,255,.13);
  border-radius:10px; background:#111122; color:#e8e8ff; caret-color:#7c5cfa; outline:none; transition: border-color/box-shadow .15s`. It measures 310×39.
  - Focus: `border-color:rgba(124,92,250,.45); box-shadow:0 0 0 3px rgba(124,92,250,.12)`.
  - Placeholder colour `#7070a8`. The placeholder text is "Type a command..." initially; "Select a region first (right-click & drag)..." when there is no box; "Pewter is thinking..." while the model responds (UIScene.ts:330-339).

### 5.5 Blocks tab
Markup (UIScene.ts:157-173). Buttons are generated by `populateBlockGroup` (630-670).
- `.pt-blocks-content` (246-256): `flex-direction:column; overflow-y:auto; padding:10px 12px 14px; gap:2px`, with the same thin violet scrollbar.
- Groups `.pt-blocks-group { margin-bottom:6px }`, in this order:
  1. **Eraser group (no heading):** `#blocks-list-eraser`. Text buttons **"Eraser 🗑️"** and **"Empty"**, both with red styling:
     `background:rgba(220,38,38,.1); border-color:rgba(239,68,68,.25); color:#fca5a5`. Hover: `rgba(220,38,38,.2)` / `rgba(239,68,68,.45)`.
     Selected: `rgba(220,38,38,.25)` / `rgba(248,113,113,.5)` (364-376). Sizes 87×34 and 70×34.
  2. **COLLECTABLES:** Coin, Fruit.
  3. **BLOCKS:** Grass-Half Block, Dirt Block, Grass Block, Question Block.
  4. **ENEMIES:** Slime Enemy (lime), then Ultra Slime (pink).
- Headings `h4.pt-blocks-heading` (262-269): `font-size:10px; font-weight:600; color:#b0b0d8; text-transform:uppercase; letter-spacing:.12em; margin:10px 2px 6px`.
- Lists `.pt-blocks-list` (271-276): `display:flex; flex-wrap:wrap; gap:6px; padding:2px`.
- Icon buttons `.pt-blocks-list button` (278-293): `padding:8px 14px; border-radius:8px; border:1px solid rgba(255,255,255,.07); background:#111122; color:#c0c0e0;
  font: 500 12.5px "Space Grotesk"; transition: background/border-color/color .12s, transform .1s`. Each measures **46×35**. Each has `title` and `aria-label` set to the block name and contains only an icon.
  - Hover (295-300): `background:#18182e; border-color:rgba(255,255,255,.13); color:#e8e8ff; transform:translateY(-1px)`. Active: `translateY(0)`.
  - **Selected** `.selected` (306-310): `background:rgba(124,92,250,.18); border-color:rgba(124,92,250,.5); color:#c4b5fd`. The browser focus ring from §9 also shows (`05b`).
- **Sprite icons** `.pt-block-icon` (313-362): a 16×16 inline-block span with `background-image: var(--pt-tileset-url)`, `background-size:240px 16px`,
  `image-rendering:pixelated`, `vertical-align:middle`. Background positions:
  | Block | Position | Scale |
  |---|---|---|
  | Coin | −16px | 2.5 |
  | Fruit | −32 | 2.5 |
  | Grass-Half | −48 | 2 |
  | Dirt | −64 | 2 |
  | Grass | −80 | 2 |
  | Question | −96 | 2 |
  | Ultra Slime | −112 | 2 |
  | Slime | −128 | 2 |

  The scale is a CSS `transform`, so layout stays 16×16 while the icon visually overflows to about 32-40px.
- Block name to tile index (editorScene.ts:723-735): Coin 2, Fruit 3, Grass-Half 4, Dirt 5, Grass 6, Question 7, Ultra Slime 8, Slime Enemy 9, Eraser −1, Empty −1.

### 5.6 Controls tab
- `.pt-controls-content` (381-390): `padding:16px; overflow-y:auto`, with the thin violet scrollbar.
- `h3` (392-401): `margin:0 0 8px; color:#b0b0d8; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.12em;
  border-bottom:1px solid rgba(255,255,255,.07); padding-bottom:8px`. A following `h3` gets `margin-top:20px` (403-406).
- Rows `.control-item` (408-419): `display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:1px solid rgba(255,255,255,.03); gap:10px`.
  The last row has no border.
- Key chips `.control-key` (421-433): `background:#18182e; border:1px solid rgba(255,255,255,.13); padding:3px 9px; border-radius:5px;
  font: 11px "JetBrains Mono","Fira Code","Consolas",monospace; min-width:50px; text-align:center; color:#a0a0cc; white-space:nowrap`.
- Descriptions `.control-desc` (435-440): `flex:1; color:#b0b0d8; font-size:12px; text-align:right`.
- Exact content (UIScene.ts:175-232):
  - **Basic Controls**
    - Left Click: Place tile (drag to continuously place)
    - Right Click: Make a selection box (drag)
    - WASD: Move camera & character (Press **Shift** to move faster)
    - U: Toggle UI
  - **Selection Controls**
    - Ctrl + C: Copy selection
    - Ctrl + X: Cut selection
    - Ctrl + V: Paste selection
    - Ctrl + Z: Undo last action
    - Ctrl + Y / Ctrl + Shift + Z: Redo last action
    - Del / Backspace: Delete selected box
    - R: Deselect active box
    - N: Confirm new selection box
    - O: Decrease Z-Level
    - P: Increase Z-Level
  - The content is taller than the panel and scrolls.

---

## 6. Play mode (`startGame`, editorScene.ts:250-433; exit via `startEditor`, 2179-2296)
- **Removed:** UIScene is stopped (panel and toolbar gone), the minimap is removed, the grid, red edge and hover highlight are cleared every frame (1240-1241), and selection boxes are hidden.
- **Camera:** bounds = map, `startFollow(player, false, 0.1, 0.1)`, zoom stays at the current `zoomLevel` (2.25 by default). Gravity is 1500. Run speed 400, acceleration 1500,
  friction 1200, air control 0.8, jump −550, with a variable-height jump (×0.4 on release) (1261-1312).
- **HUD (DOM, appended to `game.domContainer`):**
  - **Stats pill** `.pt-play-stats` (chatbox.css:673-689): `position:absolute; top:14px; left:16px; display:flex; align-items:center; gap:10px;
    background:rgba(10,10,20,.72); backdrop-filter:blur(12px); border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:7px 14px; pointer-events:none`.
    It measures about 151×38.5.
    - Hearts `.pt-stat-hearts`: `♥` × HP + `♡` × (5−HP) (U+2665 / U+2661), 15px, `letter-spacing:2px`, `#ff6060`.
    - Separator `.pt-stat-sep`: 1×14, `rgba(255,255,255,.15)`.
    - Coins `.pt-stat-coins`: `⬡ N` (U+2B21), 13px, weight 500, `#fcd34d`.
  - **Key-hint pills** `.pt-play-hint-q` (710-756): `position:absolute; top:14px; right:16px; display:flex; align-items:center; gap:7px; background:rgba(10,10,20,.72);
    backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:6px 13px 6px 11px; cursor:pointer`.
    Hover: `background:rgba(22,22,40,.92); border-color:rgba(255,255,255,.28)`. Transition .12s.
    - `kbd`: `background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.3); border-bottom:2px solid rgba(255,255,255,.22); border-radius:5px; padding:2px 10px;
      monospace 13px/600; color:#e8e4ff; min-width:26px; text-align:center`.
    - `span`: Space Grotesk 13px/500, `rgba(210,200,240,.8)`, letter-spacing .02em.
    - Two instances: **`B` "👁️ OFF"/"👁️ ON"** with inline `right:140px` (toggles box visibility), and **`Q` "Exit"** at `right:16px` (returns to the editor).
  - Over the white sky these pills read as mid-grey glass (`08a`, `08b`).
- `.pt-play-hud`, `.pt-play-hearts`, `.pt-play-coins`, `.pt-play-boxes-btn` and `.pt-play-hint` (601-670) are **defined but unused**. Do not reproduce them.
- `createOptionsButton` (2062-2147, a Phaser "⚙ Options" panel) is **never called**. `playButton` is never created. Both are dead code.

---

## 7. Fonts and font loading
- **Space Grotesk** 400/500/600/700, loaded twice:
  - from `index.html:8-13` (`<link rel=preconnect>` + stylesheet);
  - from `chatbox.css:5` (`@import url(...)` with the same URL).

  It uses `display=swap`. Google serves it as a variable font with vietnamese, latin-ext and latin subsets.
- Used for all UI text: label, panel, tabs, bubbles, input, toolbar and HUD. Fallbacks: `system-ui, -apple-system, sans-serif` (`:root`), and `system-ui, sans-serif` (`--pt-font`).
- Monospace (`"JetBrains Mono","Fira Code","Consolas",monospace`) is used for key chips, inline code and `kbd`. **It is not web-loaded**, so it renders in the OS default.
- Phaser canvas text uses Phaser's default **`Courier`** for the "Box" tabs and `monospace` for the debug notification.
- Weights in use:
  - 400: body, input, AI text
  - 500: label, tabs, block buttons, coins, hint text
  - 600: toolbar buttons, headings, kbd
  - 700: Play button, brand

---

## 8. Animations and transitions
| What | Definition |
|---|---|
| Typing dots | `.pt-typing-dots::after { content:"   "; animation: pt-dots 1.2s steps(4,end) infinite; letter-spacing:2px }` with keyframes `0% "   "`, `25% ".  "`, `50% ".. "`, `75% "..."` (chatbox.css:445-464) |
| Temp warning fade | Inline `transition: opacity .5s`; opacity goes to 0 after 3000ms, then the element is removed (UIScene.ts:322-326) |
| Toolbar buttons | `.12s` on background, border-color, color, transform, box-shadow; hover `translateY(-2px)` |
| Block buttons | `.12s` colours, `.1s` transform; hover `translateY(-1px)` |
| Tabs | `.15s` color, background, border-color |
| Chat input | `.15s` border-color, box-shadow |
| Play hint pills | `.12s` background, border-color |
| Global `button` | `transition: border-color .25s` (style.css:76) |
| Phaser | Debug notification alpha tween to 0 over 500ms after 2s. Camera follow lerp 0.1. **No other tweens, particles or animated sprites.** |

---

## 9. Quirks that are part of the current look
1. **Green tab hover border.** `style.css:81-83` `button:hover{border-color:#127803}` wins over `.pt-tab`'s transparent border. Hovering an **inactive** tab shows a
   1px green `#127803` border (`04b`). The active tab is unaffected. `#127803` is also the active selection-box tab colour.
2. **Focus ring on clicked buttons.** `style.css:85-88` gives `outline:4px auto -webkit-focus-ring-color`. After you click a block or toolbar button, Chromium draws a
   white and dark focus ring around it (visible on the selected Grass Block in `05`, `05a`, `05b`). Tabs suppress it.
3. **Hover highlight limited to the first 36 columns** (`x < 36`, editorScene.ts:1724).
4. **"Box" tab text scales with zoom**, because it is in world space, and it is monospace (Courier).
5. **The panel is translucent but not blurred**, while the toolbar buttons and HUD pills do use `backdrop-filter` blur.
6. **There is no responsive behaviour.** At viewports smaller than about 1280×751, the page scrolls and the toolbar is cut off (`02b`).
7. **The red bottom line comes from the grid edge rectangle**, not a border. It vanishes when zoomed in or in Play mode.

---

## 10. Keys that change what is on screen
- **U** (no Ctrl): toggles panel and toolbar visibility, and the minimap (UIScene.ts:248-281; `09`).
- Mouse wheel zooms 2.25-10 in steps of 0.1. W/A/S/D pan (×4 with Shift). Middle-drag pans.
- Left-drag paints the selected block. Right-drag draws a selection box (Z-level colour fill, dashed outline, "Box" tab).
- Play mode: **Q** exits, **B** toggles box visibility, **G** toggles the physics debug overlay.

---

## 11. Not part of the visible look (do not copy)
- `GameScene` (`src/phaser/gameScene.ts`) is never started. That rules out its parallax `tileSprite`s (bg/buildings, `setScale(5)`, depth −90/−89), its "Coins:" and "HP:" Phaser texts, its `#1a1a1a`/`#127803` "editor" button, and its Kenney walking and jump particles.
- `public/phaserAssets/background/*.png`, `tilemap_packed.png` (18px Kenney tiles), `tilemap-characters-packed.*` and `kenny-particles-*` are loaded but unused, or never loaded at all.
- `style.css` `#llm-chat…` rules, `chatbox.css` `.pt-tabs` (hidden) and the `.pt-play-hud*` and `.pt-play-boxes-btn` family.
- `EditorScene.createOptionsButton` and the options panel, `playButton` and `editorButton`.

---

## 12. Notes for reproducing it in Pewter Ghost
- The tileset PNGs, the extras PNG, `pellets.png` and `pewterPlatformerDefaultMap.json` in `apps/editor/public/phaserAssets/` are **byte-identical** to the old ones (same md5). Use them as they are, with 16×16 frames at zoom 2.25.
- Keep these unchanged:
  - the page shell from §2 (`#08080f`, the uppercase label, a fixed and centred 1280×720 canvas);
  - the canvas layers from §3: tile-band sky, dotted black grid at depth 10, the red `0xf00000` 2px edge rect giving the bottom line, the frameless 480×48 minimap at (10,10) and zoom 0.15, and the red Z1 hover highlight;
  - the toolbar from §4: same five pills, colours, geometry and hover lift;
  - the panel shell from §5: 340×700 at (925,10), the translucent unblurred dark style, the "✦ pewter" header with inline violet tabs, the Blocks palette and the Controls list.
- Ghost's autofill replaces the old chat feature, but the panel chrome around it should stay the same. Reuse the `.pt-msg-ai` bubble, the `.pt-temp-message` amber note and the `.pt-chat-input` field styles for any status or hint text, and the `--pt-*` tokens above for any new controls. Then new elements will look native.
- Tab, button and HUD text are listed above verbatim (§4, §5.3-5.6, §6).
