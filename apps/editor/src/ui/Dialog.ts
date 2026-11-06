/**
 * A minimal modal dialog. While one is open the editor's shortcuts are off.
 *
 * Old glass style: the box is the old panel (.pt-chatbox values, styles/editor.css
 * .pg-dialog), its head is the old panel header (.pt-chatbox-header with the
 * .pt-brand title), its close button an old .pt-tab, and its body the old
 * Controls tab body (.pt-controls-content), so h3 headings and
 * .control-item / .control-key / .control-desc rows look as they did there.
 */
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
  // Centre the box over the level canvas (not the whole window, which has the
  // side panel on the right and looks off-centre). The backdrop still dims everything.
  const centreOnStage = () => {
    const r = document.getElementById("pg-stage")?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) {
      backdrop.style.padding = "";
      return;
    }
    const px = (n: number) => `${Math.max(0, Math.round(n))}px`;
    backdrop.style.padding = `${px(r.top)} ${px(window.innerWidth - r.right)} ${px(window.innerHeight - r.bottom)} ${px(r.left)}`;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", centreOnStage);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const body = h("div", { class: "pt-controls-content pg-dialog-body", style: "display: flex" });
  const dialog = h(
    "div",
    { class: `pg-dialog${opts.wide ? " pg-dialog-wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title, id: opts.id },
    h(
      "div",
      { class: "pt-chatbox-header pg-dialog-head" },
      h("h2", { class: "pt-brand", text: `✦ ${title}` }),
      h("button", { class: "pt-tab pg-dialog-close", type: "button", "aria-label": "Close", text: "×", onclick: close }),
    ),
    body,
  );
  const backdrop = h("div", { class: "pg-backdrop", onmousedown: (e: Event) => e.target === backdrop && close() }, dialog);
  document.body.append(backdrop);
  openCount++;
  centreOnStage();
  window.addEventListener("resize", centreOnStage);
  document.addEventListener("keydown", onKey, true);
  build(body, close);
  const first = dialog.querySelector<HTMLElement>("textarea, input, button.pg-btn-primary");
  first?.focus({ preventScroll: true });
  return { el: dialog, body, close };
}

/** Old pill classes for dialog buttons: neutral .pt-tbtn, primary in the old Save green. */
export const BTN = "pt-tbtn pg-btn";
export const BTN_PRIMARY = "pt-tbtn pt-tbtn-save pg-btn pg-btn-primary";
