/**
 * Slime (G-06): walks its whole floor (the model's patrol span) and fires
 * straight ahead on a time-based timer. Behaviour: brains.ts stepSlime.
 */
import type Phaser from "phaser";
import type { Entity } from "../contracts";
import { createSlimeState, SLIME, stepSlime, type BrainStep, type Shot, type SlimeState } from "./brains";
import { EnemySprite, type EnemyHost } from "./EnemySprite";

export class Slime extends EnemySprite {
  private brain: SlimeState = createSlimeState();

  constructor(scene: Phaser.Scene, entity: Entity, host: EnemyHost) {
    super(scene, entity, host, SLIME.health);
  }

  protected think(deltaMs: number): BrainStep {
    return stepSlime(this.brain, deltaMs, this.x, this.range, this.host.tuning());
  }

  protected pelletFor(_shot: Shot) {
    return { speed: SLIME.pelletSpeed, damage: SLIME.damage, lifeMs: SLIME.pelletLifeMs };
  }

  protected resetBrain(): void {
    this.brain = createSlimeState();
  }
}
