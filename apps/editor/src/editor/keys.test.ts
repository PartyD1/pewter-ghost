import { describe, expect, it } from "vitest";
import { heldKeyName, isTypingTarget, keyAction, panDirection } from "./keys";

const edit = { playing: false, typing: false };
const play = { playing: true, typing: false };

describe("keyAction", () => {
  it("switches modes with 1-4", () => {
    expect(keyAction({ key: "1" }, edit)).toEqual({ type: "mode", mode: "select" });
    expect(keyAction({ key: "4" }, edit)).toEqual({ type: "mode", mode: "pan" });
  });

  it("undo is Ctrl+Z, redo Ctrl+Shift+Z or Ctrl+Y (Cmd works too)", () => {
    expect(keyAction({ key: "z", ctrlKey: true }, edit)).toEqual({ type: "undo" });
    expect(keyAction({ key: "Z", ctrlKey: true, shiftKey: true }, edit)).toEqual({ type: "redo" });
    expect(keyAction({ key: "y", ctrlKey: true }, edit)).toEqual({ type: "redo" });
    expect(keyAction({ key: "z", metaKey: true }, edit)).toEqual({ type: "undo" });
  });

  it("leaves Tab, Escape and Ctrl+Space to the ghost layer", () => {
    expect(keyAction({ key: "Tab" }, edit)).toBeNull();
    expect(keyAction({ key: "Escape" }, edit)).toBeNull();
    expect(keyAction({ key: " ", ctrlKey: true }, edit)).toBeNull();
  });

  it("ignores keys while typing or with a dialog open", () => {
    expect(keyAction({ key: "1" }, { ...edit, typing: true })).toBeNull();
    expect(keyAction({ key: "z", ctrlKey: true }, { ...edit, dialogOpen: true })).toBeNull();
  });

  it("in Play mode only exit keys apply", () => {
    expect(keyAction({ key: "Escape" }, play)).toEqual({ type: "exitPlay" });
    expect(keyAction({ key: "q" }, play)).toEqual({ type: "exitPlay" });
    expect(keyAction({ key: "1" }, play)).toBeNull();
    expect(keyAction({ key: "z", ctrlKey: true }, play)).toBeNull();
  });

  it("P starts play, ? opens help, Ctrl+S saves, +/- zoom", () => {
    expect(keyAction({ key: "p" }, edit)).toEqual({ type: "play" });
    expect(keyAction({ key: "?" , shiftKey: true }, edit)).toEqual({ type: "help" });
    expect(keyAction({ key: "s", ctrlKey: true }, edit)).toEqual({ type: "save" });
    expect(keyAction({ key: "=" }, edit)).toEqual({ type: "zoom", dir: 1 });
    expect(keyAction({ key: "-" }, edit)).toEqual({ type: "zoom", dir: -1 });
  });

  it("ignores auto-repeat for one-shot keys", () => {
    expect(keyAction({ key: "p", repeat: true }, edit)).toBeNull();
  });
});

describe("panDirection", () => {
  it("combines held WASD and arrows", () => {
    expect(panDirection(new Set(["a"]))).toEqual({ x: -1, y: 0 });
    expect(panDirection(new Set(["d", "ArrowDown"]))).toEqual({ x: 1, y: 1 });
    expect(panDirection(new Set(["a", "d"]))).toEqual({ x: 0, y: 0 });
    expect(heldKeyName("A")).toBe("a");
  });
});

describe("isTypingTarget", () => {
  it("recognises text fields only", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "text" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "range" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "CANVAS" } as unknown as EventTarget)).toBe(false);
  });
});
