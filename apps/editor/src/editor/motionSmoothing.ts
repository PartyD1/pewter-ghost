/**
 * Smooth drawing for Play mode on screens faster than the physics.
 *
 * Arcade steps at a fixed 60 Hz, and that must stay (jump tables, physsim and
 * the playtest agent are built on it), so at 120 Hz a body only moves on every
 * other frame. Here each moving object is DRAWN between its last two physics
 * positions, and put back as soon as drawing ends: Arcade reads the sprite's
 * position back into the body on its next update, so a drawn position left in
 * place would change the physics.
 *
 * Drawing runs up to one physics step (about 17 ms) behind the simulation.
 *
 * Pure (no Phaser): play.ts feeds it from the game's render events.
 */

/** A jump bigger than this in one physics step is a teleport. Terminal velocity is about 13 px per step. */
export const TELEPORT_PX = 32;

export interface Movable {
  x: number;
  y: number;
}

interface Track {
  prevX: number;
  prevY: number;
  curX: number;
  curY: number;
}

export class MotionInterpolator<T extends Movable & object> {
  private readonly tracks = new WeakMap<T, Track>();
  private drawn: { object: T; x: number; y: number }[] = [];

  /**
   * Call just before drawing. Moves each object to its drawn position.
   *
   * @param steps physics steps since the last call
   * @param alpha how far through the next physics step the clock is, 0..1
   */
  beginDraw(objects: Iterable<T>, steps: number, alpha: number): void {
    this.endDraw();
    const a = Math.min(1, Math.max(0, alpha));
    for (const object of objects) {
      const track = this.advance(object, steps);
      this.drawn.push({ object, x: object.x, y: object.y });
      object.x = track.prevX + (track.curX - track.prevX) * a;
      object.y = track.prevY + (track.curY - track.prevY) * a;
    }
  }

  /** Call just after drawing. Puts every object back at its real position. */
  endDraw(): void {
    for (const d of this.drawn) {
      d.object.x = d.x;
      d.object.y = d.y;
    }
    this.drawn = [];
  }

  private advance(object: T, steps: number): Track {
    const { x, y } = object;
    const track = this.tracks.get(object);
    if (!track) {
      const fresh = { prevX: x, prevY: y, curX: x, curY: y };
      this.tracks.set(object, fresh);
      return fresh;
    }
    const dx = x - track.curX;
    const dy = y - track.curY;
    if (dx === 0 && dy === 0 && steps === 0) return track;
    // Physics only moves things during a step, so a move without one is a teleport (respawn).
    const perStep = steps > 0 ? Math.max(Math.abs(dx), Math.abs(dy)) / steps : Infinity;
    if (perStep > TELEPORT_PX) {
      track.prevX = track.curX = x;
      track.prevY = track.curY = y;
      return track;
    }
    if (steps > 0) {
      // Several steps in one frame (a slow frame): interpolate across the last one only.
      track.prevX = x - dx / steps;
      track.prevY = y - dy / steps;
      track.curX = x;
      track.curY = y;
    }
    return track;
  }
}
