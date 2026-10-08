/**
 * Play mode: the fork's knight (player/playerController.ts, unchanged) in the
 * level being edited, with live enemies, collectables and the goal flag.
 *
 * - Reaching the flag ends Play with reachedGoal = true.
 * - Deaths (health gone or a fall) are counted; the knight respawns at the
 *   start and enemies/collectables reset.
 * - Play settings (G-37) scale gravity, run speed, jump and enemy aggression;
 *   they apply live and are saved with the level.
 * - Emits play.start / play.end through the injected logger.
 *
 * Play never writes to the level model or the tile layer; it reads the
 * renderer's layer for collisions and creates its own live objects.
 */
import Phaser from "phaser";
import { COLLECTABLE_KINDS, ENEMY_KINDS, type Entity } from "../contracts";
import type { LevelModel } from "../level/LevelModel";
import { configurePlayerSprite, PlayerController, WORLD_GRAVITY_Y } from "../player/playerController";
import { JUMP_VELOCITY_PX, MAX_RUN_SPEED_PX, TERMINAL_VELOCITY_PX } from "../player/playerPhysics";
import { isStomp } from "../entities/brains";
import type { EnemyHost, EnemySprite, PelletSpec } from "../entities/EnemySprite";
import { Slime } from "../entities/Slime";
import { UltraSlime } from "../entities/UltraSlime";
import type { EditorLogger, PlayResult } from "./api";
import type { CameraController } from "./camera";
import { ASSET, DEPTH, ENTITY_FRAME, FRAME, TILE_PX } from "./constants";
import {
  enemyTuning,
  playGravity,
  scaledJumpVelocity,
  toBodyVx,
  toControllerVx,
  type EnemyTuning,
  type PlaySettingsStore,
} from "./playSettings";
import type { Renderer } from "./render";

export const MAX_HEALTH = 5;
/** Keys PlayerController registers (createCursorKeys + W,A,S,D). */
const PLAYER_KEY_CODES = [
  Phaser.Input.Keyboard.KeyCodes.UP,
  Phaser.Input.Keyboard.KeyCodes.DOWN,
  Phaser.Input.Keyboard.KeyCodes.LEFT,
  Phaser.Input.Keyboard.KeyCodes.RIGHT,
  Phaser.Input.Keyboard.KeyCodes.SPACE,
  Phaser.Input.Keyboard.KeyCodes.SHIFT,
  Phaser.Input.Keyboard.KeyCodes.W,
  Phaser.Input.Keyboard.KeyCodes.A,
  Phaser.Input.Keyboard.KeyCodes.S,
  Phaser.Input.Keyboard.KeyCodes.D,
];
const INVULNERABLE_MS = 1000;
const RESPAWN_DELAY_MS = 700;
const STOMP_BOUNCE_PX = -360;
const FALL_MARGIN_PX = 3 * TILE_PX;

type Knight = Phaser.Types.Physics.Arcade.SpriteWithDynamicBody & { isFalling?: boolean };

export interface PlayHud {
  health: number;
  maxHealth: number;
  coins: number;
  coinsTotal: number;
  deaths: number;
  timeMs: number;
  hasGoal: boolean;
  /** Text of a sign the knight is standing at. */
  sign?: string;
  dying: boolean;
}

export interface PlayDeps {
  scene: Phaser.Scene;
  model: LevelModel;
  renderer: Renderer;
  camera: CameraController;
  settings: PlaySettingsStore;
  log: EditorLogger;
  clock?: () => number;
  onHud?: (hud: PlayHud) => void;
  onEnd?: (result: PlayResult) => void;
}

export class PlayController implements EnemyHost {
  private active = false;
  private knight: Knight | null = null;
  private controller: PlayerController | null = null;
  private enemies: EnemySprite[] = [];
  private enemyGroup: Phaser.Physics.Arcade.Group | null = null;
  private pellets: Phaser.Physics.Arcade.Group | null = null;
  private pickups: Phaser.Physics.Arcade.StaticGroup | null = null;
  private colliders: Phaser.Physics.Arcade.Collider[] = [];
  private entities: Entity[] = [];
  private health = MAX_HEALTH;
  private coins = 0;
  private coinsTotal = 0;
  private deaths = 0;
  private elapsedMs = 0;
  private invulnerableMs = 0;
  private dyingMs = -1;
  private signText: string | undefined;
  private signs: Phaser.GameObjects.Image[] = [];
  private goalReached = false;
  private startedAt = 0;
  private _tuning: EnemyTuning = enemyTuning(1);
  private unsubscribeSettings: (() => void) | null = null;
  private readonly clock: () => number;

