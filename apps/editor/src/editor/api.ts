/**
 * The editor's public seam for other modules (ghost layer, suggestion
 * manager, research log, e2e tests). The integration builder attaches the
 * ghost session with:
 *
 *   import { registerGhostStarter } from "@app/editor/api";
 *   registerGhostStarter((api) => startGhost(api));   // before or after boot
 *
 * A starter runs once the editor scene is ready (immediately if it already
 * is) and may return a cleanup function. `whenEditorReady()` gives the same
 * object as a promise.
 */
import type Phaser from "phaser";
import type { LogEvent, Point } from "../contracts";
import type { LevelModel } from "../level/LevelModel";
import type { PlaySettings, SuggestionHistorySummary } from "../level/save";
import type { GhostConfig } from "../suggest/config";
import type { Brush, Mode, ModeState } from "./modes";
import type { StrokeInfo } from "./paint";
import type { PlaySettingsStore } from "./playSettings";

export type EditorLogger = (event: LogEvent) => void;

export interface PlayResult {
  reachedGoal: boolean;
  deaths: number;
  coins: number;
  timeMs: number;
}

export interface EditorEvents {
  "stroke:begin": StrokeInfo;
  "stroke:end": StrokeInfo;
  "play:start": void;
  "play:end": PlayResult;
  mode: { mode: Mode; brush: Brush; effective: Mode };
  /** Hovered cell in edit mode (undefined when off the level/canvas). */
  hover: Point | undefined;
  /** The editor loaded a whole level (file, share code, autosave). */
  "level:loaded": { source: "file" | "share" | "autosave" | "new" | "reload"; warnings: string[] };
  /** Undo / redo were applied by the editor. */
  undo: { what: "own" | "ghost" | "mixed"; redo: boolean };
}

export type EditorEventName = keyof EditorEvents;

export interface CameraApi {
  /** Gently bring tile (x, y) into view. Never moves during an active stroke (waits for it to end). */
  nudgeTo(x: number, y: number, opts?: { w?: number; h?: number; durationMs?: number }): void;
  /** Visible tile rect (may extend past the level). */
  viewTiles(): { x: number; y: number; w: number; h: number };
  /** Tile under a screen (canvas) pixel. */
  screenToTile(sx: number, sy: number): Point;
  /** Screen (canvas) pixel of a tile's top-left corner. */
  tileToScreen(x: number, y: number): Point;
  readonly zoom: number;
}

export interface EditorApi {
  readonly model: LevelModel;
  readonly game: Phaser.Game;
  /** The Phaser editor scene: add the ghost layer here at DEPTH.ghost (see constants.ts). */
  readonly scene: Phaser.Scene;
  readonly camera: CameraApi;
  readonly modes: ModeState;
  readonly playSettings: PlaySettingsStore;
  readonly config: GhostConfig;
  /** Mount point for the status strip (#ghost-status). */
  readonly statusSlot: HTMLElement;
  /** The stage element that contains the canvas (for overlays). */
  readonly stage: HTMLElement;
  readonly log: EditorLogger;
  isPlaying(): boolean;
  isStrokeActive(): boolean;
  on<K extends EditorEventName>(name: K, fn: (payload: EditorEvents[K]) => void): () => void;
  /** Supplies the suggestion-history summary written into saves. */
  setHistoryProvider(fn: (() => SuggestionHistorySummary | undefined) | null): void;
  /** Current play settings as saved (undefined when default). */
  savedPlaySettings(): PlaySettings | undefined;
  /** Show a short message in the editor's toast area. */
  notify(text: string, opts?: { kind?: "info" | "warn" | "error"; ms?: number }): void;
}

export type GhostStarter = (api: EditorApi) => void | (() => void);

let readyApi: EditorApi | null = null;
const starters: GhostStarter[] = [];
const cleanups: (() => void)[] = [];
const waiters: ((api: EditorApi) => void)[] = [];

function runStarter(fn: GhostStarter, api: EditorApi): void {
  try {
    const c = fn(api);
    if (typeof c === "function") cleanups.push(c);
  } catch (err) {
    console.error("ghost starter failed", err);
  }
}

/** Register a function to run with the editor API once the editor is ready. */
export function registerGhostStarter(fn: GhostStarter): void {
  starters.push(fn);
  if (readyApi) runStarter(fn, readyApi);
}

export function whenEditorReady(): Promise<EditorApi> {
  if (readyApi) return Promise.resolve(readyApi);
  return new Promise((resolve) => waiters.push(resolve));
}

export function getEditorApi(): EditorApi | null {
  return readyApi;
}

/** Called by the editor scene when it is ready. */
export function publishEditorApi(api: EditorApi): void {
  readyApi = api;
  for (const fn of starters) runStarter(fn, api);
  for (const w of waiters.splice(0)) w(api);
}

/** Called when the game is destroyed (tests, hot reload). */
export function retractEditorApi(): void {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch (err) {
      console.error("ghost cleanup failed", err);
    }
  }
  readyApi = null;
}

/** Tiny typed emitter used by the scene for EditorEvents. */
export class EditorEmitter {
  private map = new Map<EditorEventName, Set<(p: unknown) => void>>();

  on<K extends EditorEventName>(name: K, fn: (payload: EditorEvents[K]) => void): () => void {
    let set = this.map.get(name);
    if (!set) this.map.set(name, (set = new Set()));
    set.add(fn as (p: unknown) => void);
    return () => set!.delete(fn as (p: unknown) => void);
  }

  emit<K extends EditorEventName>(name: K, payload: EditorEvents[K]): void {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`editor listener for ${name} failed`, err);
      }
    }
  }
}
