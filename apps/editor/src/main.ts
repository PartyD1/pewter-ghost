/**
 * Pewter Ghost editor boot (G-01): DOM chrome, the level model, and the
 * Phaser game (Loading -> Editor + UI scenes).
 *
 * The fill loop (session.ts, PewterApp) is created with the model: it owns the
 * research log, the session token / condition, the fillers, the agent and the
 * patrol, and starts the ghost session (ghost/session.ts) once the editor is ready.
 *
 * The page (index.html, styles/base.css, styles/chrome.css): the "PEWTER GHOST" label over a fixed 1280x720
 * Phaser CANVAS game (old src/main.ts:63-91), with the old floating panel and
 * bottom toolbar mounted over it by ui/ChromeScene.ts.
 *
 * e2e tests read window.__pewter = { model, scene, game, config, api, modes, app, ghost }.
 * URL flags: ?fresh=1 ignores the autosave (new starter level); ?restore=1
 * restores it in development, where a plain reload starts fresh; ?renderer=webgl forces WebGL
 * (the default is the old app's Canvas renderer; ?renderer=canvas is accepted too);
 * ?filler=llm|stub|none, ?token=, ?proxy=, ?callTimeoutMs= (session.ts); ?dev=1 dev overlay.
 */
import "./styles/base.css";
import "./styles/chrome.css";
import "./styles/editor.css";
import Phaser from "phaser";
import type { LogEvent } from "./contracts";
import { LevelModel } from "./level/LevelModel";
import { applyOverrides, config } from "./suggest/config";
import { registerGhostStarter, whenEditorReady, type EditorApi, type EditorLogger } from "./editor/api";
import { ASSET } from "./editor/constants";
import { EditorScene } from "./editor/EditorScene";
import type { EditorAction } from "./editor/keys";
import { LoadingScene } from "./editor/LoadingScene";
import { ModeState } from "./editor/modes";
import { starterSnapshot } from "./editor/newLevel";
import { bindShortcuts } from "./editor/shortcuts";
import { keepStageFitted } from "./editor/stageFit";
import { UIScene } from "./editor/UIScene";
import { startGhost } from "./ghost/session";
import { PewterApp } from "./session";
import { Chrome, suggestLevelOf, SUGGEST_KINDS } from "./ui/Chrome";
import { ChromeScene } from "./ui/ChromeScene";
import { BTN, BTN_PRIMARY, isDialogOpen, openDialog } from "./ui/Dialog";
import { h } from "./ui/dom";
import { toggleHelp } from "./ui/HelpOverlay";
import { openIntentDialog } from "./ui/IntentDialog";
import { Palette } from "./ui/Palette";
import { AutoSaver, browserStorage, restoreAutosave, safeRemove, AUTOSAVE_KEY, type SaveSources } from "./ui/autosave";
import { Toasts } from "./ui/Toast";
import { Toolbar, type ToolbarCommand } from "./ui/Toolbar";
import { variantsEnabled, VariantSwitch } from "./ui/VariantSwitch";
import { TIMING_POLICIES } from "./suggest/timing/policy";

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
}

/**
 * Reload behaviour. In development (npm run dev) a plain reload starts a fresh
 * level, which is what testing wants. The autosave comes back only with
 * ?restore=1. Production builds restore the autosave on every reload, so
 * a participant who reloads by accident keeps their work. ?fresh=1 always
 * starts fresh.
 */
const wantRestore =
  params.get("fresh") !== "1" && (!import.meta.env.DEV || params.get("restore") === "1");

let restored = false;
if (wantRestore) {
  const res = restoreAutosave(model, storage);
  if (res?.ok) {
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
  config,
  log,
  statusSlot: chrome.statusSlot,
  stage,
  heldKeys,
  notify,
});

const chromeScene = new ChromeScene(chrome);

