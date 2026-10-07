/**
 * Pewter Ghost editor boot (G-01): DOM chrome, the level model, and the
 * Phaser game (Loading -> Editor + UI scenes).
 *
 * Seam for the ghost session (integration builder):
 *   import { registerGhostStarter } from "@app/editor/api";
 *   registerGhostStarter((api) => startGhost(api));
 * or `await whenEditorReady()`. Both are re-exported here.
 *
 * e2e tests read window.__pewter = { model, scene, game, config, api, modes, settings }.
 * URL flags: ?fresh=1 ignores the autosave (new starter level); ?renderer=canvas forces Canvas.
 */
import "./style.css";
import Phaser from "phaser";
import type { LogEvent } from "./contracts";
import { LevelModel } from "./level/LevelModel";
import { loadSaveInto, type LoadResult } from "./level/save";
import { decodeShareCode } from "./level/share";
import { logEvent } from "./research/log";
import { config } from "./suggest/config";
import { whenEditorReady, type EditorApi, type EditorLogger } from "./editor/api";
import { ASSET } from "./editor/constants";
import { EditorScene } from "./editor/EditorScene";
import type { EditorAction } from "./editor/keys";
import { LoadingScene } from "./editor/LoadingScene";
import { ModeState } from "./editor/modes";
import { starterSnapshot } from "./editor/newLevel";
import { PlaySettingsStore } from "./editor/playSettings";
import { bindShortcuts } from "./editor/shortcuts";
import { UIScene } from "./editor/UIScene";
import { isDialogOpen, openDialog } from "./ui/Dialog";
import { h } from "./ui/dom";
import { toggleHelp } from "./ui/HelpOverlay";
import { buildLayout } from "./ui/layout";
import { Palette } from "./ui/Palette";
import { openPlaySettings } from "./ui/PlaySettingsPanel";
import {
  AutoSaver,
  browserStorage,
  downloadText,
  pickTextFile,
  reloadTask,
  restoreAutosave,
  safeRemove,
  saveTask,
  AUTOSAVE_KEY,
  type SaveSources,
} from "./ui/saveTask";
import { openShareDialog } from "./ui/ShareDialog";
import { Toasts } from "./ui/Toast";
import { Toolbar, type ToolbarCommand } from "./ui/Toolbar";

export { registerGhostStarter, whenEditorReady, getEditorApi } from "./editor/api";
export type { EditorApi, GhostStarter } from "./editor/api";

declare global {
  interface Window {
    __pewter?: {
      model: LevelModel;
      scene: EditorScene;
      game: Phaser.Game;
      config: typeof config;
      modes: ModeState;
      settings: PlaySettingsStore;
      api?: EditorApi;
    };
  }
}

const params = new URLSearchParams(location.search);
const root = document.getElementById("app") ?? document.body.appendChild(h("div", { id: "app" }));
const layout = buildLayout(root);
const toasts = new Toasts(layout.stage);
const notify: EditorApi["notify"] = (text, opts) => {
  toasts.show(text, { kind: opts?.kind, ms: opts?.ms });
};

const model = new LevelModel();
const modes = new ModeState("select");
const settings = new PlaySettingsStore();
const storage = browserStorage();
/** Research log: writes to the active EventLog when the session has one. */
const log: EditorLogger = (e: LogEvent) => logEvent(e);
const heldKeys = new Set<string>();

// ---------------------------------------------------------------------------
// Level at boot: autosave (unless ?fresh) or the starter level.
// ---------------------------------------------------------------------------

function loadStarter(): void {
  model.load(starterSnapshot({ w: model.w, h: model.h }));
  settings.reset();
}

