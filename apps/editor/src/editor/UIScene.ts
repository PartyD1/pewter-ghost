/**
 * Overlay on the canvas, unaffected by the editor camera's zoom: the Play HUD,
 * the sign bubble in Play, and the Select-mode inspector line.
 *
 * The Play HUD is the old Pewter Platformer one (pewter-platfomer
 * src/phaser/editorScene.ts startGame, lines 395-432, its update at
 * 1220-1229 and its removal at 2252-2273), copied verbatim: a
 * `.pt-play-stats` pill (hearts and coins) at the top-left and
 * `.pt-play-hint-q` key pills at the top-right, styled by legacy/chatbox.css.
 * The old app appended them to Phaser's DOM container; here they go there
 * when the game has one, else to the canvas's parent (the stage).
 *
 * Changes for Pewter Ghost:
 * - The old "B 👁️ OFF" pill (selection-box visibility; Ghost has no boxes) is
 *   the "R Route" pill: hold R to see the checked route. Same markup and
 *   inline `right: 140px`.
 * - "Q Exit" stops Play through EditorScene.stopPlay (old: startEditor).
 * - New element with no old source, built from the old `.pt-play-stats`
 *   class and the old HUD text colour (#e8e4ff kbd): the sign bubble
 *   (top-centre, in Play, only while the knight reads a sign).
 * The old editor had no in-canvas mode pill, hover coordinates or tile
 * inspector, so there are none.
 */
import Phaser from "phaser";
import { SCENE } from "./constants";
import { UI_EVENT, type EditorScene } from "./EditorScene";
import type { PlayHud } from "./play";

export class UIScene extends Phaser.Scene {
  private playStatsEl: HTMLElement | null = null;
  private playHudEl: HTMLElement | null = null;
  private playRouteEl: HTMLElement | null = null;
  private signEl: HTMLElement | null = null;

  constructor() {
    super({ key: SCENE.ui });
  }

  /** The old HUD's parent: Phaser's DOM container, else the canvas's parent. */
  private get overlayParent(): HTMLElement | null {
    return (this.game.domContainer as HTMLElement | null | undefined) ?? this.game.canvas?.parentElement ?? null;
  }

  create(): void {
    const ev = this.game.events;
    const onPlay = (on: boolean) => {
      if (on) this.createPlayHud();
      else this.removePlayHud();
    };
    const onHud = (h: PlayHud) => this.updatePlayHud(h);
    ev.on(UI_EVENT.play, onPlay);
    ev.on(UI_EVENT.hud, onHud);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      ev.off(UI_EVENT.play, onPlay);
      ev.off(UI_EVENT.hud, onHud);
      this.removePlayHud();
    });
  }

  // --- Play HUD (old editorScene.ts:395-432) ----------------------------------

  private createPlayHud(): void {
    this.removePlayHud();
    const parent = this.overlayParent;
    if (!parent) return;

    // Boxes toggle button in play HUD — same style as the Q hint
    // (Pewter Ghost: the R route hint in the old B pill's place.)
    const routeEl = document.createElement("div");
    routeEl.className = "pt-play-hint-q";
    routeEl.style.right = "140px";
    routeEl.innerHTML = `<kbd>R</kbd><span>Route</span>`;
    routeEl.title = "Hold R to see the checked route";
    parent.appendChild(routeEl);
    this.playRouteEl = routeEl;

    // Floating DOM stats pill — matches the new UI style
    const statsEl = document.createElement("div");
    statsEl.className = "pt-play-stats";
    statsEl.innerHTML = `
      <span class="pt-stat-hearts" id="play-stat-hearts"></span>
      <span class="pt-stat-sep"></span>
      <span class="pt-stat-coins">⬡ <span id="play-stat-coins">0</span></span>
    `;
    parent.appendChild(statsEl);
    this.playStatsEl = statsEl;

    // "Q — exit" key hint in the overlay
    const hintEl = document.createElement("div");
    hintEl.className = "pt-play-hint-q";
    hintEl.innerHTML = `<kbd>Q</kbd><span>Exit</span>`;
    hintEl.addEventListener("click", () => (this.scene.get(SCENE.editor) as EditorScene).stopPlay());
    parent.appendChild(hintEl);
    this.playHudEl = hintEl;

    // New (no old source): the sign bubble, built from the stats pill's class.
    const signEl = document.createElement("div");
    signEl.className = "pt-play-stats pg-play-sign";
    signEl.style.left = "50%";
    signEl.style.transform = "translateX(-50%)";
    signEl.style.top = "60px";
    signEl.style.color = "#e8e4ff";
    signEl.style.fontSize = "14px";
    signEl.style.display = "none";
    parent.appendChild(signEl);
    this.signEl = signEl;
  }

  /** Old editorScene.ts:1220-1229: hearts and the coin count. */
  private updatePlayHud(h: PlayHud): void {
    // Update floating DOM stats pill
    if (this.playStatsEl) {
      const hearts = "♥".repeat(Math.max(0, h.health)) + "♡".repeat(Math.max(0, h.maxHealth - h.health));
      const heartsEl = this.playStatsEl.querySelector("#play-stat-hearts");
      const coinsEl = this.playStatsEl.querySelector("#play-stat-coins");
      if (heartsEl) heartsEl.textContent = hearts;
      if (coinsEl) coinsEl.textContent = String(h.coins);
    }
    if (this.signEl) {
      if (h.sign) {
        this.signEl.textContent = h.sign;
        this.signEl.style.display = "";
      } else this.signEl.style.display = "none";
    }
  }

  /** Old startEditor (editorScene.ts:2252-2273): the HUD elements go away. */
  private removePlayHud(): void {
    for (const el of [this.playStatsEl, this.playHudEl, this.playRouteEl, this.signEl]) el?.remove();
    this.playStatsEl = this.playHudEl = this.playRouteEl = this.signEl = null;
  }
}