  constructor(private readonly deps: PlayDeps) {
    this.clock = deps.clock ?? (() => performance.now());
  }

  get isActive(): boolean {
    return this.active;
  }

  get stats(): { deaths: number; coins: number; health: number; timeMs: number } {
    return { deaths: this.deaths, coins: this.coins, health: this.health, timeMs: this.elapsedMs };
  }

  /** The live knight sprite (e2e tests). */
  get knightSprite(): Knight | null {
    return this.knight;
  }

  // EnemyHost
  tuning(): EnemyTuning {
    return this._tuning;
  }

  spawnPellet(p: PelletSpec): void {
    if (!this.pellets) return;
    // Old pellets (Slime.ts:130-131, UltraSlime.ts:146-161): "pellets" frame 1
    // (Slime), 0 (Ultra Slime) or 2 (mega), drawn at setScale(2). The body
    // size is halved to cancel the scale, so hit boxes stay 4 / 6 px.
    const frame = p.mega ? 2 : p.kind === "ultraslime" ? 0 : 1;
    const s = this.pellets.create(p.x, p.y, ASSET.pellets, frame) as Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
    s.setScale(2);
    s.setDepth(DEPTH.pellets);
    s.body.setAllowGravity(false);
    s.body.setSize(p.mega ? 3 : 2, p.mega ? 3 : 2, true);
    s.setVelocityX(p.speed * p.dir);
    s.setData("damage", p.damage);
    s.setData("lifeMs", p.lifeMs);
  }

  start(): boolean {
    if (this.active) return false;
    const { scene, model, renderer, camera } = this.deps;
    this.active = true;
    this.goalReached = false;
    this.dyingMs = -1;
    this.invulnerableMs = 0;
    this.deaths = 0;
    this.elapsedMs = 0;
    this.startedAt = this.clock();
    this.entities = model.entities.map((e) => ({ ...e, patrol: e.patrol ? [e.patrol[0], e.patrol[1]] : undefined }));

    renderer.setEditView(false);
    this.applySettings();
    this.unsubscribeSettings = this.deps.settings.subscribe(() => this.applySettings());

    const start = model.start;
    const knight = scene.physics.add.sprite(
      start.x * TILE_PX + TILE_PX / 2,
      start.y * TILE_PX + TILE_PX / 2,
      ASSET.tiles,
      FRAME.KNIGHT,
    ) as Knight;
    knight.setDepth(DEPTH.player);
    configurePlayerSprite(knight);
    this.knight = knight;
    this.applySettings();
    this.controller = new PlayerController(scene, knight, {
      onJump: () => {
        const s = this.deps.settings.get();
        knight.body.velocity.y = scaledJumpVelocity(knight.body.velocity.y, s);
      },
    });

    this.pellets = scene.physics.add.group({ allowGravity: false });
    this.enemyGroup = scene.physics.add.group();
    this.pickups = scene.physics.add.staticGroup();
    const layer = renderer.collisionLayer;
    this.colliders.push(
      scene.physics.add.collider(knight, layer),
      scene.physics.add.collider(this.enemyGroup, layer),
      scene.physics.add.collider(this.pellets, layer, (p) => (p as Phaser.GameObjects.GameObject).destroy()),
      scene.physics.add.overlap(knight, this.pellets, (_k, p) => this.onPellet(p as Phaser.Physics.Arcade.Sprite)),
      scene.physics.add.overlap(knight, this.enemyGroup, (_k, e) => this.onEnemy(e as EnemySprite)),
      scene.physics.add.overlap(knight, this.pickups, (_k, o) => this.onPickup(o as Phaser.Physics.Arcade.Image)),
    );
    this.spawnWorld();

    camera.follow(knight);
    this.deps.log({ type: "play.start", t: this.startedAt });
    this.emitHud();
    return true;
  }

