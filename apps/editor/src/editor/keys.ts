/**
 * Editor keyboard shortcuts as a pure mapping, so they can be unit tested.
 *
 * Tab, Esc (while editing) and Ctrl+Space are deliberately NOT mapped here:
 * they belong to the ghost layer (accept / dismiss / ask). The editor never
 * consumes them.
 */
import { modeForKey, type Mode } from "./modes";

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export type EditorAction =
  | { type: "mode"; mode: Mode }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "play" }
  | { type: "exitPlay" }
  | { type: "save" }
  | { type: "help" }
  | { type: "zoom"; dir: 1 | -1 }
  | { type: "zoomReset" };

export interface KeyContext {
  /** Play mode is running. */
  playing: boolean;
  /** Focus is in a text field (inputs keep their keys). */
  typing: boolean;
  /** A modal dialog is open (only its own keys apply). */
  dialogOpen?: boolean;
}

/** Map a keydown to an editor action, or null when the editor ignores it. */
export function keyAction(e: KeyLike, ctx: KeyContext): EditorAction | null {
  if (ctx.typing || ctx.dialogOpen) return null;
  const mod = !!(e.ctrlKey || e.metaKey);
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (ctx.playing) {
    if (!mod && !e.altKey && (k === "Escape" || k === "q")) return { type: "exitPlay" };
    if (!mod && !e.altKey && k === "p" && !e.repeat) return { type: "exitPlay" };
    return null;
  }

  if (mod && !e.altKey) {
    if (k === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (k === "y" && !e.shiftKey) return { type: "redo" };
    if (k === "s" && !e.shiftKey) return { type: "save" };
    if ((k === "=" || k === "+") && !e.shiftKey) return { type: "zoom", dir: 1 };
    if (k === "-") return { type: "zoom", dir: -1 };
    if (k === "0") return { type: "zoomReset" };
    return null;
  }
  if (e.altKey) return null;

  if (e.repeat) return null;
  const mode = modeForKey(e.key);
  if (mode) return { type: "mode", mode };
  if (k === "p") return { type: "play" };
  if (k === "?" || k === "F1" || (k === "h" && !e.shiftKey)) return { type: "help" };
  if (k === "=" || k === "+") return { type: "zoom", dir: 1 };
  if (k === "-" || k === "_") return { type: "zoom", dir: -1 };
  return null;
}

/** Keys that pan the camera while held in edit mode (WASD / arrows). */
export function panDirection(held: ReadonlySet<string>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  if (held.has("a") || held.has("ArrowLeft")) x -= 1;
  if (held.has("d") || held.has("ArrowRight")) x += 1;
  if (held.has("w") || held.has("ArrowUp")) y -= 1;
  if (held.has("s") || held.has("ArrowDown")) y += 1;
  return { x, y };
}

/** Normalise KeyboardEvent.key for the held-key set ("A" -> "a"). */
export const heldKeyName = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

/** True when the event target is a text field (keys belong to it). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== "string") return false;
  const el = t as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(type);
  }
  return el.isContentEditable === true;
}
