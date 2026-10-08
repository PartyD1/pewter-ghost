/**
 * Loads the assets and builds the composite texture, then starts the editor.
 *
 * Like the old Pewter Platformer LoadingScene (pewter-platfomer
 * src/phaser/loadingScene.ts) it draws nothing: no bar, no label. The preload
 * is the old one (assets.ts preloadAssets).
 */
import Phaser from "phaser";
import { buildTextures, preloadAssets } from "./assets";
import { SCENE } from "./constants";

export class LoadingScene extends Phaser.Scene {
  constructor() {
    super({ key: SCENE.loading });
  }

  preload(): void {
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
