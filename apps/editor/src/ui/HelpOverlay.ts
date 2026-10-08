/**
 * Help overlay: the keys that matter, in the old Controls tab's markup
 * (pewter-platfomer src/phaser/UIScene.ts:174-233: h3 headings and
 * .control-item rows of .control-key / .control-desc), inside an old-style
 * glass dialog. It replaces the Controls tab (plan: "Replaced by visible
 * modes and three keys that matter"). Two links at the foot open the Share
 * code and Play settings dialogs.
 */
import { MODE_KEY, MODE_LABEL, MODES } from "../editor/modes";
import { h } from "./dom";
import { BTN, BTN_PRIMARY, openDialog, type DialogHandle } from "./Dialog";

export const HELP_SECTIONS: readonly [string, readonly [string, string][]][] = [
  [
    "Ghost",
    [
      ["Tab", "Keep the ghost suggestion"],
      ["Esc", "Dismiss the ghost suggestion"],
      ["Ctrl + Space", "Ask Pewter for a suggestion now"],
    ],
  ],
  [
    "Editing",
    [
      [MODES.map((m) => MODE_KEY[m]).join(" / "), `${MODES.map((m) => MODE_LABEL[m]).join(" / ")} mode`],
      ["Left Click", "Paint or erase in Paint and Erase modes (drag to continuously place)"],
      ["Space + drag", "Pan (any mode); two-finger drag on a trackpad"],
      ["Ctrl + wheel / pinch", "Zoom"],
      ["WASD / arrows", "Move camera (Press Shift to move faster)"],
      ["Ctrl + Z", "Undo (one ghost = one step)"],
      ["Ctrl + Shift + Z", "Redo"],
      ["Ctrl + S", "Save task"],
      ["U", "Toggle UI"],
      ["?", "This help"],
    ],
  ],
  [
    "Play",
    [
      ["P", "Play / stop"],
      ["R", "Show the checked route (hold, in Play)"],
      ["Esc or Q", "Stop playing"],
    ],
  ],
];

/** Flat list (key, description). */
export const HELP_KEYS: readonly [string, string][] = HELP_SECTIONS.flatMap(([, rows]) => rows);

export interface HelpLinks {
  share: () => void;
  settings: () => void;
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
      const link = (cmd: "share" | "settings", label: string, run?: () => void) =>
        h("button", {
          class: BTN,
          type: "button",
          "data-cmd": cmd,
          text: label,
          onclick: () => {
            close();
            run?.();
          },
        });
      body.append(
        h(
          "div",
          { class: "pg-dialog-actions" },
          link("share", "Share code", links?.share),
          link("settings", "Play settings", links?.settings),
          h("span", { class: "pt-toolbar-spacer" }),
          h("button", { class: BTN_PRIMARY, type: "button", text: "Got it", onclick: close }),
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
