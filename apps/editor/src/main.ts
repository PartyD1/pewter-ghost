/**
 * Pewter Ghost editor boot (G-01): DOM chrome, the level model, and the
 * Phaser game (Loading -> Editor + UI scenes).
 *
 * The fill loop (session.ts, PewterApp) is created with the model: it owns the
 * research log, the session token / condition, the fillers, the agent and the
 * patrol, and starts the ghost session (ghost/session.ts) once the editor is ready.
 *
 * The page is the old Pewter Platformer's (index.html, legacy/style.css,
 * legacy/chatbox.css): the "PEWTER GHOST" label over a fixed 1280x720
 * Phaser CANVAS game (old src/main.ts:63-91), with the old floating panel and
 * bottom toolbar mounted over it by ui/ChromeScene.ts.
 *
 * e2e tests read window.__pewter = { model, scene, game, config, api, modes, settings, app, ghost }.
 * URL flags: ?fresh=1 ignores the autosave (new starter level); ?restore=1
 * restores it in development, where a plain reload starts fresh; ?renderer=webgl forces WebGL
 * (the default is the old app's Canvas renderer; ?renderer=canvas is accepted too);
 * ?filler=llm|stub|none, ?token=, ?proxy=, ?callTimeoutMs= (session.ts); ?dev=1 dev overlay.
 */
import "./legacy/style.css";
import "./legacy/chatbox.css";
import "./style.css";
import Phaser from "phaser";
import type { LogEvent } from "./contracts";
import { LevelModel } from "./level/LevelModel";
import { loadSaveInto, type LoadResult } from "./level/save";
import { decodeShareCode } from "./level/share";
import { applyOverrides, config } from "./suggest/config";
import { registerGhostStarter, whenEditorReady, type EditorApi, type EditorLogger } from "./editor/api";
import { ASSET } from "./editor/constants";
import { EditorScene } from "./editor/EditorScene";
import type { EditorAction } from "./editor/keys";
import { LoadingScene } from "./editor/LoadingScene";
import { ModeState } from "./editor/modes";
import { starterSnapshot } from "./editor/newLevel";
import { PlaySettingsStore } from "./editor/playSettings";
import { bindShortcuts } from "./editor/shortcuts";
import { UIScene } from "./editor/UIScene";
import { startGhost } from "./ghost/session";
import { PewterApp } from "./session";
import { Chrome, suggestLevelOf, SUGGEST_KINDS } from "./ui/Chrome";
import { ChromeScene } from "./ui/ChromeScene";
import { BTN, BTN_PRIMARY, isDialogOpen, openDialog } from "./ui/Dialog";
import { h } from "./ui/dom";
import { toggleHelp } from "./ui/HelpOverlay";
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
      /** The fill loop, session and research log (session.ts). */
      app?: PewterApp;
    };
  }
}

const params = new URLSearchParams(location.search);
/** The Phaser parent inside the old #phaser (index.html). */
const stage = document.getElementById("pg-stage") ?? document.body.appendChild(h("div", { id: "pg-stage" }));
const chrome = new Chrome();
const toasts = new Toasts(chrome.toastSlot);
const notify: EditorApi["notify"] = (text, opts) => {
  toasts.show(text, { kind: opts?.kind, ms: opts?.ms });
};

const model = new LevelModel();
const modes = new ModeState("select");
const settings = new PlaySettingsStore();
const storage = browserStorage();
/** Session, research log, fillers, agent, fill loop and patrol (session.ts). */
const app = new PewterApp({ model });
/** Research log: buffered until the session resolves, then the session's EventLog. */
const log: EditorLogger = (e: LogEvent) => app.log(e);
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

/**
 * Reload behaviour. In development (npm run dev) a plain reload starts a fresh
 * level, which is what testing wants. The autosave comes back only after
 * "Save task" (it reloads into what it saved, the study's per-task step) or
 * with ?restore=1. Production builds restore the autosave on every reload, so
 * a participant who reloads by accident keeps their work. ?fresh=1 always
 * starts fresh.
 */
const RESTORE_ONCE_KEY = "pg-restore-once";
function takeRestoreOnce(): boolean {
  try {
    const v = sessionStorage.getItem(RESTORE_ONCE_KEY) === "1";
    sessionStorage.removeItem(RESTORE_ONCE_KEY);
    return v;
  } catch {
    return false;
  }
}
const restoreOnce = takeRestoreOnce();
const wantRestore =
  params.get("fresh") !== "1" && (!import.meta.env.DEV || restoreOnce || params.get("restore") === "1");

let restored = false;
if (wantRestore) {
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
  statusSlot: chrome.statusSlot,
  stage,
  heldKeys,
  notify,
});

const chromeScene = new ChromeScene(chrome);

// The old game config (pewter-platfomer src/main.ts:61-89): Canvas renderer,
// fixed 1280x720 (no scale mode: the canvas never grows or shrinks), pixel
// art, arcade physics without gravity, and Phaser's DOM container for the
// panel and toolbar. Pewter Ghost adds its own scenes and input options.
const renderResolution = Math.min(window.devicePixelRatio || 1, 2);

