/**
 * Shared Phaser side of the enemies (G-06). Behaviour lives in brains.ts
 * (pure, time-based); this class applies a brain step to an Arcade body,
 * spawns pellets through the host, and handles stomps and respawn.
 */
import Phaser from "phaser";
import type { Entity } from "../contracts";
import { ASSET, DEPTH, ENTITY_FRAME, TILE_PX } from "../editor/constants";
import type { EnemyTuning } from "../editor/playSettings";
import { patrolRangePx, type BrainStep, type Shot } from "./brains";

export interface PelletSpec {
  x: number;
  y: number;
  dir: 1 | -1;
  mega: boolean;
  /** Who fired it (picks the old pellet frame: Slime 1, Ultra Slime 0, mega 2). */
  kind?: "slime" | "ultraslime";
  speed: number;
  damage: number;
  lifeMs: number;
}

export interface EnemyHost {
  spawnPellet(p: PelletSpec): void;
  tuning(): EnemyTuning;
}

export abstract class EnemySprite extends Phaser.Physics.Arcade.Sprite {
  declare body: Phaser.Physics.Arcade.Body;
  readonly entityId: string;
  readonly kind: Entity["kind"];
  readonly spawn: { x: number; y: number };
  protected range: [number, number];
  protected health: number;
  private dead = false;

  constructor(
    scene: Phaser.Scene,
    entity: Entity,
    protected readonly host: EnemyHost,
    protected readonly maxHealth: number,
  ) {
    const x = entity.x * TILE_PX + TILE_PX / 2;
    const y = entity.y * TILE_PX + TILE_PX / 2;
    super(scene, x, y, ASSET.tiles, ENTITY_FRAME[entity.kind]);
    this.entityId = entity.id;
    this.kind = entity.kind;
    this.spawn = { x, y };
    this.range = patrolRangePx(entity.patrol, x);
    this.health = maxHealth;
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(DEPTH.player - 1);
    // The slime art sits in the lower part of the 16 px frame.
    this.body.setSize(12, 9).setOffset(2, 7);
    this.body.setMaxVelocityY(800);
  }

  get alive(): boolean {
    return !this.dead;
  }

  /** Top of the hitbox in world px (for stomp checks). */
  get headY(): number {
    return this.body.top;
  }

  /** Advance by elapsed ms. */
  step(deltaMs: number, player: { x: number; y: number } | undefined): void {
    if (this.dead || !this.body) return;
    const out = this.think(deltaMs, player);
    this.body.setVelocityX(out.vx);
    this.setFlipX(out.facing < 0);
    for (const s of out.shots) this.fire(s);
  }

  protected abstract think(deltaMs: number, player: { x: number; y: number } | undefined): BrainStep;
  protected abstract pelletFor(shot: Shot): { speed: number; damage: number; lifeMs: number };

  private fire(shot: Shot): void {
    const p = this.pelletFor(shot);
    this.host.spawnPellet({ x: this.x + shot.dir * 6, y: this.y + 2, dir: shot.dir, mega: shot.mega, kind: this.kind === "ultraslime" ? "ultraslime" : "slime", ...p });
  }

  /** Stomped by the knight: dies until the level resets. */
  stomp(): void {
    this.hurt(this.health);
  }

  hurt(amount: number): void {
    if (this.dead) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.dead = true;
      this.disableBody(true, true);
    }
  }

  /** Back to the spawn point with full health (knight died / level reset). */
  respawn(): void {
    this.dead = false;
    this.health = this.maxHealth;
    this.enableBody(true, this.spawn.x, this.spawn.y, true, true);
    this.body.setVelocity(0, 0);
    this.resetBrain();
  }

  protected abstract resetBrain(): void;
}