  /** End Play. reachedGoal = the knight touched the flag. */
  stop(reachedGoal = false): PlayResult | undefined {
    if (!this.active) return undefined;
    const { scene, renderer, camera } = this.deps;
    this.active = false;
    for (const c of this.colliders) c.destroy();
    this.colliders = [];
    this.clearWorld();
    this.pellets?.destroy(true);
    this.enemyGroup?.destroy(true);
    this.pickups?.destroy(true);
    this.pellets = this.enemyGroup = null;
    this.pickups = null;
    this.knight?.destroy();
    this.knight = null;
    this.controller = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    scene.physics.world.gravity.y = 0;
    // The controller registered cursor and WASD keys (with capture); release them
    // so Space and arrows work in the editor and in text fields again.
    // Only the controller's keys are removed: other modules' Phaser keys stay.
    const kb = scene.input.keyboard;
    if (kb) for (const code of PLAYER_KEY_CODES) kb.removeKey(code, true, true);
    camera.stopFollow();
    renderer.setEditView(true);
    const result: PlayResult = { reachedGoal, deaths: this.deaths, coins: this.coins, timeMs: Math.round(this.elapsedMs) };
    this.deps.log({ type: "play.end", t: this.clock(), reachedGoal, deaths: this.deaths });
    this.deps.onEnd?.(result);
    return result;
  }

  update(deltaMs: number): void {
    if (!this.active || !this.knight || !this.controller) return;
    if (this.goalReached) {
      this.stop(true);
      return;
    }
    const knight = this.knight;
    const s = this.deps.settings.get();
    this.elapsedMs += deltaMs;

    if (this.dyingMs >= 0) {
      this.dyingMs += deltaMs;
      knight.setAlpha(Math.floor(this.dyingMs / 80) % 2 ? 0.2 : 0.8);
      if (this.dyingMs >= RESPAWN_DELAY_MS) this.respawn();
      this.emitHud();
      return;
    }

    knight.body.velocity.x = toControllerVx(knight.body.velocity.x, s.speedScale);
    this.controller.update(deltaMs);
    knight.body.velocity.x = toBodyVx(knight.body.velocity.x, s.speedScale);

    const target = { x: knight.x, y: knight.y };
    for (const e of this.enemies) e.step(deltaMs, target);

    if (this.pellets) {
      for (const p of [...this.pellets.getChildren()] as Phaser.Physics.Arcade.Sprite[]) {
        const life = (p.getData("lifeMs") as number) - deltaMs;
        if (life <= 0) p.destroy();
        else p.setData("lifeMs", life);
      }
    }

    if (this.invulnerableMs > 0) {
      this.invulnerableMs = Math.max(0, this.invulnerableMs - deltaMs);
      knight.setAlpha(this.invulnerableMs > 0 && Math.floor(this.invulnerableMs / 100) % 2 ? 0.4 : 1);
    }

    this.signText = undefined;
    for (const e of this.entities) {
      if (e.kind !== "sign" || !e.text) continue;
      const cx = e.x * TILE_PX + TILE_PX / 2;
      const cy = e.y * TILE_PX + TILE_PX / 2;
      if (Math.abs(knight.x - cx) < TILE_PX && Math.abs(knight.y - cy) < TILE_PX) this.signText = e.text;
    }

    const fell = knight.y > this.deps.renderer.heightPx + FALL_MARGIN_PX;
    if (fell || this.health <= 0) this.die();
    if (this.active) this.emitHud();
  }

  private applySettings(): void {
    const s = this.deps.settings.get();
    this._tuning = enemyTuning(s.enemyAggression);
    if (!this.active) return;
    this.deps.scene.physics.world.gravity.y = playGravity(WORLD_GRAVITY_Y, s);
    if (this.knight) {
      const maxY = Math.max(TERMINAL_VELOCITY_PX, Math.abs(JUMP_VELOCITY_PX) * s.jumpScale + 1);
      this.knight.setMaxVelocity(MAX_RUN_SPEED_PX * s.speedScale, maxY);
    }
  }