const gameConfig: Phaser.Types.Core.GameConfig & { resolution?: number } = {
  type: params.get("renderer") === "webgl" ? Phaser.WEBGL : Phaser.CANVAS,
  resolution: renderResolution,
  render: {
    pixelArt: true,
  },
  physics: {
    default: "arcade",
    arcade: {
      debug: false,
      gravity: {
        x: 0,
        y: 0,
      },
    },
  },
  // 928 = the old 1280 px canvas minus the 340 px panel and a 12 px gap: the
  // panel now sits beside the canvas instead of over it (style.css #pg-frame).
  width: 928,
  height: 720,
  parent: stage,
  scene: [LoadingScene, editorScene, UIScene, chromeScene],
  dom: {
    createContainer: true, //This line enables DOM support for chatbox
  },
  input: { keyboard: true, mouse: { preventDefaultWheel: false } },
  banner: false,
};
const game = new Phaser.Game(gameConfig);

window.__pewter = { model, scene: editorScene, game, config, modes, settings, app };
registerGhostStarter((api) => app.attachEditor(api, startGhost));

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
addEventListener("pagehide", () => {
  autosaver.flush();
  app.unload();
});
addEventListener("beforeunload", () => autosaver.flush());
if (!storage) toasts.show("This browser is not keeping local saves (private mode?). Use Save task to download your level.", { kind: "warn", ms: 8000 });

function doSaveTask(): void {
  if (editorScene.isPlaying) return;
  const r = saveTask(saveSources, storage);
  downloadText(r.fileName, r.text);
  log({ type: "save", t: performance.now(), snapshotId: r.snapshotId });
  void app.flushLog();
  toasts.show(`Saved ${r.fileName}.`);
}

/**
 * "↺ Save task" (the old "↺ Save & Reload", old UIScene.ts:549-552: save,
 * then window.location.reload() after 150 ms). The level comes back from the
 * autosave, so ?fresh=1 is dropped from the address first.
 */
function doSaveTaskAndReload(): void {
  if (editorScene.isPlaying) return;
  doSaveTask();
  autosaver.flush();
  try {
    sessionStorage.setItem(RESTORE_ONCE_KEY, "1");
  } catch {
    /* no sessionStorage: in development the reload starts fresh */
  }
  setTimeout(() => {
    const url = new URL(location.href);
    url.searchParams.delete("fresh");
    if (url.href === location.href) location.reload();
    else location.replace(url.href);
  }, 150);
}

function confirmReload(): void {
  openDialog("Reload from the last Save task?", (body, close) => {
    body.append(
      h("p", { class: "pg-help-lead", text: "The level goes back to exactly what Save task stored. Changes since then, and the undo history, are dropped." }),
      h(
        "div",
        { class: "pg-dialog-actions" },
        h("button", { class: BTN, type: "button", text: "Cancel", onclick: close }),
        h("button", {
          class: BTN_PRIMARY,
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

/** "New level" (Help): the starter level, after a confirm; the autosave is cleared. */
function confirmNewLevel(): void {
  openDialog("Start a new level?", (body, close) => {
    body.append(
      h("p", { class: "pg-help-lead", text: "The level goes back to the starter map. Use Save first to keep this one." }),
      h(
        "div",
        { class: "pg-dialog-actions" },
        h("button", { class: BTN, type: "button", text: "Cancel", onclick: close }),
        h("button", {
          class: BTN_PRIMARY,
          type: "button",
          text: "New level",
          onclick: () => {
            close();
            loadStarter();
            safeRemove(storage, AUTOSAVE_KEY);
            editorScene.events2.emit("level:loaded", { source: "new", warnings: [] });
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
      doSaveTaskAndReload();
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
      toggleHelp(helpLinks);
      break;
  }
}

const helpLinks = {
  share: () => command("share"),
  settings: () => command("settings"),
  reloadSave: () => confirmReload(),
  newLevel: () => confirmNewLevel(),
};

const toolbar = new Toolbar(chrome, (m) => modes.setMode(m), command);
const palette = new Palette(chrome, modes);

// Suggestions switch (plan: off / Finish only / Finish + Extend / all): the
// enabled suggestion kinds, read live by the fill loop and the manager.
chrome.setSuggestLevel(suggestLevelOf(config.kinds));
void app.ready.then(() => chrome.setSuggestLevel(suggestLevelOf(config.kinds)));
chrome.onSuggest((lvl) => {
  applyOverrides({ kinds: { ...SUGGEST_KINDS[lvl] } });
  chrome.setSuggestLevel(lvl);
  app.loop.refresh();
});
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
      toggleHelp(helpLinks);
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
    chromeScene.setPlaying(true);
  });
  api.on("play:end", () => {
    playing = false;
    refreshToolbar();
    chromeScene.setPlaying(false);
  });
  try {
    const src = game.textures.get(ASSET.tiles).getSourceImage() as HTMLCanvasElement;
    palette.setTileImage(src.toDataURL());
  } catch (err) {
    console.error("palette swatches unavailable", err);
  }
  if (restored) toasts.show("Restored your level from the last session.");
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    autosaver.flush();
    app.dispose();
    game.destroy(true);
  });
}
