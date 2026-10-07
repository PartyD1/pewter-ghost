/**
 * The page skeleton: toolbar, the status-strip slot (#ghost-status, mounted
 * by the status strip module), the palette and the Phaser stage.
 */
import { h } from "./dom";

export interface Layout {
  root: HTMLElement;
  toolbarSlot: HTMLElement;
  statusSlot: HTMLElement;
  main: HTMLElement;
  paletteSlot: HTMLElement;
  stage: HTMLElement;
}

export function buildLayout(root: HTMLElement): Layout {
  root.classList.add("pg-app");
  const toolbarSlot = h("div", { class: "pg-toolbar-slot" });
  // Empty on purpose: the ghost status strip (ui/StatusStrip.ts, G-19) mounts here.
  const statusSlot = h("div", { id: "ghost-status", class: "pg-status-slot", "aria-live": "polite" });
  const paletteSlot = h("div", { class: "pg-palette-slot" });
  const stage = h("div", { id: "pg-stage", class: "pg-stage" });
  const main = h("main", { class: "pg-main" }, paletteSlot, stage);
  root.append(toolbarSlot, statusSlot, main);
  return { root, toolbarSlot, statusSlot, main, paletteSlot, stage };
}
