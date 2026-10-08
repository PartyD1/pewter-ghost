/**
 * Renderer (G-03): the ONLY code that writes Phaser tile layers.
 *
 * It subscribes to LevelModel change diffs and updates the tilemap layer,
 * the entity sprites, the start/goal markers and the enemy patrol marks.
 * A full redraw happens only on load; everything else is diff-driven.
 *
 * Under the level it draws the old Pewter Platformer backdrop: the
 * Background_Layer of pewterPlatformerDefaultMap.json (white sky, cloud edge,
 * light blue, wave edge, dark blue, underground), created with the old
 * editor's own map-loading code. It is decoration only: never part of the
 * LevelModel, saves or collisions.
 * Per decisions.md, entitiesRemoved is processed before entitiesAdded, and
 * LevelChangeEx.entitiesUpdated carries enemies whose patrol span changed.
 */
import Phaser from "phaser";
import type { Entity } from "../contracts";
import { ENEMY_KINDS } from "../contracts";
import type { LevelChangeEx, LevelModel } from "../level/LevelModel";
import { ASSET, DEPTH, ENTITY_FRAME, FRAME, TERRAIN_IDS, TILE_PX, tileFrame } from "./constants";

export interface RendererStats {
  fullRedraws: number;
  diffs: number;
  tileWrites: number;
}

