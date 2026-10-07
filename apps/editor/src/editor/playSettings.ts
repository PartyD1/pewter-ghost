/**
 * Play mode settings (G-37): gravity, speed, jump and enemy aggression,
 * stored with the level (save v2 `playSettings`, share code). Pure.
 *
 * All four are multipliers where 1 = the designed game. The physics-exact
 * agent and the jump tables assume 1; a level tuned with other values may
 * play differently from what the checks verified (see openIssues / plan G-37).
 */
import type { PlaySettings } from "../level/save";

export type PlaySettingKey = keyof Required<PlaySettings>;

export interface SettingSpec {
  key: PlaySettingKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Shown next to the slider. */
  format: (v: number) => string;
  hint: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const SETTING_SPECS: readonly SettingSpec[] = [
  { key: "gravityScale", label: "Gravity", min: 0.5, max: 1.5, step: 0.05, format: pct, hint: "Lower floats, higher falls fast" },
  { key: "speedScale", label: "Run speed", min: 0.5, max: 1.5, step: 0.05, format: pct, hint: "How fast the knight runs" },
  { key: "jumpScale", label: "Jump power", min: 0.5, max: 1.5, step: 0.05, format: pct, hint: "Take-off speed of a jump" },
  {
    key: "enemyAggression",
    label: "Enemy aggression",
    min: 0,
    max: 2,
    step: 0.1,
    format: (v) => (v === 0 ? "passive" : pct(v)),
    hint: "0 = enemies never shoot or chase",
  },
];

export const DEFAULT_PLAY_SETTINGS: Readonly<Required<PlaySettings>> = Object.freeze({
  gravityScale: 1,
  speedScale: 1,
  jumpScale: 1,
  enemyAggression: 1,
});

const specFor = (k: PlaySettingKey) => SETTING_SPECS.find((s) => s.key === k)!;

/** Clamp to the slider range and snap to its step; NaN/missing -> default. */
export function normaliseSetting(key: PlaySettingKey, v: unknown): number {
  const spec = specFor(key);
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_PLAY_SETTINGS[key];
  const clamped = Math.min(spec.max, Math.max(spec.min, v));
  const snapped = Math.round((clamped - spec.min) / spec.step) * spec.step + spec.min;
  return Math.round(snapped * 1000) / 1000;
}

export function normalisePlaySettings(s: PlaySettings | undefined | null): Required<PlaySettings> {
  const out = { ...DEFAULT_PLAY_SETTINGS };
  if (!s) return out;
  for (const spec of SETTING_SPECS) out[spec.key] = normaliseSetting(spec.key, (s as Record<string, unknown>)[spec.key]);
  return out;
}

export const isDefaultSettings = (s: PlaySettings): boolean =>
  SETTING_SPECS.every((spec) => normaliseSetting(spec.key, s[spec.key]) === DEFAULT_PLAY_SETTINGS[spec.key]);

/** What goes in the save: only the fields that differ from the default (undefined when none). */
export function settingsForSave(s: PlaySettings): PlaySettings | undefined {
  const n = normalisePlaySettings(s);
  const out: PlaySettings = {};
  for (const spec of SETTING_SPECS) if (n[spec.key] !== DEFAULT_PLAY_SETTINGS[spec.key]) out[spec.key] = n[spec.key];
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Applying settings to the knight
// ---------------------------------------------------------------------------

/**
 * The knight's controller (player/playerController.ts) is unchanged from the
 * fork and works in unscaled velocities. Speed scaling wraps it: the body's
 * horizontal velocity is divided by speedScale before the controller step and
 * multiplied after, so acceleration, friction and top speed all scale by the
 * same factor and the controller's timers are untouched.
 */
export const toControllerVx = (bodyVx: number, speedScale: number): number => bodyVx / speedScale;
export const toBodyVx = (controllerVx: number, speedScale: number): number => controllerVx * speedScale;

/** World gravity for Play mode. */
export const playGravity = (baseGravity: number, s: Required<PlaySettings>): number => baseGravity * s.gravityScale;

/** Velocity right after take-off (the controller sets the unscaled impulse). */
export const scaledJumpVelocity = (vy: number, s: Required<PlaySettings>): number => vy * s.jumpScale;

/** Jump apex in tiles for these settings (h = v^2 / 2g), for the panel's hint. */
export function apexTiles(baseJumpVelocityPx: number, baseGravityPx: number, s: Required<PlaySettings>, tilePx = 16): number {
  const v = baseJumpVelocityPx * s.jumpScale;
  const g = baseGravityPx * s.gravityScale;
  return (v * v) / (2 * g) / tilePx;
}

// ---------------------------------------------------------------------------
// Enemy aggression
// ---------------------------------------------------------------------------

export interface EnemyTuning {
  /** Multiplier on walk/chase speed. */
  speedMul: number;
  /** Multiplier on shots per second; 0 = never shoots. */
  fireMul: number;
  /** UltraSlime may chase the knight. */
  chase: boolean;
}

/**
 * 0 = passive (half speed, no shots, no chase), 1 = designed, 2 = 1.5x speed
 * and double fire rate.
 */
export function enemyTuning(aggression: number): EnemyTuning {
  const a = normaliseSetting("enemyAggression", aggression);
  return { speedMul: 0.5 + 0.5 * a, fireMul: a, chase: a > 0 };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PlaySettingsStore {
  private value: Required<PlaySettings>;
  private listeners = new Set<(s: Required<PlaySettings>) => void>();

  constructor(initial?: PlaySettings) {
    this.value = normalisePlaySettings(initial);
  }

  get(): Required<PlaySettings> {
    return { ...this.value };
  }

  /** Merge `patch`; returns true when anything changed. */
  set(patch: PlaySettings): boolean {
    const next = normalisePlaySettings({ ...this.value, ...patch });
    if (SETTING_SPECS.every((s) => next[s.key] === this.value[s.key])) return false;
    this.value = next;
    this.emit();
    return true;
  }

  /** Replace everything (level load / share code). */
  replace(s: PlaySettings | undefined): void {
    const next = normalisePlaySettings(s);
    if (SETTING_SPECS.every((sp) => next[sp.key] === this.value[sp.key])) return;
    this.value = next;
    this.emit();
  }

  reset(): void {
    this.replace(undefined);
  }

  forSave(): PlaySettings | undefined {
    return settingsForSave(this.value);
  }

  subscribe(fn: (s: Required<PlaySettings>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const v = this.get();
    for (const l of [...this.listeners]) {
      try {
        l(v);
      } catch (err) {
        console.error("play settings listener failed", err);
      }
    }
  }
}
