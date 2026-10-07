/** Loads the tileset strips and builds the composite texture, then starts the editor. */
import Phaser from "phaser";
import { buildTextures, preloadAssets } from "./assets";
import { SCENE } from "./constants";

export class LoadingScene extends Phaser.Scene {
  constructor() {
    super({ key: SCENE.loading });
  }

  preload(): void {
    const { width, height } = this.scale;
    const bar = this.add.graphics();
    const label = this.add
      .text(width / 2, height / 2 - 18, "Loading…", { fontFamily: "system-ui, sans-serif", fontSize: "14px", color: "#24324a" })
      .setOrigin(0.5);
    this.load.on(Phaser.Loader.Events.PROGRESS, (v: number) => {
      bar.clear();
      bar.fillStyle(0x24324a, 0.25).fillRect(width / 2 - 100, height / 2, 200, 6);
      bar.fillStyle(0x24324a, 1).fillRect(width / 2 - 100, height / 2, 200 * v, 6);
    });
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      bar.destroy();
      label.destroy();
    });
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      console.error(`could not load ${file.key} (${file.src})`);
    });
    preloadAssets(this);
  }

  create(): void {
    buildTextures(this);
    this.scene.start(SCENE.editor);
  }
}
