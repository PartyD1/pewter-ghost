/**
 * Block palette: terrain, collectables, enemies, markers, eraser. Choosing
 * an item selects Paint (or Erase for the eraser). The sign item has a text
 * field for the sign's message.
 */
import type { ModeState } from "../editor/modes";
import { h } from "./dom";
import { activeItemId, GROUP_LABEL, GROUP_ORDER, itemsInGroup, type PaletteItem } from "./paletteItems";

const SWATCH = 32;

export class Palette {
  readonly el: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private signText: HTMLInputElement;

  constructor(
    parent: HTMLElement,
    private readonly modes: ModeState,
  ) {
    this.signText = h("input", {
      class: "pg-sign-text",
      type: "text",
      maxlength: 120,
      placeholder: "Sign text",
      "aria-label": "Text for new signs",
      value: "Hello!",
    });
    this.signText.addEventListener("input", () => {
      const b = this.modes.brush;
      if (b.kind === "entity" && b.entity === "sign") this.modes.setBrush({ kind: "entity", entity: "sign", text: this.signText.value });
    });
    this.el = h("aside", { class: "pg-palette", "aria-label": "Palette" });
    for (const g of GROUP_ORDER) {
      const list = h("div", { class: "pg-palette-list" });
      for (const item of itemsInGroup(g)) list.append(this.button(item));
      this.el.append(h("section", { class: "pg-palette-group" }, h("h4", { text: GROUP_LABEL[g] }), list));
      if (g === "markers") this.el.append(this.signText);
    }
    parent.append(this.el);
    modes.subscribe((s) => this.update(s.mode, s.brush));
    this.update(modes.mode, modes.brush);
  }

  private button(item: PaletteItem): HTMLButtonElement {
    const swatch = h("span", { class: "pg-swatch", "aria-hidden": "true" });
    if (item.frame >= 0) swatch.style.setProperty("--frame", String(item.frame));
    else swatch.classList.add("pg-swatch-eraser");
    const b = h(
      "button",
      {
        class: "pg-palette-item",
        type: "button",
        "data-item": item.id,
        title: item.hint ? `${item.label} — ${item.hint}` : item.label,
        onclick: () => this.choose(item),
      },
      swatch,
      h("span", { class: "pg-palette-label", text: item.label }),
    );
    this.buttons.set(item.id, b);
    return b;
  }

  private choose(item: PaletteItem): void {
    if (item.action === "erase") {
      this.modes.setMode("erase");
      return;
    }
    if (item.action.kind === "entity" && item.action.entity === "sign")
      this.modes.setBrush({ kind: "entity", entity: "sign", text: this.signText.value });
    else this.modes.setBrush(item.action);
  }

  private update(mode: string, brush: Parameters<typeof activeItemId>[1]): void {
    const active = activeItemId(mode, brush);
    for (const [id, b] of this.buttons) {
      b.classList.toggle("pg-active", id === active);
      b.setAttribute("aria-pressed", String(id === active));
    }
    this.signText.hidden = !(brush.kind === "entity" && brush.entity === "sign");
  }

  /** Point the swatches at the composite tile texture once Phaser has built it. */
  setTileImage(dataUrl: string): void {
    this.el.style.setProperty("--pg-tiles-url", `url("${dataUrl}")`);
    this.el.style.setProperty("--pg-swatch", `${SWATCH}px`);
  }
}
