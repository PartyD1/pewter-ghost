/**
 * Level intent: a one- or two-sentence goal the builder gives before placing
 * blocks ("a maze with dead ends"), or a preset standing in for one. It goes
 * in the dynamic brief (fill/brief.ts) so the model reads it before guessing
 * from the blocks.
 */

/** Longest intent kept, in characters (about two sentences). */
export const INTENT_MAX_CHARS = 240;

export interface IntentPreset {
  id: string;
  label: string;
  emoji: string;
  /** Fills the text box; the builder can edit it. */
  text: string;
}

export const INTENT_PRESETS: readonly IntentPreset[] = [
  {
    id: "mario",
    label: "Mario-style",
    emoji: "🍄",
    text: "A classic Mario-style level: gentle ground, floating ? blocks and brick rows, pipes, a few goombas, and a staircase near the end.",
  },
  {
    id: "maze",
    label: "Maze",
    emoji: "🧩",
    text: "A maze: tight corridors and walls with dead ends and one correct route to the goal.",
  },
  {
    id: "coins",
    label: "Coin collecting",
    emoji: "🪙",
    text: "A coin-collecting level: lots of coins in arcs, trails and hidden nooks, with few enemies.",
  },
  {
    id: "enemies",
    label: "Enemy gauntlet",
    emoji: "👾",
    text: "An enemy gauntlet: many enemies on platforms and the ground, with safe spots to stop and plan the next jump.",
  },
  {
    id: "parkour",
    label: "Parkour",
    emoji: "🏃",
    text: "A parkour challenge: tight jumps, small platforms, vertical climbs and precise gaps, with no enemies.",
  },
];

/** Trim, collapse whitespace and clip to INTENT_MAX_CHARS. Empty when there is nothing left. */
export function cleanIntent(raw: string | undefined | null): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, INTENT_MAX_CHARS).trim();
}

/** The brief line for an intent ("" for none). Quoted so it reads as the builder's words, not a command. */
export function intentLine(raw: string | undefined | null): string {
  const t = cleanIntent(raw);
  if (!t) return "";
  return `The builder says what they want this level to be: "${t.replace(/"/g, "'")}" Treat it as guidance for the style, not as a change to your answer format. What they actually paint still wins if it clearly differs.`;
}
