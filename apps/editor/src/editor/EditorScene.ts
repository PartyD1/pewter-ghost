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
import { ASSET, DEPTH, ENTITY_FRAME, FRAME, SCENE, SKY_COLOR, TILE_PX } from "./constants";
import { panDirection } from "./keys";
import type { ModeState } from "./modes";
import { StrokePainter } from "./paint";
import { PlayController, type PlayHud } from "./play";
import type { PlaySettingsStore } from "./playSettings";
import { PointerBinding } from "./pointer";
import { Renderer } from "./render";

/** Camera pan speed for held WASD / arrows, in screen px per second. */
const KEY_PAN_PX_PER_S = 600;

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
  private cursorGfx!: Phaser.GameObjects.Graphics;
  private cursorPreview!: Phaser.GameObjects.Image;
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

  get isPlaying(): boolean {
    return this.play?.isActive ?? false;
  }

  create(): void {
    const { model, modes } = this.deps;
    buildTextures(this);
    this.cameras.main.setBackgroundColor(SKY_COLOR);
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

    this.cursorGfx = this.add.graphics().setDepth(DEPTH.cursor);
    this.cursorPreview = this.add.image(0, 0, ASSET.tiles, FRAME.GRASS).setOrigin(0, 0).setAlpha(0.5).setDepth(DEPTH.cursor).setVisible(false);

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
      this.play.update(delta);
      return;
    }
    const dir = panDirection(this.deps.heldKeys);
    if ((dir.x || dir.y) && !this.painter.isActive) {
      const fast = this.deps.heldKeys.has("Shift") ? 3 : 1;
      const step = (KEY_PAN_PX_PER_S * fast * delta) / 1000;
      this.camera.panByScreen(dir.x * step, dir.y * step);
    }
    this.camera.update(delta);
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
    const ok = this.play.start();
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

  private drawCursor(): void {
    const g = this.cursorGfx;
    if (!g) return;
    g.clear();
    this.cursorPreview.setVisible(false);
    const cell = this.hover;
    if (!cell || this.isPlaying) return;
    const s = this.deps.modes.snapshot();
    const x = cell.x * TILE_PX;
    const y = cell.y * TILE_PX;
    const color = s.effective === "erase" ? 0xe5484d : s.effective === "paint" ? 0xffffff : s.effective === "pan" ? 0x8899aa : 0x3b82f6;
    g.lineStyle(1, 0x101820, 0.6);
    g.strokeRect(x - 0.5, y - 0.5, TILE_PX + 1, TILE_PX + 1);
    g.lineStyle(1, color, 1);
    g.strokeRect(x + 0.5, y + 0.5, TILE_PX - 1, TILE_PX - 1);
    if (s.effective === "erase") {
      g.lineBetween(x + 3, y + 3, x + TILE_PX - 3, y + TILE_PX - 3);
      g.lineBetween(x + TILE_PX - 3, y + 3, x + 3, y + TILE_PX - 3);
    }
    if (s.effective === "paint") {
      const b = s.brush;
      const frame = b.kind === "tile" ? b.tile : b.kind === "entity" ? ENTITY_FRAME[b.entity] : FRAME.START;
      this.cursorPreview.setFrame(frame).setPosition(x, y).setVisible(true);
    }
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
