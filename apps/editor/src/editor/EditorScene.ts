/**
 * The editor scene, kept thin: it wires the renderer (render.ts), camera
 * (camera.ts), painting (paint.ts + pointer.ts) and Play (play.ts) to the
 * level model, and publishes the EditorApi seam (api.ts) for the ghost.
 */
import Phaser from "phaser";
import { NAME_BY_TILE, type Point } from "../contracts";
import type { LevelModel } from "../level/LevelModel";
import type { PlaySettings, SuggestionHistorySummary } from "../level/save";
import type { GhostConfig } from "../suggest/config";
import {
  EditorEmitter,
  publishEditorApi,
  retractEditorApi,
  type EditorApi,
  type EditorEventName,
  type EditorEvents,
  type EditorLogger,
  type PlayResult,
} from "./api";
import { buildTextures } from "./assets";
import { CameraController } from "./camera";
import { DEPTH, SCENE, TILE_PX } from "./constants";
import { panDirection } from "./keys";
import type { ModeState } from "./modes";
import { StrokePainter } from "./paint";
import { PlayController, type PlayHud } from "./play";
import type { PlaySettingsStore } from "./playSettings";
import { PointerBinding } from "./pointer";
import { Renderer } from "./render";

/**
 * Camera pan speed for held WASD / arrows, in screen px per second: the old
 * editor's 10 screen px per frame (editorScene.ts:88, cameraMotion) at 60 fps,
 * four times faster with Shift (editorScene.ts:1027-1030).
 */
const KEY_PAN_PX_PER_S = 600;
const KEY_PAN_SHIFT_FACTOR = 4;

/**
 * Hover highlight colour per mode. Paint and Erase use the old editor's
 * highlight colour (Z-level 1, red: colors.ts Z_LEVEL_COLORS[0]). Select and
 * Pan did not exist in the old editor; they take the blue and cyan of the same
 * old Z-level palette (Z_LEVEL_COLORS[4], [8]).
 */
const HIGHLIGHT_COLOR = { paint: 0xff0000, erase: 0xff0000, select: 0x0000ff, pan: 0x00ffff } as const;

export interface EditorSceneDeps {
  model: LevelModel;
  modes: ModeState;
  settings: PlaySettingsStore;
  config: GhostConfig;
  log: EditorLogger;
  statusSlot: HTMLElement;
  stage: HTMLElement;
  /** Keys currently held (maintained by the DOM shortcut binding). */
  heldKeys: ReadonlySet<string>;
  notify: EditorApi["notify"];
  clock?: () => number;
}

/** Events the scene sends to the UI scene and DOM UI through game.events. */
export const UI_EVENT = {
  mode: "pg:mode",
  hover: "pg:hover",
  hud: "pg:hud",
  play: "pg:play",
  inspect: "pg:inspect",
} as const;

export class EditorScene extends Phaser.Scene {
  levelRenderer!: Renderer;
  camera!: CameraController;
  painter!: StrokePainter;
  pointer!: PointerBinding;
  play!: PlayController;
  readonly events2 = new EditorEmitter();
  // Old Pewter Platformer editor fields (editorScene.ts:62-84), same names.
  private TILE_SIZE = 16;
  private SCALE = 1.0;
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private highlightBox!: Phaser.GameObjects.Graphics;
  private emptyMarkGraphics!: Phaser.GameObjects.Graphics;
  private minimap: Phaser.Cameras.Scene2D.Camera | null = null;
  private minimapZoom = 0.15;
  private hover: Point | undefined;
  private historyProvider: (() => SuggestionHistorySummary | undefined) | null = null;
  private api!: EditorApi;
  private cleanups: (() => void)[] = [];
  private readonly clock: () => number;

  constructor(private readonly deps: EditorSceneDeps) {
    super({ key: SCENE.editor });
    this.clock = deps.clock ?? (() => performance.now());
  }

  get model(): LevelModel {
    return this.deps.model;
  }

  /** The old default map (its size is the level's: 200 x 20 tiles of 16 px). */
  get map(): Phaser.Tilemaps.Tilemap {
    return this.levelRenderer.defaultMap;
  }

  get isPlaying(): boolean {
    return this.play?.isActive ?? false;
  }

