/**
 * The ghost's keys as a pure mapping (G-11, G-19), so they can be unit tested.
 * Bound with DOM listeners (not Phaser keys: the editor removes Phaser keys
 * when Play stops, see the editor's open issues).
 *
 *   Tab          accept the shown ghost (edit mode). While a ghost is shown,
 *                Tab and Shift+Tab never move browser focus.
 *   Esc          dismiss the shown ghost, or cancel a pending Ctrl+Space (edit mode;
 *                in Play, Esc belongs to the editor and stops Play).
 *   Ctrl+Space   ask for a suggestion now (edit mode).
 *   Alt+] / Alt+[  next / previous choice, while a ghost with more than one choice is shown
 *                (by key code, so Option on a Mac works; same keys as VS Code's inline suggestions).
 *   R            in Play mode: show the checked route for the current section.
 *                (P is taken: it stops Play. R = "route".)
 */
export const ROUTE_KEY = "R";

export interface GhostKeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export interface GhostKeyContext {
  /** A ghost is on screen. */
  showing: boolean;
  /** How many choices the shown ghost has (more than 1: Alt+] and Alt+[ cycle them). */
  choices?: number;
  /** Ctrl+Space is waiting for a suggestion. */
  requestPending?: boolean;
  playing: boolean;
  /** Focus is in a text field. */
  typing: boolean;
  dialogOpen: boolean;
}

export type GhostKeyAction = "accept" | "dismiss" | "request" | "next" | "prev" | "route" | "swallow";

/**
 * What a keydown means to the ghost, or null when the ghost ignores it.
 * "swallow" = no action, but preventDefault (keeps Tab focus while shown).
 */
export function ghostKeyAction(e: GhostKeyLike, ctx: GhostKeyContext): GhostKeyAction | null {
  if (ctx.typing || ctx.dialogOpen) return null;
  const ctrl = !!e.ctrlKey;
  const meta = !!e.metaKey;
  const alt = !!e.altKey;
  const isSpace = e.code === "Space" || e.key === " " || e.key === "Spacebar";

  if (ctx.playing) {
    return null;
  }

  if (e.key === "Tab") {
    if (!ctx.showing) return null; // normal focus movement when no ghost is shown
    if (ctrl || meta || alt) return null; // leave browser chords alone (Ctrl+Tab etc.)
    if (e.shiftKey || e.repeat) return "swallow";
    return "accept";
  }
  if (e.key === "Escape" || e.key === "Esc") {
    if (ctrl || meta || alt) return null;
    return ctx.showing || ctx.requestPending ? "dismiss" : null;
  }
  if (alt && !ctrl && !meta && !e.shiftKey && (ctx.choices ?? 0) > 1) {
    if (e.code === "BracketRight" || e.key === "]") return e.repeat ? "swallow" : "next";
    if (e.code === "BracketLeft" || e.key === "[") return e.repeat ? "swallow" : "prev";
  }
  if (isSpace && ctrl && !meta && !alt && !e.shiftKey) return e.repeat ? "swallow" : "request";
  return null;
}
