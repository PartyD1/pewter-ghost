/** Help overlay: the few keys that matter. */
import { MODE_KEY, MODE_LABEL, MODES } from "../editor/modes";
import { h } from "./dom";
import { openDialog, type DialogHandle } from "./Dialog";

export const HELP_KEYS: readonly [string, string][] = [
  ["Tab", "Keep the ghost suggestion"],
  ["Esc", "Dismiss the ghost suggestion"],
  ["Ctrl + Space", "Ask Pewter for a suggestion now"],
  ...MODES.map((m) => [MODE_KEY[m], `${MODE_LABEL[m]} mode`] as [string, string]),
  ["Space + drag", "Pan (any mode); two-finger drag on a trackpad"],
  ["Ctrl + wheel / pinch", "Zoom"],
  ["W A S D / arrows", "Move the view (Shift = faster)"],
  ["Ctrl + Z", "Undo (one ghost = one step)"],
  ["Ctrl + Shift + Z", "Redo"],
  ["P", "Play / stop"],
  ["Esc or Q", "Stop playing"],
  ["Ctrl + S", "Save task"],
  ["?", "This help"],
];

let current: DialogHandle | null = null;

export function toggleHelp(): void {
  if (current) {
    current.close();
    current = null;
    return;
  }
  current = openDialog(
    "Keys",
    (body, close) => {
      body.append(
        h("p", { class: "pg-help-lead", text: "Draw a level. Pewter suggests the next piece as a faint ghost; press Tab to keep it." }),
        h(
          "table",
          { class: "pg-keys" },
          h("tbody", {}, ...HELP_KEYS.map(([k, d]) => h("tr", {}, h("th", {}, h("kbd", { text: k })), h("td", { text: d })))),
        ),
        h("p", { class: "pg-help-foot", text: "Painting happens only in Paint and Erase modes, with the left button, on the canvas. Select is safe to click around in." }),
        h("div", { class: "pg-dialog-actions" }, h("button", { class: "pg-btn pg-btn-primary", type: "button", text: "Got it", onclick: close })),
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
