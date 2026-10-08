/**
 * Mounts the chrome (ui/Chrome.ts): the old Pewter Platformer right panel
 * and bottom toolbar.
 *
 * The old UIScene put both over the canvas as Phaser DOM elements (panel at
 * (1095, 360), toolbar at (460, 692)), which blocked drawing under them
 * (audit UX-04). Here they go into page slots beside and below the canvas
 * (index.html #pg-panel-slot, #pg-toolbar-slot), so nothing covers the
 * drawing area. Looks and markup are unchanged.
 *
 * Kept from the old app: U (without Ctrl) toggles both plus the minimap
 * (old lines 247-281). Play hides them (the old app stopped UIScene). Hidden
 * chrome keeps its space, so the canvas never moves.
 */
import Phaser from "phaser";
import { isTypingTarget } from "../editor/keys";
import type { Chrome } from "./Chrome";
import { isDialogOpen } from "./Dialog";

export const CHROME_SCENE = "ChromeScene";

export class ChromeScene extends Phaser.Scene {
  private panelSlot: HTMLElement | null = null;
  private toolbarSlot: HTMLElement | null = null;
  private isChatVisible = true;
  private playing = false;

  constructor(private readonly chrome: Chrome) {
    super({ key: CHROME_SCENE, active: true });
  }

  create(): void {
    this.panelSlot = document.getElementById("pg-panel-slot");
    this.toolbarSlot = document.getElementById("pg-toolbar-slot");
    // Fallback for pages without the slots: next to the game's parent.
    const host = this.game.canvas?.parentElement?.parentElement ?? document.body;
    if (!this.panelSlot) {
      this.panelSlot = document.createElement("div");
      this.panelSlot.id = "pg-panel-slot";
      host.append(this.panelSlot);
    }
    if (!this.toolbarSlot) {
      this.toolbarSlot = document.createElement("div");
      this.toolbarSlot.id = "pg-toolbar-slot";
      host.append(this.toolbarSlot);
    }
    this.panelSlot.append(this.chrome.panelNode);
    this.toolbarSlot.append(this.chrome.toolbarNode);
    this.apply();

    // Toggle UI (and notify other scenes to toggle overview/minimap)
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "u" || e.ctrlKey || e.metaKey || e.altKey) return; // ignore Ctrl+U
      if (this.playing || isDialogOpen() || isTypingTarget(e.target)) return;
      this.isChatVisible = !this.isChatVisible;
      this.apply();
      try {
        this.game.events.emit("ui:toggleMinimap", this.isChatVisible);
      } catch (err) {
        // ignore
      }
    };
    document.addEventListener("keydown", onKey);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => document.removeEventListener("keydown", onKey));
  }

  /** Play hides the panel and toolbar (the old app stopped UIScene). */
  setPlaying(on: boolean): void {
    this.playing = on;
    // Leaving Play restarts the old UIScene, which always came back visible.
    if (!on) this.isChatVisible = true;
    this.apply();
  }

  private apply(): void {
    const show = this.isChatVisible && !this.playing;
    this.panelSlot?.classList.toggle("pg-hidden", !show);
    this.toolbarSlot?.classList.toggle("pg-hidden", !show);
  }
}
