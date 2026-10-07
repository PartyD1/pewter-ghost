/**
 * Save task (G-08): save v2 JSON download, localStorage autosave and an
 * explicit reload. Storage access is wrapped: it can throw or be absent in
 * private windows, and the editor must keep working without it.
 *
 * Pure apart from the injected storage and timers, so it is unit tested.
 */
import type { LevelModel } from "../level/LevelModel";
import { loadSaveInto, saveFileName, serializeSave, type LoadResult, type PlaySettings, type SuggestionHistorySummary } from "../level/save";

export const AUTOSAVE_KEY = "pewter-ghost:autosave";
export const TASK_SAVE_KEY = "pewter-ghost:task-save";
export const APP_TAG = "pewter-ghost-editor";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** window.localStorage, or null when it is unavailable/blocked. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__pg_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function safeGet(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemove(storage: StorageLike | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export interface SaveSources {
  model: LevelModel;
  playSettings: () => PlaySettings | undefined;
  history: () => SuggestionHistorySummary | undefined;
  now?: () => Date;
}

export function buildSaveText(src: SaveSources): string {
  const now = src.now?.() ?? new Date();
  return serializeSave(src.model, {
    playSettings: src.playSettings(),
    history: src.history(),
    savedAt: now.toISOString(),
    app: APP_TAG,
  });
}

export interface TaskSaveResult {
  text: string;
  fileName: string;
  /** False when localStorage was unavailable (the download still happens). */
  storedLocally: boolean;
  /** An id for the research log's save event. */
  snapshotId: string;
}

/** The "Save task" button: build the file and keep a local copy for Reload. */
export function saveTask(src: SaveSources, storage: StorageLike | null): TaskSaveResult {
  const now = src.now?.() ?? new Date();
  const text = buildSaveText({ ...src, now: () => now });
  const storedLocally = safeSet(storage, TASK_SAVE_KEY, text);
  safeSet(storage, AUTOSAVE_KEY, text);
  return { text, fileName: saveFileName(now), storedLocally, snapshotId: `r${src.model.revision}-${now.getTime()}` };
}

/** Explicit reload: put the level back exactly as last saved with Save task. */
export function reloadTask(model: LevelModel, storage: StorageLike | null): LoadResult {
  const text = safeGet(storage, TASK_SAVE_KEY);
  if (text === null) return { ok: false, error: "There is no saved task in this browser yet. Use Save task first." };
  return loadSaveInto(model, text);
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Debounced autosave of the whole level to localStorage, so a reload or a
 * crash never loses work. `schedule()` on every change; `flush()` on unload.
 */
export class AutoSaver {
  private handle: unknown = null;
  private dirty = false;
  private _saves = 0;
  private _failures = 0;

  constructor(
    private readonly src: SaveSources,
    private readonly storage: StorageLike | null,
    private readonly debounceMs = 1000,
    private readonly timers: Timers = realTimers,
  ) {}

  get saves(): number {
    return this._saves;
  }

  get failures(): number {
    return this._failures;
  }

  get pending(): boolean {
    return this.dirty;
  }

  schedule(): void {
    this.dirty = true;
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.flush();
    }, this.debounceMs);
  }

  flush(): boolean {
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle);
      this.handle = null;
    }
    if (!this.dirty) return true;
    this.dirty = false;
    let text: string;
    try {
      text = buildSaveText(this.src);
    } catch (err) {
      console.error("autosave failed", err);
      this._failures++;
      return false;
    }
    const ok = safeSet(this.storage, AUTOSAVE_KEY, text);
    if (ok) this._saves++;
    else this._failures++;
    return ok;
  }

  cancel(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
    this.dirty = false;
  }
}

/** Restore the autosave at boot. Returns null when there is none. */
export function restoreAutosave(model: LevelModel, storage: StorageLike | null): LoadResult | null {
  const text = safeGet(storage, AUTOSAVE_KEY);
  if (text === null) return null;
  return loadSaveInto(model, text);
}

/** Download a text file through a temporary link (browser only). */
export function downloadText(fileName: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Ask the person for a file and read it as text; null when cancelled. */
export function pickTextFile(accept = ".json,application/json"): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const done = (v: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (!f) return done(null);
      f.text().then(
        (text) => done({ name: f.name, text }),
        () => done(null),
      );
    });
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
