/**
 * G-25 variety scorer.
 *
 * Per session (answers in request order):
 *  - tags per acting answer (@measure pattern tags via the validator)
 *  - distinct tags (neutral tags such as "rest" excluded)
 *  - runs: a tag present in `maxRun` (3) consecutive acting answers is a
 *    violation, and the suite FAILS on any (plan G-25)
 *  - novelty: 1 - Jaccard(tags of this answer, tags of the previous one),
 *    averaged; and label novelty the same on label words
 *  - history repeats: an Extend whose tags cover the tags of BOTH of the last
 *    two accepted Extend ghosts in its request (what the validator rejects)
 */
import type { GhostHistoryItem, SuggestionKind } from "../../../apps/editor/src/contracts";
import { VALIDATION_BANDS } from "../../../apps/editor/src/verify/validate";

export interface VarietyItem {
  sessionId: string;
  seq: number;
  act: boolean | null;
  kind?: SuggestionKind;
  label?: string;
  tags?: readonly string[];
  /** lastGhosts of the request (oldest first). */
  history?: readonly GhostHistoryItem[];
}

export interface TagRun {
  tag: string;
  /** seq of the answer that completed the run. */
  at: number;
  length: number;
}

export interface SessionVariety {
  sessionId: string;
  answers: number;
  distinct: number;
  tags: string[];
  longestRun: { tag: string; length: number } | null;
  violations: TagRun[];
  tagNovelty: number;
  labelNovelty: number;
  historyRepeats: number;
}

export interface VarietyScore {
  sessions: SessionVariety[];
  /** Mean distinct tags per session (sessions with >= 1 acting answer). */
  distinctPerSession: number;
  /** Distinct tags over the whole run. */
  distinctTotal: number;
  violations: number;
  sessionsWithViolation: number;
  historyRepeats: number;
  tagNovelty: number;
  labelNovelty: number;
  /** True when no tag appears `maxRun` times running in any session. */
  pass: boolean;
}

export interface VarietyOptions {
  maxRun?: number;
  neutral?: readonly string[];
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Does `tags` repeat both of the last two accepted Extend ghosts' tags? */
export function repeatsHistory(kind: SuggestionKind | undefined, tags: readonly string[], history: readonly GhostHistoryItem[], neutral: readonly string[]): boolean {
  if (kind !== "extend") return false;
  const mine = new Set(tags.filter((t) => !neutral.includes(t)));
  if (!mine.size) return false;
  const accepted = history.filter((g) => g.kind === "extend" && (g.outcome === "accepted" || g.outcome === "partial")).slice(-2);
  if (accepted.length < 2) return false;
  return accepted.every((g) => {
    const theirs = (g.patterns ?? []).filter((t) => !neutral.includes(t));
    return theirs.length > 0 && theirs.some((t) => mine.has(t));
  });
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function scoreVariety(items: readonly VarietyItem[], o: VarietyOptions = {}): VarietyScore {
  const maxRun = o.maxRun ?? 3;
  const neutral = o.neutral ?? VALIDATION_BANDS.neutralTags;
  const bySession = new Map<string, VarietyItem[]>();
  for (const it of items) {
    const l = bySession.get(it.sessionId) ?? [];
    l.push(it);
    bySession.set(it.sessionId, l);
  }
  const sessions: SessionVariety[] = [];
  const allTags = new Set<string>();
  for (const [sessionId, list] of [...bySession].sort((a, b) => a[0].localeCompare(b[0]))) {
    const acting = list.filter((x) => x.act).sort((a, b) => a.seq - b.seq);
    const tagSets = acting.map((x) => new Set((x.tags ?? []).filter((t) => !neutral.includes(t))));
    const distinct = new Set<string>();
    tagSets.forEach((s) => s.forEach((t) => (distinct.add(t), allTags.add(t))));
    const run = new Map<string, number>();
    const violations: TagRun[] = [];
    let longest: { tag: string; length: number } | null = null;
    tagSets.forEach((s, i) => {
      for (const t of [...run.keys()]) if (!s.has(t)) run.delete(t);
      for (const t of s) {
        const n = (run.get(t) ?? 0) + 1;
        run.set(t, n);
        if (!longest || n > longest.length) longest = { tag: t, length: n };
        if (n === maxRun) violations.push({ tag: t, at: acting[i].seq, length: n });
        else if (n > maxRun) {
          // Same run grows: one violation per run, with its final length.
          const v = [...violations].reverse().find((x) => x.tag === t);
          if (v) v.length = n;
        }
      }
    });
    const tagNov: number[] = [];
    const labNov: number[] = [];
    for (let i = 1; i < acting.length; i++) {
      tagNov.push(1 - jaccard(tagSets[i], tagSets[i - 1]));
      labNov.push(1 - jaccard(words(acting[i].label ?? ""), words(acting[i - 1].label ?? "")));
    }
    const historyRepeats = acting.filter((x) => repeatsHistory(x.kind, x.tags ?? [], x.history ?? [], neutral)).length;
    sessions.push({
      sessionId,
      answers: acting.length,
      distinct: distinct.size,
      tags: [...distinct].sort(),
      longestRun: longest,
      violations,
      tagNovelty: mean(tagNov),
      labelNovelty: mean(labNov),
      historyRepeats,
    });
  }
  const active = sessions.filter((s) => s.answers > 0);
  const violations = sessions.reduce((a, s) => a + s.violations.length, 0);
  return {
    sessions,
    distinctPerSession: mean(active.map((s) => s.distinct)),
    distinctTotal: allTags.size,
    violations,
    sessionsWithViolation: sessions.filter((s) => s.violations.length > 0).length,
    historyRepeats: sessions.reduce((a, s) => a + s.historyRepeats, 0),
    tagNovelty: mean(active.filter((s) => s.answers > 1).map((s) => s.tagNovelty)),
    labelNovelty: mean(active.filter((s) => s.answers > 1).map((s) => s.labelNovelty)),
    pass: violations === 0,
  };
}
