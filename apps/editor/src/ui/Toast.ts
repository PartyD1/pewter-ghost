/**
 * Short messages (load warnings, save confirmations, play results), shown in
 * the panel between the palette and the ghost status, as the old app's chat
 * log showed its messages: an info message is an old AI bubble
 * (.pt-msg-ai), a warning is the old amber temporary note
 * (.pt-temp-message), an error is a bubble in the old eraser group's red
 * (style.css). Action and close buttons are the old .pt-tab buttons.
 * The pg-toast* classes are kept for the tests.
 */
import { h } from "./dom";

export type ToastKind = "info" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

const KIND_CLASS: Record<ToastKind, string> = {
  info: "pt-msg-ai",
  warn: "pt-msg-ai pt-temp-message",
  error: "pt-msg-ai",
};

export class Toasts {
  readonly el: HTMLElement;

  /** `slot`: the panel's #pg-toasts element. */
  constructor(slot: HTMLElement) {
    this.el = slot;
  }

  show(text: string, opts: { kind?: ToastKind; ms?: number; actions?: ToastAction[]; details?: string[] } = {}): HTMLElement {
    const kind = opts.kind ?? "info";
    const close = () => {
      // Old temp message fade (old UIScene.ts:322-326): opacity over 0.5 s, then removed.
      t.style.transition = "opacity 0.5s";
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 500);
    };
    const t = h(
      "div",
      { class: `pg-toast pg-toast-${kind} ${KIND_CLASS[kind]}`, "data-kind": kind },
      h("div", { class: "pg-toast-text", text }),
      opts.details && opts.details.length
        ? h("ul", { class: "pg-toast-details" }, ...opts.details.slice(0, 6).map((d) => h("li", { text: d })))
        : null,
      h(
        "div",
        { class: "pg-toast-actions" },
        ...(opts.actions ?? []).map((a) =>
          h("button", {
            class: "pt-tab active",
            type: "button",
            text: a.label,
            onclick: () => {
              close();
              a.run();
            },
          }),
        ),
        h("button", { class: "pt-tab pg-toast-close", type: "button", "aria-label": "Close", text: "×", onclick: close }),
      ),
    );
    this.el.append(t);
    const ms = opts.ms ?? (kind === "error" ? 0 : 3500);
    if (ms > 0) setTimeout(close, ms);
    return t;
  }
}