function reportLoad(res: LoadResult, what: string): boolean {
  if (!res.ok) {
    toasts.show(`${what} failed: ${res.error} Nothing was changed.`, { kind: "error" });
    return false;
  }
  settings.replace(res.file.playSettings);
  const migrated = res.migratedFrom === 1 ? " (converted from an old Pewter save)" : "";
  if (res.warnings.length)
    toasts.show(`${what}${migrated} with ${res.warnings.length} warning${res.warnings.length === 1 ? "" : "s"}:`, {
      kind: "warn",
      ms: 9000,
      details: res.warnings,
    });
  else toasts.show(`${what}${migrated}.`);
  return true;
}

let restored = false;
if (params.get("fresh") !== "1") {
  const res = restoreAutosave(model, storage);
  if (res?.ok) {
    settings.replace(res.file.playSettings);
    restored = true;
  } else if (res && !res.ok) {
    toasts.show(`Your last autosave could not be opened: ${res.error} Starting a new level.`, { kind: "error" });
  }
}
if (!restored) loadStarter();

// ---------------------------------------------------------------------------
// Phaser
// ---------------------------------------------------------------------------

const editorScene = new EditorScene({
  model,
  modes,
  settings,
  config,
  log,
  statusSlot: layout.statusSlot,
  stage: layout.stage,
  heldKeys,
  notify,
});

const gameConfig: Phaser.Types.Core.GameConfig = {
  type: params.get("renderer") === "canvas" ? Phaser.CANVAS : Phaser.AUTO,
  parent: layout.stage,
  backgroundColor: "#8fd3ff",
  pixelArt: true,
  scale: { mode: Phaser.Scale.RESIZE, width: layout.stage.clientWidth || 1280, height: layout.stage.clientHeight || 640 },
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  input: { keyboard: true, mouse: { preventDefaultWheel: false } },
  scene: [LoadingScene, editorScene, UIScene],
  banner: false,
};
const game = new Phaser.Game(gameConfig);

window.__pewter = { model, scene: editorScene, game, config, modes, settings };

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const saveSources: SaveSources = {
  model,
  playSettings: () => settings.forSave(),
  history: () => editorScene.historySummary(),
};
const autosaver = new AutoSaver(saveSources, storage, 1000);
model.subscribe(() => autosaver.schedule());
settings.subscribe(() => autosaver.schedule());
addEventListener("pagehide", () => autosaver.flush());
addEventListener("beforeunload", () => autosaver.flush());
if (!storage) toasts.show("This browser is not keeping local saves (private mode?). Use Save task to download your level.", { kind: "warn", ms: 8000 });

function doSaveTask(): void {
  if (editorScene.isPlaying) return;
  const r = saveTask(saveSources, storage);
  downloadText(r.fileName, r.text);
  log({ type: "save", t: performance.now(), snapshotId: r.snapshotId });
  toasts.show(r.storedLocally ? `Saved ${r.fileName}. A copy is kept in this browser.` : `Saved ${r.fileName}.`, {
    ms: 6000,
    actions: r.storedLocally ? [{ label: "Reload from save", run: confirmReload }] : [],
  });
}

function confirmReload(): void {
  openDialog("Reload from the last Save task?", (body, close) => {
    body.append(
      h("p", { class: "pg-help-lead", text: "The level goes back to exactly what Save task stored. Changes since then, and the undo history, are dropped." }),
      h(
        "div",
        { class: "pg-dialog-actions" },
        h("button", { class: "pg-btn", type: "button", text: "Cancel", onclick: close }),
        h("button", {
          class: "pg-btn pg-btn-primary",
          type: "button",
          text: "Reload",
          onclick: () => {
            close();
            if (reportLoad(reloadTask(model, storage), "Reloaded the saved task")) editorScene.events2.emit("level:loaded", { source: "reload", warnings: [] });
          },
        }),
      ),
    );
  });
}

async function doLoad(): Promise<void> {
  const f = await pickTextFile();
  if (!f) return;
  const res = loadSaveInto(model, f.text);
  if (reportLoad(res, `Loaded ${f.name}`) && res.ok) editorScene.events2.emit("level:loaded", { source: "file", warnings: res.warnings });
}

