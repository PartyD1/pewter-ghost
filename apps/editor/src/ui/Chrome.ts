/**
 * The editor chrome: the old Pewter Platformer right panel and bottom
 * toolbar, mounted over the canvas by ChromeScene exactly where the old
 * UIScene put them (panel: this.add.dom(1095, 360); toolbar:
 * this.add.dom(460, 692).setDepth(1001)).
 *
 * The markup is copied from pewter-platfomer src/phaser/UIScene.ts create()
 * (lines 140-236 and 517-526) and styled by legacy/chatbox.css. Changes for
 * Pewter Ghost, per docs/PLAN.md ("Proposed Information Architecture",
 * "Keep, Fix, or Drop"):
 * - No chat: the Chat tab, chat log, typing indicator and chat input are gone.
 * - No tabs at all: the Blocks tab's content is shown directly in the panel
 *   (the old Controls tab is replaced by Help and the visible modes).
 * - "Empty" (a selection-box tool) is gone from the eraser group; the
 *   Markers group (Start, Goal flag, Sign) follows Enemies with the same
 *   markup as its siblings.
 * - Below the palette, in the old chat input area's place and style
 *   (.pt-chat-input-area): the ghost status line (#ghost-status) and the
 *   suggestions switch, whose buttons are the old .pt-tab buttons.
 * - Toolbar: "✕ Deselect" is gone (no selection boxes); "? Help" is the
 *   neutral .pt-tbtn pill (Deselect's style); "↺ Save & Reload" is
 *   "↺ Save task". The four modes, and Undo / Redo, are each one neutral
 *   pill holding old .pt-tab buttons (the active mode is the old active
 *   tab): eleven separate 20px-padded pills do not fit the old 910px row
 *   left of the panel (measured 1037px), two groups do (about 880px).
 * - data-cmd / data-mode / data-item attributes are the ones the tests use.
 */
import type { GhostConfig } from "../suggest/config";

// Set the CSS variable for the tileset background-image once at module load so
// the correct absolute URL is used regardless of whether CSS is injected (dev)
// or extracted to an assets sub-directory (production build).
// (Verbatim from old UIScene.ts:12-18.)
document.documentElement.style.setProperty(
  "--pt-tileset-url",
  `url("${import.meta.env.BASE_URL}phaserAssets/pewterPlatformerTilesetExtended.png")`,
);

/** The old UIScene's panel markup (lines 141-236), chat and tabs removed. */
export const PANEL_HTML = `
      <div id="chatbox" class="pt-chatbox">
        <div class="pt-chatbox-header">
          <span class="pt-brand">✦ pewter</span>
        </div>
        <div id="tab-contents" class="pt-tab-contents">
          <div id="blocks-content" class="pt-blocks-content" style="display: flex">
            <div class="pt-blocks-group">
              <div id="blocks-list-eraser" class="pt-blocks-list"></div>
            </div>
            <div class="pt-blocks-group">
              <h4 class="pt-blocks-heading">Collectables</h4>
              <div id="blocks-list-collectables" class="pt-blocks-list"></div>
            </div>
            <div class="pt-blocks-group">
              <h4 class="pt-blocks-heading">Blocks</h4>
              <div id="blocks-list-terrain" class="pt-blocks-list"></div>
            </div>
            <div class="pt-blocks-group">
              <h4 class="pt-blocks-heading">Enemies</h4>
              <div id="blocks-list-enemies" class="pt-blocks-list"></div>
            </div>
            <div class="pt-blocks-group">
              <h4 class="pt-blocks-heading">Markers</h4>
              <div id="blocks-list-markers" class="pt-blocks-list"></div>
              <input id="pg-sign-text" class="pt-chat-input pg-sign-text" type="text" maxlength="120" placeholder="Sign text" aria-label="Text for new signs" value="Hello!" autocomplete="off" hidden />
            </div>
          </div>
          <div id="pg-toasts" class="pg-toasts" role="status" aria-live="polite"></div>
          <div id="ghost-content" class="pt-chat-input-area pg-ghost-area">
            <div id="ghost-status" aria-live="polite"></div>
            <h4 class="pt-blocks-heading">Suggestions</h4>
            <div class="pt-tabs-inline pg-suggest-switch" role="radiogroup" aria-label="Suggestions">
              <button class="pt-tab" type="button" role="radio" data-suggest="off">Off</button>
              <button class="pt-tab" type="button" role="radio" data-suggest="finish">Finish only</button>
              <button class="pt-tab" type="button" role="radio" data-suggest="extend">Finish + Extend</button>
              <button class="pt-tab active" type="button" role="radio" data-suggest="all">All</button>
            </div>
          </div>
        </div>
      </div>
    `;

