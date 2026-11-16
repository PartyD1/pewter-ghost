/**
 * Themes and style for the composer: what kind of level the person is
 * making, and from that which pieces to favour and how hard to make them.
 *
 * Two sources, both read with fixed rules (a keyword table and thresholds on
 * measured numbers; no language model, nothing learned):
 *
 *  - the level goal the builder typed or picked ("a maze with dead ends",
 *    the Parkour preset): `themesFromText` counts keyword hits per theme;
 *  - the drawing itself: measured numbers (gap widths, verticality, coins,
 *    enemies), how much has been drawn, and the shapes mined from it.
 *
 * `styleFor` blends them into a ComposeStyle.
 */
import type { KnightLimits, MeasuredNumbers } from "../../../apps/editor/src/contracts";
import { capsFor, type Caps } from "./caps";
import { COMPOSE_KINDS, neutralStyle, type ComposeKind, type ComposeStyle, type Motif } from "./compose";
import { profileFromMeasured } from "./profile";

export const THEME_NAMES = ["mario", "maze", "coins", "enemies", "parkour", "gentle"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export interface LevelTheme {
  /** What the status line may call the level ("parkour"). */
  label: string;
  /** Lower-case fragments that count as a hit when the goal text contains them. */
  keywords: readonly string[];
  /** Multiplier per piece kind on the neutral weights (absent = 1). */
  weights: Partial<Record<ComposeKind, number>>;
  /** Added to the target intensity. */
  intensity?: number;
  /** Floors / ceilings on enemy and coin chances. */
  enemyP?: [number, number];
  coinP?: [number, number];
}

export const LEVEL_THEMES: Record<ThemeName, LevelTheme> = {
  mario: {
    label: "classic platformer",
    keywords: ["mario", "classic", "goomba", "pipe", "brick", "question block", "? block", "retro", "nintendo"],
    weights: { brick_row: 3, pillars: 2.2, enemy_run: 2.5, stairs: 1.6, flat: 1.2, pit: 0.8, stones: 0.3, gap_run: 0.4, coin_jump: 0.6 },
    enemyP: [0.12, 0.3],
    coinP: [0.6, 0.9],
  },
  maze: {
    label: "maze",
    keywords: ["maze", "labyrinth", "corridor", "dead end", "dead-end", "tunnel", "cave", "dungeon", "wall"],
    weights: { brick_row: 3, pillars: 3, mesa: 1.8, stairs: 1.4, step: 1.3, pit: 0.4, gap_run: 0.2, stones: 0.2, coin_jump: 0.4, enemy_run: 0.5 },
    intensity: -0.05,
  },
  coins: {
    label: "coin collecting",
    keywords: ["coin", "collect", "treasure", "reward", "gem", "gold", "loot", "money"],
    weights: { coin_row: 3, coin_jump: 3, platform_over_pit: 1.8, stones: 1.4, brick_row: 1.6, mesa: 1.3, enemy_run: 0.15, pillars: 0.6 },
    intensity: -0.1,
    enemyP: [0, 0.05],
    coinP: [0.9, 1],
  },
  enemies: {
    label: "enemy gauntlet",
    keywords: ["enem", "monster", "slime", "gauntlet", "fight", "combat", "battle", "danger", "goomba", "creature"],
    weights: { enemy_run: 5, mesa: 1.8, flat: 1.4, platform_over_pit: 0.8, pit: 0.6, gap_run: 0.4, stones: 0.4, coin_row: 0.6 },
    enemyP: [0.3, 0.45],
  },
  parkour: {
    label: "parkour",
    keywords: ["parkour", "jump", "platforming", "precise", "precision", "speedrun", "speed run", "hard", "challeng", "climb", "vertical", "tight", "difficult", "obstacle"],
    weights: { gap_run: 3, stones: 3, pit: 1.6, platform_over_pit: 1.8, stairs: 1.6, step: 1.3, pillars: 1.3, flat: 0.5, coin_row: 0.3, brick_row: 0.2, enemy_run: 0 },
    intensity: 0.2,
    enemyP: [0, 0],
  },
  gentle: {
    label: "easy stroll",
    keywords: ["easy", "relax", "calm", "gentle", "beginner", "kid", "simple", "casual", "chill", "tutorial", "peaceful"],
    weights: { flat: 1.6, coin_row: 1.8, mesa: 1.4, brick_row: 1.4, step: 1.2, gap_run: 0.2, stones: 0.2, enemy_run: 0.3, platform_over_pit: 0.6 },
    intensity: -0.25,
    enemyP: [0, 0.08],
  },
};

export type ThemeHits = Partial<Record<ThemeName, number>>;

/** Keyword hits per theme in a goal text (empty when nothing matches). */
export function themesFromText(text: string | undefined | null): ThemeHits {
  const t = (text ?? "").toLowerCase();
  const hits: ThemeHits = {};
  if (!t.trim()) return hits;
  for (const name of THEME_NAMES) {
    let n = 0;
    for (const k of LEVEL_THEMES[name].keywords) {
      let from = 0;
      for (;;) {
        const i = t.indexOf(k, from);
        if (i < 0) break;
        // A negated mention ("no enemies", "few enemies", "without any coins") counts against the
        // theme; "a few goombas" is not one.
        const before = t.slice(Math.max(0, i - 14), i);
        n += /\b(no|not|(?<!a )few|fewer|without|zero|avoid)\s+(\w+\s+)?$/.test(before) ? -1 : 1;
        from = i + k.length;
      }
    }
    if (n > 0) hits[name] = n;
  }
  return hits;
}

/** The theme with the most hits (ties: the first in THEME_NAMES), or null. */
export function mainTheme(hits: ThemeHits): ThemeName | null {
  let best: ThemeName | null = null;
  for (const name of THEME_NAMES) if ((hits[name] ?? 0) > (best ? (hits[best] ?? 0) : 0)) best = name;
  return best;
}

export interface StyleInputs {
  measured: MeasuredNumbers;
  knight: KnightLimits;
  /** Theme hits from the level goal (themesFromText). */
  themes?: ThemeHits;
  /** Shapes mined from the drawing (mineMotifs). */
  motifs?: Motif[];
  /** How much there is to go on, 0 (a bare start) .. 1 (a screen or more drawn). */
  evidence?: number;
  /** How far along the level the section sits, 0..1 (later = a little harder). */
  progress?: number;
  /** Solid rows under the surface where the section starts. */
  fillDepth?: number;
  caps?: Caps;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

/** The composer style for a request: neutral weights, bent by the themes and by what the drawing shows. */
export function styleFor(inp: StyleInputs): ComposeStyle {
  const caps = inp.caps ?? capsFor();
  const m = inp.measured;
  const base = neutralStyle(caps);
  const prof = profileFromMeasured(m, inp.knight, { fillDepth: inp.fillDepth ?? 2 });
  const evidence = clamp(inp.evidence ?? 0, 0, 1);
  const weights: Record<ComposeKind, number> = Object.fromEntries(COMPOSE_KINDS.map((k) => [k, base.weights[k] ?? 0])) as Record<ComposeKind, number>;
  const mul = (k: ComposeKind, f: number) => (weights[k] *= f);

  // The drawing: what it shows is favoured, what a well-filled screen lacks is held back.
  const enemies = clamp(m.pressure ?? 0, 0, 1) > 0;
  const rewards = (m.rewardSpacing ?? 0) > 0;
  const vert = clamp(m.verticality ?? 0, 0, 1);
  const hasGaps = (m.gapHist ?? []).some((b) => b > 0);
  mul("enemy_run", enemies ? 1.8 : lerp(1, 0.2, evidence));
  for (const k of ["coin_row", "coin_jump"] as const) mul(k, rewards ? 1.5 : lerp(1, 0.5, evidence));
  if (vert >= 0.3) for (const k of ["stairs", "step", "mesa", "pillars"] as const) mul(k, 1.5);
  else if (evidence > 0.5 && vert < 0.1) for (const k of ["stairs", "pillars"] as const) mul(k, 0.6);
  if (hasGaps) for (const k of ["pit", "gap_run", "coin_jump", "stones"] as const) mul(k, 1.3);
  else if (evidence > 0.5) for (const k of ["pit", "gap_run", "stones", "platform_over_pit"] as const) mul(k, 0.6);
  if ((m.density ?? 0) > 0.35) mul("flat", 1.4);

  let enemyP = enemies ? prof.enemyP : lerp(base.enemyP, 0, evidence);
  let coinP = rewards ? (prof.coinP ?? base.coinP) : lerp(base.coinP, 0.25, evidence);
  let intensity = 0.25 + 0.45 * clamp(m.difficulty ?? 0.3, 0, 1) + 0.15 * clamp(inp.progress ?? 0, 0, 1);

  // The stated goal: each matching theme pulls in proportion to its hits.
  const hits = inp.themes ?? {};
  const total = THEME_NAMES.reduce((a, n) => a + (hits[n] ?? 0), 0);
  if (total > 0) {
    let eLo = 0;
    let eHi = 0;
    let cLo = 0;
    let cHi = 0;
    const bounded = { e: 0, c: 0 };
    for (const name of THEME_NAMES) {
      const share = (hits[name] ?? 0) / total;
      if (share <= 0) continue;
      const th = LEVEL_THEMES[name];
      for (const k of COMPOSE_KINDS) mul(k, Math.pow(th.weights[k] ?? 1, share));
      intensity += (th.intensity ?? 0) * share;
      if (th.enemyP) {
        eLo += th.enemyP[0] * share;
        eHi += th.enemyP[1] * share;
        bounded.e += share;
      }
      if (th.coinP) {
        cLo += th.coinP[0] * share;
        cHi += th.coinP[1] * share;
        bounded.c += share;
      }
    }
    // A goal overrides what the drawing has not shown yet: an enemy gauntlet gets enemies from the first section.
    if (bounded.e > 0) enemyP = clamp(enemyP, eLo / bounded.e, eHi / bounded.e);
    if (bounded.c > 0) coinP = clamp(coinP, cLo / bounded.c, cHi / bounded.c);
  }

  return {
    name: mainTheme(hits) ?? "measured",
    weights,
    gap: prof.gap,
    rise: prof.rise,
    enemyP,
    coinP,
    coinEvery: prof.coinEvery ?? 1,
    upP: base.upP,
    fillDepth: prof.fillDepth ?? 2,
    platformWidth: prof.platformWidth ?? base.platformWidth,
    platformRise: base.platformRise,
    intensity: clamp(intensity, 0.05, 0.95),
    motifs: inp.motifs ?? [],
  };
}

/**
 * A few words for what the level looks like it is trying to be, for the
 * status line ("parkour", "coin collecting"). The stated goal first, else
 * what the drawing shows; null when there is too little to say.
 */
export function levelGuessFor(inp: Pick<StyleInputs, "measured" | "themes" | "evidence">): string | null {
  const theme = mainTheme(inp.themes ?? {});
  if (theme) return LEVEL_THEMES[theme].label;
  const m = inp.measured;
  if ((inp.evidence ?? 0) < 0.4) return null;
  if ((m.pressure ?? 0) > 0.3) return "enemy run";
  if ((m.rewardSpacing ?? 0) > 0 && (m.rewardSpacing ?? 0) <= 4) return "coin run";
  if ((m.verticality ?? 0) >= 0.3) return "climb";
  const gaps = m.gapHist ?? [];
  const wide = (gaps[3] ?? 0) + (gaps[4] ?? 0);
  if (wide > 0) return "long jumps";
  if (gaps.some((b) => b > 0)) return "gap jumping";
  return "gentle platformer";
}