  private spawnWorld(): void {
    const { scene } = this.deps;
    this.health = MAX_HEALTH;
    this.coins = 0;
    this.coinsTotal = 0;
    for (const e of this.entities) {
      if (ENEMY_KINDS.has(e.kind)) {
        const enemy = e.kind === "slime" ? new Slime(scene, e, this) : new UltraSlime(scene, e, this);
        this.enemyGroup!.add(enemy);
        enemy.body.setAllowGravity(true);
        this.enemies.push(enemy);
      } else if (COLLECTABLE_KINDS.has(e.kind) || e.kind === "flag") {
        const img = this.pickups!.create(e.x * TILE_PX + TILE_PX / 2, e.y * TILE_PX + TILE_PX / 2, ASSET.tiles, ENTITY_FRAME[e.kind]) as Phaser.Physics.Arcade.Image;
        img.setDepth(DEPTH.entities);
        img.setData("kind", e.kind);
        const body = img.body as Phaser.Physics.Arcade.StaticBody;
        if (e.kind === "flag") body.setSize(8, 16, true);
        else body.setSize(10, 10, true);
        if (e.kind === "coin") this.coinsTotal++;
      } else if (e.kind === "sign") {
        const img = scene.add.image(e.x * TILE_PX, e.y * TILE_PX, ASSET.tiles, ENTITY_FRAME.sign).setOrigin(0, 0);
        img.setDepth(DEPTH.entities);
        img.setData("playObject", true);
        this.signs.push(img);
      }
    }
  }

  private clearWorld(): void {
    for (const e of this.enemies) e.destroy();
    this.enemies = [];
    this.pickups?.clear(true, true);
    this.pellets?.clear(true, true);
    for (const s of this.signs) s.destroy();
    this.signs = [];
  }

  private onPellet(p: Phaser.Physics.Arcade.Sprite): void {
    if (this.dyingMs >= 0) return;
    const dmg = (p.getData("damage") as number) ?? 1;
    p.destroy();
    this.damage(dmg);
  }

  private onEnemy(e: EnemySprite): void {
    if (!this.knight || this.dyingMs >= 0 || !e.alive) return;
    const body = this.knight.body;
    if (isStomp({ bottom: body.bottom, prevBottom: body.prev.y + body.height, vy: body.velocity.y }, e.headY)) {
      e.stomp();
      body.velocity.y = scaledJumpVelocity(STOMP_BOUNCE_PX, this.deps.settings.get());
      return;
    }
    if (this.invulnerableMs > 0) return;
    this.damage(1);
    body.velocity.x = (this.knight.x < e.x ? -1 : 1) * 160;
    body.velocity.y = -200;
  }

  private onPickup(o: Phaser.Physics.Arcade.Image): void {
    if (this.dyingMs >= 0) return;
    const kind = o.getData("kind") as Entity["kind"];
    if (kind === "flag") {
      // Never tear the world down inside a physics callback: finish in update().
      this.goalReached = true;
      return;
    }
    if (kind === "coin") this.coins++;
    if (kind === "fruit") this.health = Math.min(MAX_HEALTH, this.health + 1);
    o.destroy();
  }

  private damage(n: number): void {
    if (this.invulnerableMs > 0) return;
    this.health -= n;
    this.invulnerableMs = INVULNERABLE_MS;
  }

  private die(): void {
    if (this.dyingMs >= 0 || !this.knight) return;
    this.deaths++;
    this.dyingMs = 0;
    this.knight.body.setVelocity(0, 0);
    this.knight.body.setAllowGravity(false);
    this.knight.body.enable = false;
  }

  private respawn(): void {
    const knight = this.knight;
    if (!knight) return;
    this.dyingMs = -1;
    this.invulnerableMs = 0;
    const st = this.deps.model.start;
    knight.body.enable = true;
    knight.body.setAllowGravity(true);
    knight.body.reset(st.x * TILE_PX + TILE_PX / 2, st.y * TILE_PX + TILE_PX / 2);
    knight.setAlpha(1);
    this.controller?.reset();
    // Fresh attempt: enemies and collectables come back.
    this.clearWorld();
    this.spawnWorld();
  }

  private emitHud(): void {
    this.deps.onHud?.({
      health: Math.max(0, this.health),
      maxHealth: MAX_HEALTH,
      coins: this.coins,
      coinsTotal: this.coinsTotal,
      deaths: this.deaths,
      timeMs: this.elapsedMs,
      hasGoal: this.entities.some((e) => e.kind === "flag"),
      sign: this.signText,
      dying: this.dyingMs >= 0,
    });
  }
}