  create(): void {
    const { model, modes } = this.deps;
    buildTextures(this);
    this.physics.world.gravity.y = 0;

    this.levelRenderer = new Renderer(this, model);
    this.painter = new StrokePainter(model, {
      onBegin: (s) => this.events2.emit("stroke:begin", s),
      onEnd: (s) => this.events2.emit("stroke:end", s),
    });
    this.camera = new CameraController(
      this,
      { w: this.levelRenderer.widthPx, h: this.levelRenderer.heightPx },
      () => this.painter.isActive,
    );
    this.camera.home(model.start);

    this.createMinimap();

    // grid (old editorScene.ts:564-566; depth: see DEPTH.grid)
    this.gridGraphics = this.add.graphics();
    this.gridGraphics.setDepth(DEPTH.grid);
    this.drawGrid();

    // highlight box (old editorScene.ts:814-815, depth 101: above everything in the level)
    this.highlightBox = this.add.graphics();
    this.highlightBox.setDepth(DEPTH.cursor);
    this.emptyMarkGraphics = this.add.graphics().setDepth(DEPTH.cursor);

    this.pointer = new PointerBinding({
      scene: this,
      camera: this.camera,
      modes,
      painter: this.painter,
      isPlaying: () => this.isPlaying,
      inBounds: (x, y) => model.inBounds(x, y),
      onHover: (cell) => this.setHover(cell),
      onSelect: (cell) => this.inspect(cell),
    });

    this.play = new PlayController({
      scene: this,
      model,
      renderer: this.levelRenderer,
      camera: this.camera,
      settings: this.deps.settings,
      log: this.deps.log,
      clock: this.clock,
      onHud: (hud: PlayHud) => this.game.events.emit(UI_EVENT.hud, hud),
      onEnd: (r) => this.onPlayEnd(r),
    });

    // A mode change ends any stroke or pan in progress.
    this.cleanups.push(
      modes.subscribe((s, prev) => {
        if (s.effective !== prev.effective) this.pointer.stopAll();
        this.game.events.emit(UI_EVENT.mode, s);
        this.events2.emit("mode", { mode: s.mode, brush: s.brush, effective: s.effective });
        this.drawCursor();
      }),
    );

    // Old editor (editorScene.ts:629-646): the UI toggle also toggles the minimap.
    const toggleMinimap = () => {
      if (this.isPlaying) return;
      if (this.minimap) {
        this.removeMinimap();
      } else {
        this.createMinimap();
      }
    };
    this.game.events.on("ui:toggleMinimap", toggleMinimap);
    this.cleanups.push(() => this.game.events.off("ui:toggleMinimap", toggleMinimap));

    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());

    this.scene.launch(SCENE.ui);
    this.scene.bringToTop(SCENE.ui);
    this.game.events.emit(UI_EVENT.mode, modes.snapshot());