async function openCode(code: string): Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }> {
  const dec = await decodeShareCode(code);
  if (!dec.ok) return dec;
  try {
    const more = model.load(dec.snapshot);
    settings.replace(dec.playSettings);
    const warnings = [...dec.warnings, ...more];
    toasts.show(warnings.length ? `Opened the shared level with ${warnings.length} warning(s).` : "Opened the shared level.", {
      kind: warnings.length ? "warn" : "info",
      details: warnings,
    });
    editorScene.events2.emit("level:loaded", { source: "share", warnings });
    return { ok: true, warnings };
  } catch (err) {
    return { ok: false, error: `That code holds a level this editor cannot open: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Toolbar, palette, shortcuts
// ---------------------------------------------------------------------------

function command(c: ToolbarCommand): void {
  switch (c) {
    case "undo":
      editorScene.undo();
      break;
    case "redo":
      editorScene.redo();
      break;
    case "play":
      editorScene.togglePlay();
      break;
    case "save":
      doSaveTask();
      break;
    case "reload":
      confirmReload();
      break;
    case "load":
      void doLoad();
      break;
    case "share":
      openShareDialog({ model, playSettings: () => settings.forSave(), open: openCode });
      break;
    case "settings":
      openPlaySettings(settings);
      break;
    case "help":
      toggleHelp();
      break;
  }
}

const toolbar = new Toolbar(layout.toolbarSlot, (m) => modes.setMode(m), command);
const palette = new Palette(layout.paletteSlot, modes);
let playing = false;
const refreshToolbar = () =>
  toolbar.update({ mode: modes.mode, effective: modes.effective, canUndo: model.canUndo, canRedo: model.canRedo, playing });
model.subscribe(refreshToolbar);
modes.subscribe(refreshToolbar);
refreshToolbar();

function runAction(a: EditorAction): void {
  switch (a.type) {
    case "mode":
      modes.setMode(a.mode);
      break;
    case "undo":
      editorScene.undo();
      break;
    case "redo":
      editorScene.redo();
      break;
    case "play":
      editorScene.startPlay();
      break;
    case "exitPlay":
      editorScene.stopPlay();
      break;
    case "save":
      doSaveTask();
      break;
    case "help":
      toggleHelp();
      break;
    case "zoom":
      editorScene.zoomBy(a.dir);
      break;
    case "zoomReset":
      editorScene.camera.zoomReset();
      break;
  }
}

bindShortcuts({ modes, isPlaying: () => editorScene.isPlaying, dialogOpen: isDialogOpen, run: runAction, held: heldKeys });

void whenEditorReady().then((api) => {
  if (window.__pewter) window.__pewter.api = api;
  api.on("play:start", () => {
    playing = true;
    refreshToolbar();
  });
  api.on("play:end", () => {
    playing = false;
    refreshToolbar();
  });
  try {
    const src = game.textures.get(ASSET.tiles).getSourceImage() as HTMLCanvasElement;
    palette.setTileImage(src.toDataURL());
  } catch (err) {
    console.error("palette swatches unavailable", err);
  }
  if (restored)
    toasts.show("Restored your level from the last session.", {
      ms: 6000,
      actions: [
        {
          label: "Start a new level",
          run: () => {
            loadStarter();
            safeRemove(storage, AUTOSAVE_KEY);
            editorScene.events2.emit("level:loaded", { source: "new", warnings: [] });
          },
        },
      ],
    });
  else if (!localStorageHintShown()) {
    toasts.show("Draw a level. Grey tiles are suggestions; Tab keeps them. Pick a block on the left and drag on the canvas.", { ms: 8000 });
  }
});

function localStorageHintShown(): boolean {
  try {
    if (!storage) return false;
    const seen = storage.getItem("pewter-ghost:hint") === "1";
    storage.setItem("pewter-ghost:hint", "1");
    return seen;
  } catch {
    return false;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    autosaver.flush();
    game.destroy(true);
  });
}
