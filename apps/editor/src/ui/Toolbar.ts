/**
 * Top bar (G-04, G-08): Select · Paint · Erase · Pan · Undo/Redo · Play ·
 * Save task · Reload · Load · Share code · Settings · Help. The active mode
 * is always visible here (and in the in-canvas indicator).
 */
import { MODE_KEY, MODE_LABEL, MODES, type Mode } from "../editor/modes";
import { h } from "./dom";

export type ToolbarCommand =
  | "undo"
  | "redo"
  | "play"
  | "save"
  | "reload"
  | "load"
  | "share"
  | "settings"
  | "help";

export interface ToolbarState {
  mode: Mode;
  effective: Mode;
  canUndo: boolean;
  canRedo: boolean;
  playing: boolean;
}

const ICON: Record<Mode, string> = { select: "⬚", paint: "✎", erase: "⌫", pan: "✥" };

export class Toolbar {
  readonly el: HTMLElement;
  private modeButtons = new Map<Mode, HTMLButtonElement>();
  private cmdButtons = new Map<ToolbarCommand, HTMLButtonElement>();

  constructor(
    parent: HTMLElement,
    private readonly onMode: (m: Mode) => void,
    private readonly onCommand: (c: ToolbarCommand) => void,
  ) {
    const modeGroup = h("div", { class: "pg-group", role: "radiogroup", "aria-label": "Tool mode" });
    for (const m of MODES) {
      const b = h(
        "button",
        {
          class: "pg-btn pg-mode",
          type: "button",
          role: "radio",
          "data-mode": m,
          title: `${MODE_LABEL[m]} (${MODE_KEY[m]})`,
          onclick: () => this.onMode(m),
        },
        h("span", { class: "pg-icon", "aria-hidden": "true", text: ICON[m] }),
        h("span", { text: MODE_LABEL[m] }),
        h("kbd", { text: MODE_KEY[m] }),
      );
      this.modeButtons.set(m, b);
      modeGroup.append(b);
    }
    const cmd = (c: ToolbarCommand, label: string, title: string, cls = "") => {
      const b = h("button", { class: `pg-btn ${cls}`.trim(), type: "button", "data-cmd": c, title, text: label, onclick: () => this.onCommand(c) });
      this.cmdButtons.set(c, b);
      return b;
    };
    this.el = h(
      "header",
      { class: "pg-toolbar", role: "toolbar", "aria-label": "Editor" },
      h("div", { class: "pg-brand", text: "Pewter Ghost" }),
      modeGroup,
      h("div", { class: "pg-group" }, cmd("undo", "↶ Undo", "Undo (Ctrl+Z)"), cmd("redo", "↷ Redo", "Redo (Ctrl+Shift+Z)")),
      h("div", { class: "pg-group" }, cmd("play", "▶ Play", "Play the level (P)", "pg-btn-play")),
      h(
        "div",
        { class: "pg-group" },
        cmd("save", "Save task", "Download the level and keep a copy in this browser (Ctrl+S)", "pg-btn-primary"),
        cmd("reload", "Reload", "Reload the level from the last Save task"),
        cmd("load", "Load…", "Open a saved level file"),
        cmd("share", "Share code", "Copy the level as a code, or open one"),
      ),
      h("div", { class: "pg-spacer" }),
      h("div", { class: "pg-group" }, cmd("settings", "⚙ Settings", "Play settings: gravity, speed, jump, enemies"), cmd("help", "? Help", "Keys (?)")),
    );
    parent.append(this.el);
  }

  update(s: ToolbarState): void {
    for (const [m, b] of this.modeButtons) {
      const on = m === s.mode;
      b.classList.toggle("pg-active", on);
      b.classList.toggle("pg-temp", m === s.effective && m !== s.mode);
      b.setAttribute("aria-checked", String(on));
      b.disabled = s.playing;
    }
    this.cmdButtons.get("undo")!.disabled = s.playing || !s.canUndo;
    this.cmdButtons.get("redo")!.disabled = s.playing || !s.canRedo;
    const play = this.cmdButtons.get("play")!;
    play.textContent = s.playing ? "■ Stop" : "▶ Play";
    play.classList.toggle("pg-active", s.playing);
    for (const c of ["save", "reload", "load", "share"] as const) this.cmdButtons.get(c)!.disabled = s.playing;
    this.el.classList.toggle("pg-playing", s.playing);
  }
}
