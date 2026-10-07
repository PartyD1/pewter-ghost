/**
 * Explicit tool modes (G-04): Select, Paint, Erase, Pan, on keys 1-4.
 *
 * Pure state with listeners. Select is the default so a first exploratory
 * click never changes the level. Holding Space (or a two-finger drag) pans
 * temporarily in any mode without changing the chosen mode.
 */
import type { EntityKind, TileId } from "../contracts";

export type Mode = "select" | "paint" | "erase" | "pan";
export const MODES: readonly Mode[] = ["select", "paint", "erase", "pan"];

export const MODE_LABEL: Record<Mode, string> = {
  select: "Select",
  paint: "Paint",
  erase: "Erase",
  pan: "Pan",
};

/** Keyboard digit for each mode. */
export const MODE_KEY: Record<Mode, string> = { select: "1", paint: "2", erase: "3", pan: "4" };

export const modeForKey = (key: string): Mode | undefined => MODES.find((m) => MODE_KEY[m] === key);

/** What Paint mode puts down. */
export type Brush =
  | { kind: "tile"; tile: TileId }
  | { kind: "entity"; entity: EntityKind; text?: string }
  /** Moves the knight's start marker. */
  | { kind: "start" };

export const sameBrush = (a: Brush, b: Brush): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tile" && b.kind === "tile") return a.tile === b.tile;
  if (a.kind === "entity" && b.kind === "entity") return a.entity === b.entity && (a.text ?? "") === (b.text ?? "");
  return true;
};

export interface ModeSnapshot {
  mode: Mode;
  brush: Brush;
  /** Space held / temporary pan. */
  tempPan: boolean;
  /** The mode that pointer gestures act in right now (pan while tempPan). */
  effective: Mode;
}

export type ModeListener = (s: ModeSnapshot, prev: ModeSnapshot) => void;

export class ModeState {
  private _mode: Mode;
  private _brush: Brush;
  private _tempPan = false;
  private listeners = new Set<ModeListener>();

  constructor(initial: Mode = "select", brush: Brush = { kind: "tile", tile: 6 as TileId }) {
    this._mode = initial;
    this._brush = brush;
  }

  get mode(): Mode {
    return this._mode;
  }
  get brush(): Brush {
    return this._brush;
  }
  get tempPan(): boolean {
    return this._tempPan;
  }
  get effective(): Mode {
    return this._tempPan ? "pan" : this._mode;
  }

  snapshot(): ModeSnapshot {
    return { mode: this._mode, brush: this._brush, tempPan: this._tempPan, effective: this.effective };
  }

  subscribe(fn: ModeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Switch mode. Returns true when something changed. */
  setMode(mode: Mode): boolean {
    if (mode === this._mode) return false;
    return this.mutate(() => {
      this._mode = mode;
    });
  }

  /**
   * Choose a palette brush. Choosing a brush switches to Paint (the person
   * picked something to put down); this is the only implicit mode change.
   */
  setBrush(brush: Brush): boolean {
    if (sameBrush(brush, this._brush) && this._mode === "paint") return false;
    return this.mutate(() => {
      this._brush = brush;
      this._mode = "paint";
    });
  }

  setTempPan(on: boolean): boolean {
    if (on === this._tempPan) return false;
    return this.mutate(() => {
      this._tempPan = on;
    });
  }

  private mutate(fn: () => void): true {
    const prev = this.snapshot();
    fn();
    const next = this.snapshot();
    for (const l of [...this.listeners]) {
      try {
        l(next, prev);
      } catch (err) {
        console.error("mode listener failed", err);
      }
    }
    return true;
  }
}

/** Short human text for the visible indicator, e.g. "Paint · grass". */
export function describeMode(s: Pick<ModeSnapshot, "mode" | "brush" | "tempPan">, brushName: (b: Brush) => string): string {
  if (s.tempPan) return "Pan (Space)";
  if (s.mode === "paint") return `Paint · ${brushName(s.brush)}`;
  return MODE_LABEL[s.mode];
}
