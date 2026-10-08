/**
 * The block palette, rendered exactly as the old Blocks tab: icon buttons in
 * the #blocks-list-* lists of the panel (ui/Chrome.ts PANEL_HTML).
 *
 * populateBlockGroup is copied from pewter-platfomer src/phaser/UIScene.ts
 * (lines 630-670): the same button markup (a .pt-block-icon span, title and
 * aria-label set to the block's name; the eraser is the text "Eraser 🗑️")
 * and the same "selected" class. Changes for Pewter Ghost:
 * - each button has data-item (the palette id the tests click);
 * - choosing an item sets the brush (or Erase mode) on ModeState, and the
 *   "selected" class follows the mode and brush (so keys 1-4 update it);
 * - items the old palette did not have (Start, Goal flag, Sign) use
 *   the same icon span, cut from the composite pg-tiles texture
 *   (.pg-block-icon-tiles, style.css);
 * - the Sign item shows the "Sign text" group while the sign brush is on.
 */
import type { Brush, ModeState } from "../editor/modes";
import type { Chrome } from "./Chrome";
import { activeItemId, PALETTE_ITEMS, type PaletteItem } from "./paletteItems";

/** Old group lists and their order (old UIScene.ts:32-40), plus the Markers group. "Empty" (a selection-box tool) is dropped (plan: "Selection boxes, Z-levels, Empty markers ... drop"). */
const GROUPS: readonly { list: string; items: readonly string[] }[] = [
  { list: "blocks-list-eraser", items: ["eraser"] },
  { list: "blocks-list-collectables", items: ["coin", "fruit"] },
  { list: "blocks-list-terrain", items: ["grass_half", "dirt", "grass", "question"] },
  { list: "blocks-list-enemies", items: ["slime", "ultraslime"] },
  { list: "blocks-list-markers", items: ["start", "flag", "sign"] },
];

/** The old block names (title / aria-label) and icon classes (old UIScene.ts:632-641). */
const OLD_BLOCK: Record<string, { name: string; icon: string }> = {
  coin: { name: "Coin", icon: "pt-block-icon-coin" },
  fruit: { name: "Fruit", icon: "pt-block-icon-fruit" },
  grass_half: { name: "Grass-Half Block", icon: "pt-block-icon-grass-half" },
  dirt: { name: "Dirt Block", icon: "pt-block-icon-dirt" },
  grass: { name: "Grass Block", icon: "pt-block-icon-grass" },
  question: { name: "Question Block", icon: "pt-block-icon-question" },
  ultraslime: { name: "Ultra Slime", icon: "pt-block-icon-ultra-slime" },
  slime: { name: "Slime Enemy", icon: "pt-block-icon-slime" },
};

export class Palette {
  private buttons = new Map<string, HTMLButtonElement>();
  private readonly root: HTMLElement;
  private readonly signText: HTMLInputElement;
  private readonly signGroup: HTMLElement;

  constructor(
    chrome: Chrome,
    private readonly modes: ModeState,
  ) {
    this.root = chrome.panelNode;
    this.signText = chrome.signText;
    this.signGroup = chrome.signGroup;
    this.signText.addEventListener("input", () => {
      const b = this.modes.brush;
      if (b.kind === "entity" && b.entity === "sign") this.modes.setBrush({ kind: "entity", entity: "sign", text: this.signText.value });
    });
    for (const g of GROUPS) this.populateBlockGroup(chrome.panel<HTMLDivElement>(`#${g.list}`), g.items);
    modes.subscribe((s) => this.update(s.mode, s.brush));
    this.update(modes.mode, modes.brush);
  }

  private populateBlockGroup(container: HTMLDivElement, ids: readonly string[]) {
    container.innerHTML = "";
    for (const id of ids) {
      const item = PALETTE_ITEMS.find((i) => i.id === id);
      if (!item) continue;
      const b = document.createElement("button");
      b.dataset.item = item.id;
      const old = OLD_BLOCK[item.id];
      if (item.action === "erase") {
        b.textContent = "Eraser 🗑️";
      } else if (old) {
        b.innerHTML = `<span class="pt-block-icon ${old.icon}" aria-hidden="true"></span>`;
        b.setAttribute("aria-label", old.name);
        b.title = old.name;
      } else {
        b.innerHTML = `<span class="pt-block-icon pg-block-icon-tiles" aria-hidden="true" style="--frame: ${item.frame}"></span>`;
        b.setAttribute("aria-label", item.label);
        b.title = item.label;
      }

      b.addEventListener("click", () => this.choose(item));
      container.appendChild(b);
      this.buttons.set(item.id, b);
    }
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

  private update(mode: string, brush: Brush): void {
    const active = activeItemId(mode, brush);
    for (const [id, b] of this.buttons) {
      b.classList.toggle("selected", id === active);
      b.setAttribute("aria-pressed", String(id === active));
    }
    this.signGroup.hidden = !(mode === "paint" && brush.kind === "entity" && brush.entity === "sign");
  }

  /** Point the new items' icons at the composite tile texture once Phaser has built it. */
  setTileImage(dataUrl: string): void {
    this.root.style.setProperty("--pg-tiles-url", `url("${dataUrl}")`);
  }
}
