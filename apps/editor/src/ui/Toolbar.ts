/**
 * Behaviour of the bottom toolbar (markup: ui/Chrome.ts TOOLBAR_HTML, the
 * old Pewter Platformer floating pills). The old handlers were click
 * listeners on each #tbtn-* button (old UIScene.ts:529-559); here each
 * button carries data-cmd or data-mode. The active mode pill gets the old
 * tab's "active" class; the Space-pan pill gets "pg-temp".
 */
import { MODES, type Mode } from "../editor/modes";
import type { Chrome } from "./Chrome";

export type ToolbarCommand = "undo" | "redo" | "play" | "save" | "reload" | "load" | "share" | "settings" | "help";

export interface ToolbarState {
  mode: Mode;
  effective: Mode;
  canUndo: boolean;
  canRedo: boolean;
  playing: boolean;
}

export class Toolbar {
  private modeButtons = new Map<Mode, HTMLButtonElement>();
  private cmdButtons = new Map<string, HTMLButtonElement>();

  constructor(
    chrome: Chrome,
    private readonly onMode: (m: Mode) => void,
    private readonly onCommand: (c: ToolbarCommand) => void,
  ) {
    for (const m of MODES) {
      const b = chrome.toolbar<HTMLButtonElement>(`[data-mode="${m}"]`);
      b.addEventListener("click", () => this.onMode(m));
      this.modeButtons.set(m, b);
    }
    for (const b of chrome.toolbarNode.querySelectorAll<HTMLButtonElement>("[data-cmd]")) {
      const c = b.dataset.cmd as ToolbarCommand;
      b.addEventListener("click", () => this.onCommand(c));
      this.cmdButtons.set(c, b);
    }
  }

  update(s: ToolbarState): void {
    for (const [m, b] of this.modeButtons) {
      const on = m === s.mode;
      b.classList.toggle("active", on);
      b.classList.toggle("pg-temp", m === s.effective && m !== s.mode);
      b.setAttribute("aria-checked", String(on));
      b.disabled = s.playing;
    }
    const undo = this.cmdButtons.get("undo");
    const redo = this.cmdButtons.get("redo");
    if (undo) undo.disabled = s.playing || !s.canUndo;
    if (redo) redo.disabled = s.playing || !s.canRedo;
    for (const c of ["save", "reload", "load"]) {
      const b = this.cmdButtons.get(c);
      if (b) b.disabled = s.playing;
    }
  }
}
