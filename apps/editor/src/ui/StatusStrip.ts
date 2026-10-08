/**
 * Ghost status line (G-19), mounted in #ghost-status (ui/Chrome.ts): one
 * short line in the old panel's secondary text style (old chatbox.css
 * .control-desc: 12px, #b0b0d8), never wrapping:
 *
 *  - "staircase · 2 tiles · Tab to keep" while a ghost shows, "quiet ·
 *    Ctrl+Space to ask" otherwise, "playing · R route · Esc to edit" in Play
 *    (plan: "Ghost status · 'staircase · 2 steps · Tab to keep' · or
 *    'quiet' · Ctrl+Space to ask");
 *  - under it, in the same style, what Ghost thinks the level is.
 *
 * What faint and crossed-out tiles mean is in Help. The text comes only
 * from ghost/caption.ts, which never names the study condition or filler.
 */
import { stripText, type StripText, type StripView } from "../ghost/caption";

const STYLE_ID = "pg-status-strip-style";
// Values: old .control-desc (12px, #b0b0d8) and --pt-green for Play. NEW: the
// dashed 10px square before a ghost's line (it echoes the dashed ghost tiles).
const CSS = `
.pg-ghost-strip { display: flex; flex-direction: column; gap: 2px; margin: 0 2px; font-family: var(--pt-font); font-size: 12px; color: #b0b0d8; min-width: 0; }
.pg-ghost-strip > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pg-ghost-strip-main.pg-split { display: flex; align-items: baseline; }
.pg-ghost-strip-main.pg-split > span:first-child { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pg-ghost-strip-main.pg-split > span:last-child { flex-shrink: 0; white-space: pre; }
.pg-ghost-strip[data-tone="ghost"] .pg-ghost-strip-main { color: var(--pt-text); }
.pg-ghost-strip[data-tone="ghost"] .pg-ghost-strip-main::before { content: ""; display: inline-block; flex-shrink: 0; align-self: center; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; border: 1px dashed currentColor; border-radius: 2px; opacity: 0.8; }
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
    const same = this.last && this.last.main === t.main && this.last.guess === t.guess && this.last.tone === t.tone && this.last.tail === t.tail;
    this.last = t;
    if (same) return;
    this.el.dataset.tone = t.tone;
    if (t.tail && t.main.endsWith(t.tail)) {
      // Label (cut with an ellipsis when long) and the key hint, kept whole.
      const doc = this.el.ownerDocument;
      const label = doc.createElement("span");
      label.textContent = t.main.slice(0, t.main.length - t.tail.length);
      const tail = doc.createElement("span");
      tail.textContent = t.tail;
      this.main.replaceChildren(label, tail);
      this.main.classList.add("pg-split");
    } else {
      this.main.textContent = t.main;
      this.main.classList.remove("pg-split");
    }
    this.main.title = t.main;
    this.guess.textContent = t.guess ?? "";
    this.guess.hidden = !t.guess;
  }

  destroy(): void {
    this.el.remove();
    this.mounted = false;
  }
}
