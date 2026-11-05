/**
 * Help overlay: the keys that matter, in the old Controls tab's markup
 * (pewter-platfomer src/phaser/UIScene.ts:174-233: h3 headings and
 * .control-item rows of .control-key / .control-desc), inside an old-style
 * glass dialog. It replaces the Controls tab (plan: "Replaced by visible
 * modes and three keys that matter"). Links at the foot open the Play
 * settings dialog and the Level goal; and New level holds an
 * action that used to sit on a notice. The footer buttons are old .pt-tab
 * buttons (the old panel's size), "Got it" the old active tab.
 */
import { MODE_KEY, MODE_LABEL, MODES } from "../editor/modes";
import { h } from "./dom";
import { openDialog, type DialogHandle } from "./Dialog";

export const HELP_SECTIONS: readonly [string, readonly [string, string][]][] = [
  [
    "Ghost",
    [
      ["Tab", "Keep the ghost suggestion"],
      ["Esc", "Dismiss the ghost suggestion"],
      ["Alt + ] / Alt + [", "Next / previous choice, when a suggestion has more than one"],
      ["Ctrl + Space", "Ask Pewter for a suggestion now"],
      ["Faint tiles", "A suggestion; paint one to keep only it"],
      ["Crossed out", "Would go if you press Tab"],
    ],
  ],
  [
    "Play",
    [
      ["P", "Play / stop"],
      ["Esc or Q", "Stop playing"],
    ],
  ],
  [
    "Editing",
    [
      [MODES.map((m) => MODE_KEY[m]).join(" / "), `${MODES.map((m) => MODE_LABEL[m]).join(" / ")} mode`],
      ["Ctrl + Z / Ctrl + Shift + Z", "Undo / redo (one ghost = one step)"],
      ["Select: drag", "Box-select a stretch; drag inside the box to move it (hold Alt to copy)"],
      ["Delete", "Delete what is in the selection"],
      ["Ctrl + C / X / V / A", "Copy / cut / paste at the pointer / select the whole level"],
      ["Space + drag", "Pan (any mode); two-finger drag on a trackpad"],
      ["WASD / arrows", "Move camera (Press Shift to move faster)"],
      ["U", "Toggle UI"],
    ],
  ],
];

/** Flat list (key, description). */
export const HELP_KEYS: readonly [string, string][] = HELP_SECTIONS.flatMap(([, rows]) => rows);

export interface HelpLinks {
  intent?: () => void;
  settings: () => void;
  newLevel?: () => void;
}

let current: DialogHandle | null = null;

export function toggleHelp(links?: HelpLinks): void {
  if (current) {
    current.close();
    current = null;
    return;
  }
  current = openDialog(
    "Keys",
    (body, close) => {
      for (const [title, rows] of HELP_SECTIONS) {
        body.append(h("h3", { text: title }));
        for (const [k, d] of rows)
          body.append(h("div", { class: "control-item" }, h("span", { class: "control-key", text: k }), h("span", { class: "control-desc", text: d })));
      }
      const link = (cmd: string, label: string, run?: () => void) =>
        h("button", {
          class: "pt-tab",
          type: "button",
          "data-cmd": cmd,
          text: label,
          onclick: () => {
            close();
            run?.();
          },
        });
      // The footer sits under the scrolling key list, as the old chat input
      // area sat under the chat log.
      body.after(
        h(
          "div",
          { class: "pg-dialog-actions pg-help-links" },
          links?.intent ? link("intent", "Level goal", links.intent) : null,
          link("settings", "Play settings", links?.settings),
          links?.newLevel ? link("new-level", "New level", links.newLevel) : null,
          h("button", { class: "pt-tab active pg-btn-primary pg-help-done", type: "button", text: "Got it", onclick: close }),
        ),
      );
    },
    { id: "pg-help" },
  );
  const el = current.el;
  const observer = new MutationObserver(() => {
    if (!el.isConnected) {
      current = null;
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });
}
