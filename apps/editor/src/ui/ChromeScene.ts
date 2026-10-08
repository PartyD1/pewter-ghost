/**
 * Mounts the chrome (ui/Chrome.ts) over the canvas the way the old
 * Pewter Platformer UIScene did (pewter-platfomer src/phaser/UIScene.ts):
 * Phaser DOM elements in the game's DOM container, the panel at
 * (1095, 360) and the toolbar at (460, 692) with depth 1001, and U (without
 * Ctrl) toggling both plus the minimap (old lines 247-281).
 *
 * Changes for Pewter Ghost: the scene starts with the game (active), so the
 * palette is there as soon as the page is; the old app stopped UIScene in
 * Play, here setPlaying() hides the panel and toolbar instead; the U key is
 * a document listener that ignores text fields and open dialogs.
 */
import Phaser from "phaser";
import { isTypingTarget } from "../editor/keys";
import type { Chrome } from "./Chrome";
import { isDialogOpen } from "./Dialog";

export const CHROME_SCENE = "ChromeScene";

export class ChromeScene extends Phaser.Scene {
  private chatBox!: Phaser.GameObjects.DOMElement;
  private toolbarDom!: Phaser.GameObjects.DOMElement;
  private isChatVisible = true;
  private playing = false;

  constructor(private readonly chrome: Chrome) {
    super({ key: CHROME_SCENE, active: true });
  }

  create(): void {
    // Create hidden chatbox (old UIScene.ts:140)
    this.chatBox = this.add.dom(1095, 360, this.chrome.panelNode);
    this.chatBox.setVisible(true);

    // DOM toolbar (old UIScene.ts:517-527)
    this.toolbarDom = this.add.dom(460, 692, this.chrome.toolbarNode);
    this.toolbarDom.setDepth(1001);

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
    if (!this.chatBox || !this.toolbarDom) return;
    const show = this.isChatVisible && !this.playing;
    this.chatBox.setVisible(show);
    this.toolbarDom.setVisible(show);
  }
}
