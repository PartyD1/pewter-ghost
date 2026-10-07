/**
 * Ghost status strip (G-19): one line under the toolbar, mounted in
 * #ghost-status.
 *
 *  - left: what Tab does right now ("ghost: staircase · Tab to accept · Esc to
 *    dismiss"), a longer teaching line for the first three ghosts of a
 *    session, "quiet · Ctrl+Space to ask" otherwise, and the route key in Play;
 *  - right: what Ghost thinks the level is (the model's levelGuess).
 *
 * Everything the ghost says on the canvas is also here as text
 * (accessibility). It never names the study condition or the filler: the
 * text comes only from ghost/caption.ts, which drops such words.
 */
import { stripText, type StripText, type StripView } from "../ghost/caption";

const STYLE_ID = "pg-status-strip-style";
const CSS = `
.pg-ghost-strip { display: flex; align-items: center; gap: 12px; min-height: 26px; padding: 3px 12px; font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--pg-muted, #5b6678); }
.pg-ghost-strip-main { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-ghost-strip-guess { flex: 0 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; font-style: italic; }
.pg-ghost-strip[data-tone="ghost"] .pg-ghost-strip-main { color: var(--pg-ink, #1d2738); font-weight: 600; }
.pg-ghost-strip[data-tone="ghost"] .pg-ghost-strip-main::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; border: 1px dashed currentColor; border-radius: 2px; opacity: 0.8; }
.pg-ghost-strip[data-tone="play"] .pg-ghost-strip-main { color: var(--pg-play, #1f9d55); }
`;

function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

export class StatusStrip {
  private readonly el: HTMLDivElement;
  private readonly main: HTMLSpanElement;
  private readonly guess: HTMLSpanElement;
  private last: StripText | null = null;
  private mounted = false;

  constructor(private readonly slot: HTMLElement) {
    const doc = slot.ownerDocument;
    injectStyle(doc);
    this.el = doc.createElement("div");
    this.el.className = "pg-ghost-strip";
    this.el.id = "pg-ghost-strip";
    this.main = doc.createElement("span");
    this.main.className = "pg-ghost-strip-main";
    this.guess = doc.createElement("span");
    this.guess.className = "pg-ghost-strip-guess";
    this.el.append(this.main, this.guess);
  }

  /** Current text (for tests). */
  get text(): StripText | null {
    return this.last;
  }

  render(view: StripView): void {
    const t = stripText(view);
    if (view.mode === "off") {
      // Human-only sessions: nothing at all (the slot hides when empty).
      if (this.mounted) this.el.remove();
      this.mounted = false;
      this.last = t;
      return;
    }
    if (!this.mounted) {
      this.slot.appendChild(this.el);
      this.mounted = true;
    }
    const same = this.last && this.last.main === t.main && this.last.guess === t.guess && this.last.tone === t.tone;
    this.last = t;
    if (same) return;
    this.el.dataset.tone = t.tone;
    this.main.textContent = t.main;
    this.main.title = t.main;
    this.guess.textContent = t.guess ?? "";
    this.guess.hidden = !t.guess;
  }

  destroy(): void {
    this.el.remove();
    this.mounted = false;
  }
}
