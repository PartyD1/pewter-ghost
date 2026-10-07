/** A minimal modal dialog. While one is open the editor's shortcuts are off. */
import { h } from "./dom";

let openCount = 0;
export const isDialogOpen = (): boolean => openCount > 0;

export interface DialogHandle {
  el: HTMLElement;
  body: HTMLElement;
  close(): void;
}

export function openDialog(title: string, build: (body: HTMLElement, close: () => void) => void, opts: { wide?: boolean; id?: string } = {}): DialogHandle {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const body = h("div", { class: "pg-dialog-body" });
  const dialog = h(
    "div",
    { class: `pg-dialog${opts.wide ? " pg-dialog-wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title, id: opts.id },
    h("div", { class: "pg-dialog-head" }, h("h2", { text: title }), h("button", { class: "pg-btn pg-btn-quiet", type: "button", "aria-label": "Close", text: "×", onclick: close })),
    body,
  );
  const backdrop = h("div", { class: "pg-backdrop", onmousedown: (e: Event) => e.target === backdrop && close() }, dialog);
  document.body.append(backdrop);
  openCount++;
  document.addEventListener("keydown", onKey, true);
  build(body, close);
  const first = dialog.querySelector<HTMLElement>("textarea, input, button.pg-btn-primary");
  first?.focus();
  return { el: dialog, body, close };
}
