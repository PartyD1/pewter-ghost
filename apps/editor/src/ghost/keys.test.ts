import { describe, expect, it } from "vitest";
import { ghostKeyAction, type GhostKeyContext } from "./keys";

const edit = (o: Partial<GhostKeyContext> = {}): GhostKeyContext => ({ showing: true, playing: false, typing: false, dialogOpen: false, ...o });

describe("ghostKeyAction", () => {
  it("Tab accepts only while a ghost is shown; otherwise focus moves normally", () => {
    expect(ghostKeyAction({ key: "Tab" }, edit())).toBe("accept");
    expect(ghostKeyAction({ key: "Tab" }, edit({ showing: false }))).toBeNull();
  });

  it("Shift+Tab and repeats are swallowed while shown (focus never moves)", () => {
    expect(ghostKeyAction({ key: "Tab", shiftKey: true }, edit())).toBe("swallow");
    expect(ghostKeyAction({ key: "Tab", repeat: true }, edit())).toBe("swallow");
  });

  it("leaves browser chords alone", () => {
    expect(ghostKeyAction({ key: "Tab", ctrlKey: true }, edit())).toBeNull();
    expect(ghostKeyAction({ key: "Tab", altKey: true }, edit())).toBeNull();
  });

  it("Esc dismisses a shown ghost or a pending request, nothing otherwise", () => {
    expect(ghostKeyAction({ key: "Escape" }, edit())).toBe("dismiss");
    expect(ghostKeyAction({ key: "Escape" }, edit({ showing: false, requestPending: true }))).toBe("dismiss");
    expect(ghostKeyAction({ key: "Escape" }, edit({ showing: false }))).toBeNull();
  });

  it("Ctrl+Space requests (by code or key); plain Space is the editor's pan", () => {
    expect(ghostKeyAction({ key: " ", code: "Space", ctrlKey: true }, edit({ showing: false }))).toBe("request");
    expect(ghostKeyAction({ key: " ", ctrlKey: true }, edit({ showing: false }))).toBe("request");
    expect(ghostKeyAction({ key: " ", code: "Space", ctrlKey: true, repeat: true }, edit())).toBe("swallow");
    expect(ghostKeyAction({ key: " ", code: "Space" }, edit())).toBeNull();
    expect(ghostKeyAction({ key: " ", code: "Space", ctrlKey: true, shiftKey: true }, edit())).toBeNull();
  });

  it("ignores everything while typing or with a dialog open", () => {
    expect(ghostKeyAction({ key: "Tab" }, edit({ typing: true }))).toBeNull();
    expect(ghostKeyAction({ key: "Escape" }, edit({ dialogOpen: true }))).toBeNull();
  });

  it("in Play: R shows the route; Tab, Esc and Ctrl+Space are not the ghost's", () => {
    const play = edit({ playing: true });
    expect(ghostKeyAction({ key: "r" }, play)).toBe("route");
    expect(ghostKeyAction({ key: "R", shiftKey: true }, play)).toBe("route");
    expect(ghostKeyAction({ key: "r", repeat: true }, play)).toBeNull();
    expect(ghostKeyAction({ key: "r", ctrlKey: true }, play)).toBeNull();
    expect(ghostKeyAction({ key: "Tab" }, play)).toBeNull();
    expect(ghostKeyAction({ key: "Escape" }, play)).toBeNull();
    expect(ghostKeyAction({ key: " ", code: "Space", ctrlKey: true }, play)).toBeNull();
    expect(ghostKeyAction({ key: "r" }, edit())).toBeNull();
  });
});
