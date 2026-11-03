/**
 * Checkpoints in Play (pure, no Phaser): where the knight comes back after a death.
 *
 * Every `checkpoint` entity is a respawn point. Touching one in Play activates
 * it; after a death the knight respawns on the most recently activated
 * checkpoint, or on the level's start while none has been touched. Activation
 * lasts for the whole Play session: a death keeps it, a new Play clears it.
 * Enemies and collectables still reset on every respawn (play.ts).
 */
import type { Entity, Point } from "../contracts";

export class CheckpointTracker {
  private readonly spots = new Map<string, Point>();
  private activeId: string | undefined;
  private readonly reachedIds = new Set<string>();

  constructor(
    private readonly start: Point,
    entities: readonly Entity[],
  ) {
    for (const e of entities) if (e.kind === "checkpoint") this.spots.set(e.id, { x: e.x, y: e.y });
  }

  /** Checkpoints in the level. */
  get count(): number {
    return this.spots.size;
  }

  /** Distinct checkpoints touched this Play session. */
  get reached(): number {
    return this.reachedIds.size;
  }

  /** Id of the checkpoint the knight would respawn on, if any. */
  get active(): string | undefined {
    return this.activeId;
  }

  isActive(id: string): boolean {
    return this.activeId === id;
  }

  /** Touch checkpoint `id`. True when the respawn point changed. */
  activate(id: string): boolean {
    if (!this.spots.has(id) || this.activeId === id) return false;
    this.activeId = id;
    this.reachedIds.add(id);
    return true;
  }

  /** Tile the knight respawns on. */
  get respawn(): Point {
    const p = (this.activeId !== undefined && this.spots.get(this.activeId)) || this.start;
    return { x: p.x, y: p.y };
  }
}
