/**
 * Short notices (load results, save confirmations, warnings): the old app's
 * temporary message, not a chat bubble. Copied from pewter-platfomer
 * src/phaser/UIScene.ts:313-327 (showTempMessage): one <p class=
 * "pt-temp-message"> at a time (a new one replaces the old), at the foot of
 * the panel where the old chat log showed it, faded over 0.5 s and removed
 * after `ms` (old default 3000). Styled by the old .pt-temp-message rule
 * (legacy/chatbox.css: amber, italic 12px). An error uses the old eraser
 * group's red (style.css .pg-toast-error) and stays a little longer.
 *
 * No buttons: actions that used to sit on notices (Reload from save, Start a
 * new level) are in Help. Warning details go in the text's tooltip.
 * The pg-toast / pg-toast-<kind> classes are kept for the tests.
 */
export type ToastKind = "info" | "warn" | "error";

export class Toasts {
  readonly el: HTMLElement;

  /** `slot`: the panel's #pg-toasts element. */
  constructor(slot: HTMLElement) {
    this.el = slot;
  }

  show(text: string, opts: { kind?: ToastKind; ms?: number; details?: string[] } = {}): HTMLElement {
    const kind = opts.kind ?? "info";
    // Old showTempMessage: remove the existing message first.
    for (const old of this.el.querySelectorAll(".pt-temp-message")) old.remove();
    const msg = document.createElement("p");
    msg.className = `pt-temp-message pg-toast pg-toast-${kind}`;
    msg.dataset.kind = kind;
    msg.textContent = text;
    if (opts.details?.length) msg.title = opts.details.slice(0, 6).join("\n");
    this.el.appendChild(msg);
    const duration = opts.ms ?? (kind === "error" ? 8000 : 3000);
    setTimeout(() => {
      msg.style.transition = "opacity 0.5s";
      msg.style.opacity = "0";
      setTimeout(() => msg.remove(), 500);
    }, duration);
    return msg;
  }
}