// The old game config (pewter-platfomer src/main.ts:61-89): Canvas renderer,
// fixed game size (no scale mode; editor/stageFit.ts shrinks its CSS size to
// fit the window), pixel art, arcade physics without gravity, and Phaser's DOM container for the
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
  // panel now sits beside the canvas instead of over it (styles/editor.css #pg-frame).
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
// Fit the window: the canvas shrinks (CSS size only) so nothing is cut off.
game.events.once(Phaser.Core.Events.READY, () => {
  keepStageFitted({
    stage: { w: game.scale.width, h: game.scale.height },
    setZoom: (zoom) => game.scale.setZoom(zoom),
  });
});

window.__pewter = { model, scene: editorScene, game, config, modes, app };
registerGhostStarter((api) => app.attachEditor(api, startGhost));

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const saveSources: SaveSources = {
  model,
  history: () => editorScene.historySummary(),
};
const autosaver = new AutoSaver(saveSources, storage, 1000);
model.subscribe(() => autosaver.schedule());
addEventListener("pagehide", () => {
  autosaver.flush();
  app.unload();
});
addEventListener("beforeunload", () => autosaver.flush());
if (!storage) toasts.show("This browser is not keeping local saves (private mode?). Your work will not survive a reload.", { kind: "warn", ms: 8000 });

/** "New level" (Help): the starter level, after a confirm; the autosave is cleared. */
function confirmNewLevel(): void {
  openDialog("Start a new level?", (body, close) => {
    body.append(
      h("p", { class: "pg-help-lead", text: "The level goes back to the starter map. The current level is replaced." }),
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
            app.loop.setIntent("");
            if (app.loop.enabled) askIntent();
          },
        }),
      ),
    );
  });
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
    case "help":
      toggleHelp(helpLinks);
      break;
  }
}

/** The level goal (fill/intent.ts): asked at the start of a level, editable from Help. */
function askIntent(): void {
  openIntentDialog({
    current: app.loop.intent,
    apply: (text) => {
      app.loop.setIntent(text);
      toasts.show(text ? "Goal set. The ghost will aim for it." : "Goal cleared.");
    },
  });
}

const helpLinks = {
  intent: () => askIntent(),
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

// Dev variant switch: filler and timing policy, live (never shown to participants).
const variants: VariantSwitch = new VariantSwitch(chrome.variantGroup, {
  onFiller: (filler) => (app.setVariant({ filler }), refreshVariants()),
  onTiming: (timing) => (app.setVariant({ timing }), refreshVariants()),
});
const refreshVariants = (): void =>
  variants.update({
    filler: app.loop.activeFiller,
    timing: app.timing.policy,
    fillers: app.fillerChoices,
    timings: TIMING_POLICIES,
    unavailable: app.timing.jevReady ? {} : { jev: "needs the proxy: npm run dev" },
  });
if (variantsEnabled(location.search, { devBuild: import.meta.env.DEV, automated: navigator.webdriver === true })) {
  variants.show(true);
  refreshVariants();
  void app.ready.then(refreshVariants);
}
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
    case "help":
      toggleHelp(helpLinks);
      break;
    case "zoom":
      editorScene.zoomBy(a.dir);
      break;
    case "zoomReset":
      editorScene.camera.zoomReset();
      break;
    case "deleteSelection":
      editorScene.deleteSelection();
      break;
    case "copy":
      editorScene.copySelection();
      break;
    case "cut":
      editorScene.copySelection(true);
      break;
    case "paste":
      editorScene.pasteSelection();
      break;
    case "selectAll":
      editorScene.selectAll();
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

// ?intent=<text> sets the goal and skips the question (?intent= alone skips it); otherwise a fresh
// level with the AI on asks for one before the first block.
void app.ready.then(() => {
  if (params.has("intent")) app.loop.setIntent(params.get("intent") ?? "");
  else if (!restored && app.loop.enabled && !isDialogOpen()) askIntent();
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    autosaver.flush();
    app.dispose();
    game.destroy(true);
  });
}