/** The old UIScene's toolbar markup (lines 517-526), Ghost buttons added. */
export const TOOLBAR_HTML = `
      <div class="pt-toolbar">
        <button class="pt-tbtn pt-tbtn-play" id="tbtn-play" data-cmd="play" title="Play the level (P)">▶ Play</button>
        <div class="pt-tbtn pg-tbtn-group" role="radiogroup" aria-label="Tool mode">
          <button class="pt-tab" id="tbtn-select" type="button" data-mode="select" role="radio" title="Select (1)">Select</button>
          <button class="pt-tab" id="tbtn-paint" type="button" data-mode="paint" role="radio" title="Paint (2)">Paint</button>
          <button class="pt-tab" id="tbtn-erase" type="button" data-mode="erase" role="radio" title="Erase (3)">Erase</button>
          <button class="pt-tab" id="tbtn-pan" type="button" data-mode="pan" role="radio" title="Pan (4, or hold Space)">Pan</button>
        </div>
        <div class="pt-toolbar-spacer"></div>
        <div class="pt-tbtn pg-tbtn-group">
          <button class="pt-tab" id="tbtn-undo" type="button" data-cmd="undo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
          <button class="pt-tab" id="tbtn-redo" type="button" data-cmd="redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
        </div>
        <button class="pt-tbtn pt-tbtn-save" id="tbtn-save" data-cmd="save" title="Download the level and keep a copy in this browser (Ctrl+S)">💾 Save</button>
        <button class="pt-tbtn pt-tbtn-load" id="tbtn-load" data-cmd="load" title="Open a saved level file">📂 Load</button>
        <button class="pt-tbtn pt-tbtn-reload" id="tbtn-reload" data-cmd="reload" title="Save the task file, then reload">↺ Save task</button>
        <button class="pt-tbtn" id="tbtn-help" data-cmd="help" title="Keys, share code, play settings (?)">? Help</button>
      </div>
    `;

export type SuggestLevel = "off" | "finish" | "extend" | "all";

/** The suggestions switch (plan: off / Finish only / Finish + Extend / all) as config.kinds. */
export const SUGGEST_KINDS: Record<SuggestLevel, GhostConfig["kinds"]> = {
  off: { finish: false, extend: false, fix: false },
  finish: { finish: true, extend: false, fix: false },
  extend: { finish: true, extend: true, fix: false },
  all: { finish: true, extend: true, fix: true },
};

/** Which switch position config.kinds is in (anything else reads as "all"). */
export function suggestLevelOf(k: GhostConfig["kinds"]): SuggestLevel {
  for (const [lvl, v] of Object.entries(SUGGEST_KINDS) as [SuggestLevel, GhostConfig["kinds"]][])
    if (v.finish === k.finish && v.extend === k.extend && v.fix === k.fix) return lvl;
  return "all";
}

/** Build a node the way Phaser's DOMElement.createFromHTML does (a div holding the markup). */
function fromHTML(html: string): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

export class Chrome {
  /** Wrapper of the panel (what the old createFromHTML made). */
  readonly panelNode: HTMLDivElement;
  /** Wrapper of the toolbar. */
  readonly toolbarNode: HTMLDivElement;
  readonly statusSlot: HTMLElement;
  readonly toastSlot: HTMLElement;
  readonly signText: HTMLInputElement;

  constructor() {
    this.panelNode = fromHTML(PANEL_HTML);
    this.toolbarNode = fromHTML(TOOLBAR_HTML);
    this.statusSlot = this.panel("#ghost-status");
    this.toastSlot = this.panel("#pg-toasts");
    this.signText = this.panel<HTMLInputElement>("#pg-sign-text");
  }

  panel<T extends HTMLElement = HTMLElement>(sel: string): T {
    const el = this.panelNode.querySelector<T>(sel);
    if (!el) throw new Error(`chrome: ${sel} missing`);
    return el;
  }

  toolbar<T extends HTMLElement = HTMLElement>(sel: string): T {
    const el = this.toolbarNode.querySelector<T>(sel);
    if (!el) throw new Error(`chrome: ${sel} missing`);
    return el;
  }

  /** Show the switch position. */
  setSuggestLevel(lvl: SuggestLevel): void {
    for (const b of this.panelNode.querySelectorAll<HTMLButtonElement>("[data-suggest]")) {
      const on = b.dataset.suggest === lvl;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    }
  }

  onSuggest(fn: (lvl: SuggestLevel) => void): void {
    for (const b of this.panelNode.querySelectorAll<HTMLButtonElement>("[data-suggest]"))
      b.addEventListener("click", () => fn(b.dataset.suggest as SuggestLevel));
  }
}
