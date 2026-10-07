/** Short messages in the corner of the stage (load warnings, save confirmations, play results). */
import { h } from "./dom";

export type ToastKind = "info" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export class Toasts {
  readonly el: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = h("div", { class: "pg-toasts", role: "status", "aria-live": "polite" });
    parent.append(this.el);
  }

  show(text: string, opts: { kind?: ToastKind; ms?: number; actions?: ToastAction[]; details?: string[] } = {}): HTMLElement {
    const kind = opts.kind ?? "info";
    const close = () => {
      t.classList.add("pg-toast-out");
      setTimeout(() => t.remove(), 180);
    };
    const t = h(
      "div",
      { class: `pg-toast pg-toast-${kind}`, "data-kind": kind },
      h("div", { class: "pg-toast-text", text }),
      opts.details && opts.details.length
        ? h("ul", { class: "pg-toast-details" }, ...opts.details.slice(0, 6).map((d) => h("li", { text: d })))
        : null,
      h(
        "div",
        { class: "pg-toast-actions" },
        ...(opts.actions ?? []).map((a) =>
          h("button", {
            class: "pg-btn pg-btn-small",
            type: "button",
            text: a.label,
            onclick: () => {
              close();
              a.run();
            },
          }),
        ),
        h("button", { class: "pg-btn pg-btn-small pg-btn-quiet", type: "button", "aria-label": "Close", text: "×", onclick: close }),
      ),
    );
    this.el.append(t);
    const ms = opts.ms ?? (kind === "error" ? 0 : 3500);
    if (ms > 0) setTimeout(close, ms);
    return t;
  }
}