    this.api = this.buildApi();
    publishEditorApi(this.api);
  }

  update(_time: number, delta: number): void {
    if (this.isPlaying) {
      // Old editor (editorScene.ts:1240-1241): no grid or highlight in Play.
      if (this.gridGraphics) this.gridGraphics.clear();
      if (this.highlightBox) this.highlightBox.clear();
      this.play.update(delta);
      return;
    }
    const dir = panDirection(this.deps.heldKeys);
    if ((dir.x || dir.y) && !this.painter.isActive) {
      const fast = this.deps.heldKeys.has("Shift") ? KEY_PAN_SHIFT_FACTOR : 1;
      const step = (KEY_PAN_PX_PER_S * fast * delta) / 1000;
      this.camera.panByScreen(dir.x * step, dir.y * step);
    }
    this.camera.update(delta);
    // Editor mode: the grid follows the view every frame (old editorScene.ts:1328).
    this.drawGrid();
    this.drawCursor();
  }

  // ---------------------------------------------------------------------------
  // Commands used by the toolbar and shortcuts
  // ---------------------------------------------------------------------------

  undo(): boolean {
    return this.history(false);
  }

  redo(): boolean {
    return this.history(true);
  }

  private history(redo: boolean): boolean {
    if (this.isPlaying) return false;
    this.pointer.stopAll();
    const r = redo ? this.model.redo() : this.model.undo();
    if (!r) return false;
    this.deps.log({ type: redo ? "redo" : "undo", t: this.clock(), what: r.what });
    this.events2.emit("undo", { what: r.what, redo });
    return true;
  }

  startPlay(): boolean {
    if (this.isPlaying) return false;
    this.pointer.stopAll();
    this.setHover(undefined);
    // Old startGame (editorScene.ts:256): the minimap goes away in Play.
    this.removeMinimap();
    const ok = this.play.start();
    if (!ok) this.createMinimap();
    if (ok) {
      this.game.events.emit(UI_EVENT.play, true);
      this.events2.emit("play:start", undefined);
    }
    return ok;
  }

  stopPlay(): PlayResult | undefined {
    return this.play.stop(false);
  }

  togglePlay(): void {
    if (this.isPlaying) this.stopPlay();
    else this.startPlay();
  }

  zoomBy(dir: 1 | -1): void {
    this.camera.zoomBy(dir > 0 ? 1.25 : 0.8);
  }

  historySummary(): SuggestionHistorySummary | undefined {
    try {
      return this.historyProvider?.() ?? undefined;
    } catch (err) {
      console.error("history provider failed", err);
      return undefined;
    }
  }

  savedPlaySettings(): PlaySettings | undefined {
    return this.deps.settings.forSave();
  }

  // ---------------------------------------------------------------------------

  private onPlayEnd(r: PlayResult): void {
    // Old startEditor (editorScene.ts:2195): the minimap comes back.
    this.createMinimap();
    this.drawGrid();
    this.game.events.emit(UI_EVENT.play, false);
    this.events2.emit("play:end", r);
    const secs = (r.timeMs / 1000).toFixed(1);
    if (r.reachedGoal)
      this.deps.notify(`Goal! ${secs} s · ${r.deaths} death${r.deaths === 1 ? "" : "s"} · ${r.coins} coin${r.coins === 1 ? "" : "s"}`, {
        ms: 5000,
      });
  }

  private onResize(): void {
    this.camera?.onResize();
  }

  private setHover(cell: Point | undefined): void {
    const same = cell && this.hover && cell.x === this.hover.x && cell.y === this.hover.y;
    if (same || (!cell && !this.hover)) return;
    this.hover = cell ? { ...cell } : undefined;
    this.game.events.emit(UI_EVENT.hover, this.hover);
    this.events2.emit("hover", this.hover);
    this.drawCursor();
  }

  private inspect(cell: Point): void {
    const m = this.model;
    const tile = m.tileAt(cell.x, cell.y);
    const ents = m.entitiesAt(cell.x, cell.y);
    const who = (a: number | undefined) => (a === 1 ? "you" : a === 2 ? "Ghost" : "template");
    let what = "empty";
    if (tile) what = `${NAME_BY_TILE[tile] ?? tile} · placed by ${who(m.authorAt(cell.x, cell.y))}`;
    else if (ents.length) {
      const e = ents[0];
      what = `${e.kind}${e.text ? ` "${e.text}"` : ""}${e.patrol ? ` · patrols ${e.patrol[0]}-${e.patrol[1]}` : ""} · placed by ${who(m.entityAuthor(e.id))}`;
    }
    if (m.start.x === cell.x && m.start.y === cell.y) what += " · start";
    this.game.events.emit(UI_EVENT.inspect, { cell, text: `(${cell.x}, ${cell.y}) ${what}` });
  }

  /**
   * The hovered tile, drawn with the old editor's highlight
   * (editorScene.ts:1733-1757: 50% fill and a 2 px outline in the Z-level 1
   * red). Erase adds the old "Empty" marker's crossed diagonals
   * (redrawEmptyTileOverlay, editorScene.ts:97-130) so the mode does not rely
   * on colour alone.
   */
  private drawCursor(): void {
    const g = this.highlightBox;
    if (!g) return;
    const cell = this.hover;
    this.emptyMarkGraphics.clear();
    if (!cell || this.isPlaying) {
      g.clear();
      return;
    }
    const s = this.deps.modes.snapshot();
    this.drawHighlightBox(cell.x, cell.y, HIGHLIGHT_COLOR[s.effective]);
    if (s.effective === "erase") {
      const px = cell.x * this.TILE_SIZE;
      const py = cell.y * this.TILE_SIZE;
      const sz = this.TILE_SIZE;
      this.emptyMarkGraphics.lineStyle(1, 0xff0000, 1);
      this.emptyMarkGraphics.lineBetween(px, py, px + sz, py + sz);
      this.emptyMarkGraphics.lineStyle(1, 0xffffff, 1);
      this.emptyMarkGraphics.lineBetween(px + sz, py, px, py + sz);
    }
  }

  // ---------------------------------------------------------------------------
  // Old Pewter Platformer editor code (pewter-platfomer src/phaser/editorScene.ts),
  // copied verbatim.
  // ---------------------------------------------------------------------------

  /** Old editorScene.ts:1736-1757, verbatim. */
  drawHighlightBox(x: number, y: number, color: number): void {
    // Clear any previous highlights
    this.highlightBox.clear();

    // Set the style for the highlight (e.g., semi-transparent yellow)
    this.highlightBox.fillStyle(color, 0.5);
    this.highlightBox.lineStyle(2, color, 1);

    // Draw a rectangle around the hovered tile
    this.highlightBox.strokeRect(
      x * 16 * this.SCALE,
      y * 16 * this.SCALE,
      16 * this.SCALE,
      16 * this.SCALE,
    );

    // Optionally, you can fill the tile with a semi-transparent color to highlight it
    this.highlightBox.fillRect(
      x * 16 * this.SCALE,
      y * 16 * this.SCALE,
      16 * this.SCALE,
      16 * this.SCALE,
    );

  }

  /**
   * Old editorScene.ts:1052-1107, verbatim: black dotted lines every 16 world
   * px over the main camera's view, and the 2 px red (0xf00000) edge rectangle
   * around it. Its bottom edge is the red line along the bottom of the canvas
   * at zoom 2.25, and in the minimap it marks the main view.
   */
  drawGrid() {
    const cam = this.cameras.main;

    this.gridGraphics.clear();
    this.gridGraphics.fillStyle(0x000000, 1); // color and alpha

    const startX =
      Math.floor(cam.worldView.x / this.TILE_SIZE) * this.TILE_SIZE;
    const endX =
      Math.ceil((cam.worldView.x + cam.worldView.width) / this.TILE_SIZE) *
      this.TILE_SIZE;

    const startY =
      Math.floor(cam.worldView.y / this.TILE_SIZE) * this.TILE_SIZE;
    const endY =
      Math.ceil((cam.worldView.y + cam.worldView.height) / this.TILE_SIZE) *
      this.TILE_SIZE;

    const dotSpacing = 4;
    const dotLength = 0.4;
    const dotWidth = 1.2;

    const edgewidth = 2;
    // draw edge lines for minimap
    this.gridGraphics.lineStyle(edgewidth, 0xf00000, 1); // color and alpha
    this.gridGraphics.strokeRect(
      startX - edgewidth,
      startY - edgewidth,
      endX - startX + edgewidth,
      endY - startY + edgewidth,
    );

    // Vertical dotted lines
    for (let x = startX; x <= endX; x += this.TILE_SIZE) {
      for (let y = startY - dotLength; y <= endY - dotLength; y += dotSpacing) {
        this.gridGraphics.fillRect(
          x - dotLength / 2,
          y - dotLength / 2,
          dotLength,
          dotWidth,
        );
      }
    }

    // Horizontal dotted lines
    for (let y = startY; y <= endY; y += this.TILE_SIZE) {
      for (let x = startX - dotLength; x <= endX - dotLength; x += dotSpacing) {
        this.gridGraphics.fillRect(
          x - dotLength / 2,
          y - dotLength / 2,
          dotWidth,
          dotLength,
        );
      }
    }
  }

  /** Old editorScene.ts:2342-2363, verbatim (constants.ts MINIMAP restates these numbers for UIScene). */
  private createMinimap() {
    if (this.minimap) {
      this.removeMinimap();
    }

    this.minimap = this.cameras
      .add(
        10,
        10,
        this.map.widthInPixels * this.minimapZoom,
        this.map.heightInPixels * this.minimapZoom,
      )
      .setZoom(this.minimapZoom)
      .setName("minimap");
    this.minimap.setBackgroundColor(0x002244);
    this.minimap.setBounds(
      0,
      0,
      this.map.widthInPixels,
      this.map.heightInPixels,
    );
  }

  /** Old editorScene.ts:2365-2370, verbatim. */
  private removeMinimap() {
    if (this.minimap) {
      this.cameras.remove(this.minimap);
      this.minimap = null;
    }
  }

  /** Is the old-style minimap showing (U toggles it with the UI)? */
  get minimapVisible(): boolean {
    return this.minimap !== null;
  }

  private buildApi(): EditorApi {
    const scene = this;
    return {
      model: this.deps.model,
      game: this.game,
      scene: this,
      camera: this.camera,
      modes: this.deps.modes,
      playSettings: this.deps.settings,
      config: this.deps.config,
      statusSlot: this.deps.statusSlot,
      stage: this.deps.stage,
      log: this.deps.log,
      isPlaying: () => scene.isPlaying,
      isStrokeActive: () => scene.painter.isActive,
      on<K extends EditorEventName>(name: K, fn: (p: EditorEvents[K]) => void) {
        return scene.events2.on(name, fn);
      },
      setHistoryProvider: (fn) => {
        scene.historyProvider = fn;
      },
      savedPlaySettings: () => scene.savedPlaySettings(),
      notify: (text, opts) => scene.deps.notify(text, opts),
    };
  }

  private tornDown = false;

  private teardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    for (const c of this.cleanups.splice(0)) c();
    this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.pointer?.destroy();
    this.levelRenderer?.destroy();
    retractEditorApi();
  }
}
