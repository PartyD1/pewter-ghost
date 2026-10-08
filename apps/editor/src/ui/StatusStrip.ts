/**
 * Ghost status strip (G-19): the status line in the panel, mounted in
 * #ghost-status (ui/Chrome.ts), in the old panel's text style: the main line
 * is the old AI bubble's text (.pt-msg-ai: 13.5px / 1.6, --pt-text, bold
 * 600 as old markdown), the guess and the quiet line the old
 * .control-desc grey (#b0b0d8, 12px), Play in --pt-green.
 *
 *  - first line: what Tab does right now ("ghost: staircase · Tab to accept · Esc to
 *    dismiss"), a longer teaching line for the first three ghosts of a
 *    session, "quiet · Ctrl+Space to ask" otherwise, and the route key in Play;
 *  - second line: what Ghost thinks the level is (the model's levelGuess).
 *
 * Everything the ghost says on the canvas is also here as text
 * (accessibility). It never names the study condition or the filler: the
 * text comes only from ghost/caption.ts, which drops such words.
 */
import { stripText, type StripText, type StripView } from "../ghost/caption";

const STYLE_ID = "pg-status-strip-style";
const CSS = `
.pg-ghost-strip { display: flex; flex-direction: column; gap: 2px; margin: 0 2px; font-family: var(--pt-font); }
.pg-ghost-strip-main { font-size: 13.5px; line-height: 1.6; color: var(--pt-text); word-break: break-word; }
.pg-ghost-strip-guess { font-size: 12px; color: #b0b0d8; }
.pg-ghost-strip[data-tone="quiet"] .pg-ghost-strip-main { color: #b0b0d8; }
.pg-ghost-strip[data-tone="ghost"] .pg-ghost-strip-main { font-weight: 600; }
.pg-ghost-strip[data-tone="ghost"] .pg-ghost-strip-main::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; border: 1px dashed currentColor; border-radius: 2px; opacity: 0.8; }
.pg-ghost-strip[data-tone="play"] .pg-ghost-strip-main { color: var(--pt-green); }
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
