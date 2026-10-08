/**
 * Words the ghost uses (G-19): the short canvas caption, the status-strip
 * line, and the "what Ghost thinks this level is" guess. Pure.
 *
 * Never reveals the study condition or which filler made a suggestion: the
 * filler name is not read here, and a level guess that is only a filler or
 * condition word (e.g. the stub's "stub") is dropped.
 */
import type { Suggestion, SuggestionKind } from "../contracts";

/** The first this-many ghosts of a session carry the longer, teaching caption. */
export const TEACHING_GHOSTS = 3;

const MAX_LABEL = 40;
const MAX_GUESS = 40;

/** Words that would reveal the condition or the engine; never shown as a guess. */
const HIDDEN_WORDS = new Set(["stub", "llm", "algo", "algorithm", "jev", "none", "model", "ai", "gemini", "test", "unknown", "n/a", "null"]);

const KIND_WORD: Record<SuggestionKind, string> = { finish: "finish", extend: "next stretch", fix: "fix" };

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Collapse whitespace and strip control characters. */
export function cleanText(s: string | undefined | null): string {
  if (!s) return "";
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** The ghost's label, or a plain word for its kind when the label is empty. */
export function shortLabel(s: Pick<Suggestion, "label" | "kind">): string {
  const l = cleanText(s.label);
  return clip(l || KIND_WORD[s.kind] || "suggestion", MAX_LABEL);
}

/**
 * Caption drawn on the canvas next to the ghost. `ordinal` is 1 for the
 * session's first ghost; the first TEACHING_GHOSTS name the key.
 */
export function canvasCaption(s: Pick<Suggestion, "label" | "kind">, ordinal: number): string {
  const label = shortLabel(s);
  return ordinal <= TEACHING_GHOSTS ? `${label} · Tab` : label;
}

/** The model's guess at what the level is, safe to show, or null. */
export function sanitizeGuess(g: string | undefined | null): string | null {
  const t = cleanText(g);
  if (!t) return null;
  if (HIDDEN_WORDS.has(t.toLowerCase())) return null;
  return clip(t, MAX_GUESS);
}

export type StripMode = "off" | "playing" | "showing" | "asking" | "quiet";

export interface StripView {
  mode: StripMode;
  /** For "showing". */
  ghost?: Pick<Suggestion, "label" | "kind">;
  /** 1-based count of ghosts shown this session (for "showing"). */
  ordinal?: number;
  /** Cells left to accept (for "showing"); omitted when none were painted by hand. */
  remaining?: number;
  total?: number;
  /** Sanitised level guess. */
  guess?: string | null;
  /** Play mode: is there a checked route to show with the route key? */
  routeKey?: string;
}

export interface StripText {
  /** "Ghost thinks: parkour", or null. */
  guess: string | null;
  /** The main line. */
  main: string;
  /** Visual emphasis for the line. */
  tone: "ghost" | "quiet" | "play";
  /** While a ghost shows: the end of `main` after the label (" · 2 tiles · Tab to keep"), kept whole when the label is cut. */
  tail?: string;
}

/**
 * The status line's text for a state: one short line (plan, "Ghost status ·
 * 'staircase · 2 steps · Tab to keep' · or 'quiet' · Ctrl+Space to ask").
 * What the faint and crossed-out tiles mean is taught in Help, not here.
 */
export function stripText(v: StripView): StripText {
  const guess = v.guess ? `Ghost thinks: ${v.guess}` : null;
  switch (v.mode) {
    case "off":
      return { guess: null, main: "", tone: "quiet" };
    case "playing":
      return { guess, main: v.routeKey ? `playing · ${v.routeKey} route · Esc to edit` : "playing · Esc to edit", tone: "play" };
    case "asking":
      return { guess, main: "asked · Esc to cancel", tone: "quiet" };
    case "showing": {
      const g = v.ghost ?? { label: "", kind: "finish" as const };
      const label = shortLabel(g);
      const count =
        v.remaining !== undefined && v.total !== undefined && v.remaining < v.total
          ? ` · ${v.remaining} of ${v.total} left`
          : v.total !== undefined
            ? ` · ${v.total} tile${v.total === 1 ? "" : "s"}`
            : "";
      const tail = `${count} · ${g.kind === "fix" ? "Tab to fix" : "Tab to keep"}`;
      return { guess, main: `${label}${tail}`, tone: "ghost", tail };
    }
    default:
      return { guess, main: "quiet · Ctrl+Space to ask", tone: "quiet" };
  }
}
