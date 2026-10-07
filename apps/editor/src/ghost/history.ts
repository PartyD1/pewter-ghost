/**
 * The session's ghost history: written into Save task / autosave files
 * (SuggestionHistorySummary) and sent to the model as `lastGhosts`
 * (GhostHistoryItem). Pure.
 */
import type { GhostHistoryItem, GhostOutcome, Suggestion } from "../contracts";
import type { SuggestionHistoryItem, SuggestionHistorySummary } from "../level/save";
import { ghostCells } from "../suggest/geometry";

export class GhostHistory {
  private shownCount = 0;
  private outcomes: Partial<Record<GhostOutcome, number>> = {};
  private items: SuggestionHistoryItem[] = [];
  private patterns = new Map<string, string[]>();

  constructor(private readonly maxRecent = 30) {}

  /** A ghost appeared. Returns its 1-based ordinal in the session. */
  recordShow(s: Suggestion): number {
    this.shownCount++;
    return this.shownCount;
  }

  /** A shown ghost ended. */
  recordEnd(s: Suggestion, outcome: GhostOutcome, acceptedCells: number | undefined, t: number, patterns?: string[]): void {
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
    const item: SuggestionHistoryItem = {
      id: s.id,
      kind: s.kind,
      label: s.label,
      outcome,
      cells: ghostCells(s).length,
      t: Math.round(t),
    };
    if (acceptedCells !== undefined) item.acceptedCells = acceptedCells;
    this.items.push(item);
    if (patterns?.length) this.patterns.set(s.id, patterns);
    while (this.items.length > this.maxRecent) {
      const gone = this.items.shift();
      if (gone) this.patterns.delete(gone.id);
    }
  }

  get shown(): number {
    return this.shownCount;
  }

  summary(): SuggestionHistorySummary | undefined {
    if (this.shownCount === 0 && this.items.length === 0) return undefined;
    return { shown: this.shownCount, outcomes: { ...this.outcomes }, recent: this.items.map((i) => ({ ...i })) };
  }

  /** The last `n` ended ghosts, oldest first, for FillRequest.lastGhosts. */
  lastGhosts(n: number): GhostHistoryItem[] {
    return this.items.slice(-Math.max(0, n)).map((i) => {
      const g: GhostHistoryItem = { kind: i.kind, label: i.label, outcome: i.outcome };
      const p = this.patterns.get(i.id);
      if (p) g.patterns = [...p];
      return g;
    });
  }

  reset(): void {
    this.shownCount = 0;
    this.outcomes = {};
    this.items = [];
    this.patterns.clear();
  }
}
