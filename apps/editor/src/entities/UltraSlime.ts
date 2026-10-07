/**
 * UltraSlime, softened (G-06): chases a nearby knight on its own floor only,
 * flashes before each short burst, and its mega pellets do 1 damage.
 * Behaviour: brains.ts stepUltraSlime.
 */
import type Phaser from "phaser";
import type { Entity } from "../contracts";
import { createUltraState, stepUltraSlime, ULTRA, type BrainStep, type Shot, type UltraState } from "./brains";
import { EnemySprite, type EnemyHost } from "./EnemySprite";

const WARN_TINT = 0xffe066;

export class UltraSlime extends EnemySprite {
  private state: UltraState = createUltraState();
  private blinkMs = 0;

  constructor(scene: Phaser.Scene, entity: Entity, host: EnemyHost) {
    super(scene, entity, host, ULTRA.health);
  }

  protected think(deltaMs: number, player: { x: number; y: number } | undefined): BrainStep {
    const out = stepUltraSlime(this.state, deltaMs, { x: this.x, y: this.y }, player, this.range, this.host.tuning());
    if (out.warning) {
      this.blinkMs += deltaMs;
      if (Math.floor(this.blinkMs / 100) % 2 === 0) this.setTint(WARN_TINT);
      else this.clearTint();
    } else if (this.blinkMs !== 0) {
      this.blinkMs = 0;
      this.clearTint();
    }
    return out;
  }

  protected pelletFor(shot: Shot) {
    return shot.mega
      ? { speed: ULTRA.megaPelletSpeed, damage: ULTRA.megaDamage, lifeMs: ULTRA.pelletLifeMs }
      : { speed: ULTRA.pelletSpeed, damage: ULTRA.damage, lifeMs: ULTRA.pelletLifeMs };
  }

  protected resetBrain(): void {
    this.state = createUltraState();
    this.blinkMs = 0;
    this.clearTint();
  }
}