export class Renderer {
  readonly map: Phaser.Tilemaps.Tilemap;
  private readonly layer: Phaser.Tilemaps.TilemapLayer;
  /** The old default map (Tiled JSON), used only for its Background_Layer. */
  readonly defaultMap: Phaser.Tilemaps.Tilemap;
  private readonly backgroundLayer: Phaser.Tilemaps.TilemapLayer;
  private readonly entitySprites = new Map<string, Phaser.GameObjects.Image>();
  private readonly entityData = new Map<string, Entity>();
  private readonly entityLayer: Phaser.GameObjects.Container;
  private readonly patrolGfx: Phaser.GameObjects.Graphics;
  private readonly startMarker: Phaser.GameObjects.Image;
  private readonly goalMarker: Phaser.GameObjects.Image;
  private readonly unsubscribe: () => void;
  private editView = true;
  readonly stats: RendererStats = { fullRedraws: 0, diffs: 0, tileWrites: 0 };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly model: LevelModel,
  ) {
    // --- old editorScene.ts create() (lines 487-512), verbatim apart from
    // this -> scene and this.map -> this.defaultMap; the old Ground_Layer and
    // Collectables_Layer are the level model now (newLevel.ts starterSnapshot).
    this.defaultMap = scene.make.tilemap({ key: "defaultMap" });

    const tileset = this.defaultMap.addTilesetImage(
      "pewterPlatformerTilesetExtended",
      "tileset",
      16,
      16,
      0,
      0,
    )!;

    const extrasTileset = this.defaultMap.addTilesetImage(
      "Extras",
      "extras-tileset",
      16,
      16,
      0,
      0,
    );

    this.backgroundLayer = this.defaultMap.createLayer(
      "Background_Layer",
      extrasTileset ? [tileset, extrasTileset] : tileset,
      0,
      0,
    )!;
    // --- end of the old code ---
    this.backgroundLayer.setDepth(DEPTH.background);

    this.map = scene.make.tilemap({ tileWidth: TILE_PX, tileHeight: TILE_PX, width: model.w, height: model.h });
    const levelTiles = this.map.addTilesetImage(ASSET.tiles, ASSET.tiles, TILE_PX, TILE_PX, 0, 0, 0);
    if (!levelTiles) throw new Error("renderer: tileset texture missing");
    const layer = this.map.createBlankLayer("level", levelTiles, 0, 0, model.w, model.h);
    if (!layer) throw new Error("renderer: could not create the tile layer");
    this.layer = layer;
    this.layer.setDepth(DEPTH.tiles);
    this.layer.setCollision([...TERRAIN_IDS]);

    this.entityLayer = scene.add.container(0, 0).setDepth(DEPTH.entities);
    this.patrolGfx = scene.add.graphics().setDepth(DEPTH.entities - 1);
    this.startMarker = scene.add.image(0, 0, ASSET.tiles, FRAME.START).setOrigin(0, 0).setDepth(DEPTH.markers);
    this.goalMarker = scene.add
      .image(0, 0, ASSET.tiles, FRAME.FLAG)
      .setOrigin(0, 0)
      .setDepth(DEPTH.markers)
      .setAlpha(0.6)
      .setVisible(false);

    this.fullRedraw();
    this.unsubscribe = model.subscribe((c) => this.apply(c));
  }

  /** The tile layer, for Play-mode colliders only. Never write to it outside this class. */
  get collisionLayer(): Phaser.Tilemaps.TilemapLayer {
    return this.layer;
  }

  get widthPx(): number {
    return this.model.w * TILE_PX;
  }

  get heightPx(): number {
    return this.model.h * TILE_PX;
  }

  /**
   * Edit view shows entity sprites, markers and patrols; Play hides them (Play
   * draws live objects). The grid is EditorScene's (drawn per frame, cleared in Play).
   */
  setEditView(on: boolean): void {
    this.editView = on;
    this.entityLayer.setVisible(on);
    this.patrolGfx.setVisible(on);
    this.startMarker.setVisible(on);
    this.goalMarker.setVisible(on && this.model.goal !== undefined);
  }

  destroy(): void {
    this.unsubscribe();
    for (const s of this.entitySprites.values()) s.destroy();
    this.entitySprites.clear();
    this.entityData.clear();
    this.entityLayer.destroy();
    this.patrolGfx.destroy();
    this.startMarker.destroy();
    this.goalMarker.destroy();
    this.map.destroy();
    this.backgroundLayer.destroy();
    this.defaultMap.destroy();
  }

  /** Redraw everything from the model (boot and load only). */
  fullRedraw(): void {
    this.stats.fullRedraws++;
    const m = this.model;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) this.writeTile(x, y, m.tileAt(x, y), false);
    this.layer.calculateFacesWithin(0, 0, m.w, m.h);
    for (const s of this.entitySprites.values()) s.destroy();
    this.entitySprites.clear();
    this.entityData.clear();
    for (const e of m.entities) this.addEntity(e);
    this.placeMarkers();
    this.drawPatrols();
  }

  private apply(c: LevelChangeEx): void {
    if (c.source === "load") {
      this.fullRedraw();
      return;
    }
    this.stats.diffs++;
    for (const cell of c.cells) this.writeTile(cell.x, cell.y, cell.tile, true);
    for (const id of c.entitiesRemoved) this.removeEntity(id);
    for (const e of c.entitiesAdded) this.addEntity(e);
    let patrolsChanged = c.entitiesRemoved.length > 0 || c.entitiesAdded.some((e) => ENEMY_KINDS.has(e.kind));
    for (const e of c.entitiesUpdated ?? []) {
      this.entityData.set(e.id, { ...e });
      const s = this.entitySprites.get(e.id);
      if (s) s.setPosition(e.x * TILE_PX, e.y * TILE_PX);
      patrolsChanged = true;
    }
    if (c.start !== undefined || c.goal !== undefined) this.placeMarkers();
    if (patrolsChanged) this.drawPatrols();
  }

  private writeTile(x: number, y: number, tile: number, faces: boolean): void {
    const frame = tileFrame(tile);
    if (frame < 0) {
      if (this.layer.getTileAt(x, y)) this.layer.removeTileAt(x, y, true, faces);
    } else {
      this.layer.putTileAt(frame, x, y, faces);
    }
    this.stats.tileWrites++;
  }

  private addEntity(e: Entity): void {
    this.removeEntity(e.id);
    const img = this.scene.add.image(e.x * TILE_PX, e.y * TILE_PX, ASSET.tiles, ENTITY_FRAME[e.kind]).setOrigin(0, 0);
    img.setData("entityId", e.id);
    img.setData("kind", e.kind);
    if (e.kind === "sign" && e.text) img.setData("text", e.text);
    this.entityLayer.add(img);
    this.entitySprites.set(e.id, img);
    this.entityData.set(e.id, { ...e, patrol: e.patrol ? [e.patrol[0], e.patrol[1]] : undefined });
  }

  private removeEntity(id: string): void {
    const s = this.entitySprites.get(id);
    if (s) {
      s.destroy();
      this.entitySprites.delete(id);
    }
    this.entityData.delete(id);
  }

  private placeMarkers(): void {
    const st = this.model.start;
    this.startMarker.setPosition(st.x * TILE_PX, st.y * TILE_PX);
    const g = this.model.goal;
    if (g) this.goalMarker.setPosition(g.x * TILE_PX, g.y * TILE_PX);
    this.goalMarker.setVisible(this.editView && !!g);
  }

  /** A thin dashed line along each enemy's patrol floor, so spans are visible while editing. */
  private drawPatrols(): void {
    const g = this.patrolGfx;
    g.clear();
    for (const e of this.entityData.values()) {
      if (!ENEMY_KINDS.has(e.kind)) continue;
      const color = e.kind === "slime" ? 0x9be15d : 0xff6fae;
      if (!e.patrol) {
        // No floor: warn with a small red cross under the enemy.
        g.lineStyle(1, 0xd23c3c, 0.9);
        const cx = e.x * TILE_PX + TILE_PX / 2;
        const cy = (e.y + 1) * TILE_PX + 3;
        g.lineBetween(cx - 3, cy - 3, cx + 3, cy + 3);
        g.lineBetween(cx + 3, cy - 3, cx - 3, cy + 3);
        continue;
      }
      const y = (e.y + 1) * TILE_PX - 1.5;
      const x0 = e.patrol[0] * TILE_PX + 1;
      const x1 = (e.patrol[1] + 1) * TILE_PX - 1;
      g.lineStyle(1, color, 0.9);
      for (let x = x0; x < x1; x += 4) g.lineBetween(x, y, Math.min(x + 2, x1), y);
      g.fillStyle(color, 0.9);
      g.fillRect(x0, y - 2, 1, 3);
      g.fillRect(x1 - 1, y - 2, 1, 3);
    }
  }

  /** Entity sprite for an id (e2e tests, ghost layer hit tests). */
  spriteFor(id: string): Phaser.GameObjects.Image | undefined {
    return this.entitySprites.get(id);
  }

  get entitySpriteCount(): number {
    return this.entitySprites.size;
  }
}
