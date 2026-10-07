/**
 * DOM keyboard binding for the editor. Maps keys through keys.ts, keeps the
 * set of held keys (WASD camera pan) and handles Space-to-pan. Tab, Esc and
 * Ctrl+Space are left alone for the ghost layer.
 */
import { heldKeyName, isTypingTarget, keyAction, type EditorAction } from "./keys";
import type { ModeState } from "./modes";

export interface ShortcutDeps {
  modes: ModeState;
  isPlaying: () => boolean;
  dialogOpen: () => boolean;
  run: (a: EditorAction) => void;
  /** Filled with currently held keys. */
  held: Set<string>;
}

export function bindShortcuts(deps: ShortcutDeps, target: Window = window): () => void {
  const onDown = (e: KeyboardEvent) => {
    const typing = isTypingTarget(e.target);
    const dialogOpen = deps.dialogOpen();
    if (!typing && !dialogOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
      deps.held.add(heldKeyName(e.key));
      if (e.key === "Shift") deps.held.add("Shift");
    }
    if (e.key === " " && !typing && !dialogOpen && !e.ctrlKey && !e.metaKey && !deps.isPlaying()) {
      e.preventDefault(); // no page scroll; Space = temporary pan
      deps.modes.setTempPan(true);
      return;
    }
    const action = keyAction(e, { playing: deps.isPlaying(), typing, dialogOpen });
    if (!action) return;
    e.preventDefault();
    deps.run(action);
  };
  const onUp = (e: KeyboardEvent) => {
    deps.held.delete(heldKeyName(e.key));
    if (e.key === "Shift") deps.held.delete("Shift");
    if (e.key === " ") deps.modes.setTempPan(false);
  };
  const onBlur = () => {
    deps.held.clear();
    deps.modes.setTempPan(false);
  };
  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  target.addEventListener("blur", onBlur);
  return () => {
    target.removeEventListener("keydown", onDown);
    target.removeEventListener("keyup", onUp);
    target.removeEventListener("blur", onBlur);
  };
}
