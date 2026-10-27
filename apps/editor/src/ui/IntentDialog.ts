/**
 * Level goal dialog: one or two sentences about what the level should be, or a
 * preset to start from. Shown at the start of a new level and from Help.
 */
import { INTENT_MAX_CHARS, INTENT_PRESETS, cleanIntent } from "../fill/intent";
import { h } from "./dom";
import { BTN, BTN_PRIMARY, openDialog } from "./Dialog";

export interface IntentDeps {
  /** The goal now in force ("" = none). */
  current: string;
  /** Called with the cleaned goal ("" clears it). */
  apply: (intent: string) => void;
}

export function openIntentDialog(deps: IntentDeps): void {
  openDialog(
    "What are you building?",
    (body, close) => {
      const box = h("textarea", {
        class: "pt-chat-input pg-code",
        rows: 3,
        maxlength: INTENT_MAX_CHARS,
        placeholder: "e.g. A spooky castle with lots of tricky jumps and a few bats",
        "aria-label": "Describe the level in a sentence or two",
        id: "pg-intent-text",
      });
      box.value = deps.current;
      const chips = INTENT_PRESETS.map((p) =>
        h("button", {
          class: "pt-tab",
          type: "button",
          "data-preset": p.id,
          text: `${p.emoji} ${p.label}`,
          onclick: () => {
            box.value = p.text;
            box.focus();
          },
        }),
      );
      const start = () => {
        deps.apply(cleanIntent(box.value));
        close();
      };
      body.append(
        h("p", { class: "pg-help-lead", text: "Tell the ghost what you're going for, so it doesn't have to guess from your blocks. Pick a preset or write your own." }),
        h("div", { class: "pg-dialog-actions pg-intent-presets" }, ...chips),
        box,
        h(
          "div",
          { class: "pg-dialog-actions" },
          h("button", { class: BTN, type: "button", id: "pg-intent-skip", text: deps.current ? "Clear goal" : "Skip", onclick: () => (deps.apply(""), close()) }),
          h("button", { class: BTN_PRIMARY, type: "button", id: "pg-intent-start", text: "Start", onclick: start }),
        ),
      );
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          start();
        }
      });
    },
    { id: "pg-intent" },
  );
}
