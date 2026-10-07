/**
 * In-canvas overlay, unaffected by the editor camera's zoom: the mode
 * indicator, the hovered cell, the Select-mode inspector line and the Play HUD.
 * Toolbar, palette and dialogs are DOM (ui/); the status strip mounts in
 * #ghost-status (another module).
 */
import Phaser from "phaser";
import type { Point } from "../contracts";
import { SCENE } from "./constants";
import { UI_EVENT } from "./EditorScene";
import { describeMode, type ModeSnapshot } from "./modes";
import type { PlayHud } from "./play";
import { brushLabel } from "../ui/paletteItems";

const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";

export class UIScene extends Phaser.Scene {
  private modeText!: Phaser.GameObjects.Text;
  private hoverText!: Phaser.GameObjects.Text;
  private hudText!: Phaser.GameObjects.Text;
  private signText!: Phaser.GameObjects.Text;
  private playing = false;
  private inspectTimer: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super({ key: SCENE.ui });
  }

  create(): void {
    const pill = { fontFamily: FONT, fontSize: "13px", color: "#f4f7fb", backgroundColor: "#1d2738d9", padding: { x: 8, y: 4 } };
    this.modeText = this.add.text(10, 10, "", { ...pill, fontStyle: "600" }).setName("mode-indicator");
    this.hoverText = this.add.text(10, 0, "", { ...pill, fontSize: "12px" });
    this.hudText = this.add.text(10, 10, "", { ...pill, fontSize: "14px" }).setVisible(false);
    this.signText = this.add.text(0, 0, "", { ...pill, fontSize: "14px", color: "#1d2738", backgroundColor: "#fff7dcf0", padding: { x: 10, y: 6 } }).setOrigin(0.5, 0).setVisible(false);
    this.layout();

    const ev = this.game.events;
    const onMode = (s: ModeSnapshot) => this.modeText.setText(describeMode(s, brushLabel));
    const onHover = (p: Point | undefined) => {
      if (this.inspectTimer) return;
      this.hoverText.setText(p ? `x ${p.x} · y ${p.y}` : "").setVisible(!!p && !this.playing);
    };
    const onInspect = (d: { cell: Point; text: string }) => {
      this.hoverText.setText(d.text).setVisible(true);
      this.inspectTimer?.remove();
      this.inspectTimer = this.time.delayedCall(2500, () => {
        this.inspectTimer = null;
        this.hoverText.setVisible(false);
      });
    };
    const onPlay = (on: boolean) => {
      this.playing = on;
      this.modeText.setVisible(!on);
      this.hoverText.setVisible(false);
      this.hudText.setVisible(on);
      this.signText.setVisible(false);
    };
    const onHud = (h: PlayHud) => {
      const hearts = "♥".repeat(h.health) + "♡".repeat(Math.max(0, h.maxHealth - h.health));
      const secs = (h.timeMs / 1000).toFixed(1);
      const goal = h.hasGoal ? "" : "   no goal flag yet";
      this.hudText.setText(`${hearts}   coins ${h.coins}/${h.coinsTotal}   deaths ${h.deaths}   ${secs}s${goal}   Esc / Q to stop`);
      if (h.sign) this.signText.setText(h.sign).setVisible(true);
      else this.signText.setVisible(false);
    };
    ev.on(UI_EVENT.mode, onMode);
    ev.on(UI_EVENT.hover, onHover);
    ev.on(UI_EVENT.inspect, onInspect);
    ev.on(UI_EVENT.play, onPlay);
    ev.on(UI_EVENT.hud, onHud);
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      ev.off(UI_EVENT.mode, onMode);
      ev.off(UI_EVENT.hover, onHover);
      ev.off(UI_EVENT.inspect, onInspect);
      ev.off(UI_EVENT.play, onPlay);
      ev.off(UI_EVENT.hud, onHud);
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
    });
  }

  private layout(): void {
    const { width, height } = this.scale;
    this.hoverText?.setPosition(10, height - 34);
    this.signText?.setPosition(width / 2, 48);
  }
}
