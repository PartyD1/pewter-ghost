/**
 * G-21 / G-25 / G-26 — the design brief.
 *
 * Two parts:
 *  - STATIC (prompts/brief/*.md, bundled): pattern catalogue, level-type rules,
 *    classic styles as rules, placement rules for coins and enemies (with the
 *    coin-arc offset table from @jump-tables), the variety rule and fix
 *    guidance. It goes in the system prompt (fill/prompt.ts), so it is the same
 *    for every request and can be cached upstream.
 *  - DYNAMIC (buildBrief, per request): measured numbers for the last two
 *    screens up to the frontier (@measure), the patterns detected there, the
 *    model's own last level-type guess, the last ghosts with outcomes and the
 *    variety constraint that follows from them, and optionally reference
 *    examples (G-31). It goes in FillRequest.brief, so it is hashed into the
 *    request and replayable.
 *
 * BRIEF_VERSION covers both: a hash of the static text plus the dynamic
 * format number. Budgets are asserted (assertBriefBudget, and tests).
 */
import {
  analyzeWindow,
  measuresOf,
  measureWindow,
  SCREEN_COLS,
  contentBounds,
  type EntityLike,
  type GridLike,
  type Rect,
  type WindowMeasures,
} from "@measure";
import { arcTableText, knightLimits } from "@jump-tables";
import type {
  GhostHistoryItem,
  GhostOutcome,
  KnightLimits,
  LevelSnapshot,
  MeasuredNumbers,
} from "../contracts";
import { config as liveConfig } from "../suggest/config";
import { BRIEF_FRAGMENTS } from "../../../../prompts/bundle";
import { sha256HexSync } from "./hash";
import { estimateTokens, type MeasureFn } from "./window";
import { ExampleLibrary, selectExamples, type ExampleOptions, type ExampleSelection } from "./examples";
import type { Chunk } from "@measure";

/** Bump when the dynamic part's wording or structure changes. */
export const BRIEF_DYNAMIC_FORMAT = 1;

/** Gap widths whose coin offsets the placement fragment lists (level targets). */
export const ARC_TABLE_GAPS = [2, 3, 4, 5, 6, 7, 8];

/** Token budgets (estimateTokens: ~4 chars per token). */
export const BRIEF_BUDGET = {
  /** The static brief inside the system prompt. */
  staticTokens: 2200,
  /** The dynamic part without examples. */
  dynamicTokens: 450,
  /** Reference examples appended to the dynamic part. */
  examplesTokens: 400,
} as const;

const indent = (text: string, pad: string) =>
  text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");

function assembleStatic(): string {
  const arcs = indent(arcTableText(0, ARC_TABLE_GAPS), "  ");
  const parts = [
    BRIEF_FRAGMENTS.catalogue,
    BRIEF_FRAGMENTS.types,
    BRIEF_FRAGMENTS.styles,
    BRIEF_FRAGMENTS.placement.replace("{{ARC_TABLE}}", arcs),
    BRIEF_FRAGMENTS.variety,
    BRIEF_FRAGMENTS.fix,
  ];
  return parts.map((p) => p.trim()).join("\n\n");
}

/** The static brief (Markdown), as it appears in the system prompt. */
export const BRIEF_STATIC: string = assembleStatic();

const hash8 = (text: string) => sha256HexSync(new TextEncoder().encode(text)).slice(0, 8);

/** "brief.v1-<hash of the static text and the dynamic format>". */
export const BRIEF_VERSION: string = `brief.v1-${hash8(`${BRIEF_STATIC}\n#dynamic=${BRIEF_DYNAMIC_FORMAT}`)}`;

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/** What the brief can measure: a snapshot, or any grid with its entities. */
export type BriefLevel = LevelSnapshot | (GridLike & { entities: readonly EntityLike[] });

/**
 * The rectangle of "the last `screens` screens" up to the screen holding
 * column `frontierX` (screens are SCREEN_COLS wide from x = 0, as in
 * @measure recentScreens and the validator), full level height.
 */
export function briefRect(level: Pick<GridLike, "w" | "h">, frontierX: number, screens = 2): Rect {
  const i = Math.max(0, Math.min(Math.ceil(level.w / SCREEN_COLS) - 1, Math.floor(frontierX / SCREEN_COLS)));
  const x0 = Math.max(0, (i - Math.max(1, screens) + 1) * SCREEN_COLS);
  const x1 = Math.min(level.w, (i + 1) * SCREEN_COLS);
  return { x: x0, y: 0, w: x1 - x0, h: level.h };
}

/**
 * A MeasureFn for buildFillRequest (window.ts) that measures the window with
 * @measure. Pass it as `measure` so FillRequest.measured is real.
 */
export const measureRequestWindow: MeasureFn = (model, rect) => {
  const snap = model.snapshot();
  return measureWindow(snap, snap.entities, rect);
};

// ---------------------------------------------------------------------------
// Dynamic text
// ---------------------------------------------------------------------------

const pct = (v: number) => `${Math.round(v * 100)}%`;
const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "0");

const GAP_BINS = ["0-20%", "20-40%", "40-60%", "60-80%", "80%+"];

/** The measured block ("Drawing so far ..."). Exported for tests and the status line. */
export function describeMeasures(m: WindowMeasures, rect: Rect, knight: KnightLimits): string {
  const lines: string[] = [];
  const screens = Math.max(1, Math.round(rect.w / SCREEN_COLS));
  lines.push(`Drawing so far (last ${screens === 1 ? "screen" : `${screens} screens`}, level x ${rect.x}..${rect.x + rect.w - 1}):`);
  if (m.counts.solids === 0 && m.counts.collectables === 0 && m.counts.enemies === 0) {
    lines.push("- nothing drawn here yet; follow the person's first strokes.");
    return lines.join("\n");
  }
  lines.push(
    `- density ${num(m.density)}, verticality ${num(m.verticality)}, linearity ${num(m.linearity)}, ` +
      `difficulty ${num(m.difficulty)} (0 easy, 1 hard), leniency ${num(m.leniency)}`,
  );
  if (m.counts.gaps > 0) {
    const hist = m.gapHist
      .map((share, i) => (share > 0 ? `${GAP_BINS[i]} ${pct(share)}` : ""))
      .filter(Boolean)
      .join(", ");
    lines.push(
      `- ${m.counts.gaps} gap jump${m.counts.gaps === 1 ? "" : "s"}; widths as a share of the run limit ${knight.maxGapRun}: ${hist}` +
        (m.meanLandingWidth > 0 ? `; landings ${num(m.meanLandingWidth, 1)} wide on average` : ""),
    );
  } else {
    lines.push("- no gap jumps yet");
  }
  if (m.counts.unreachable > 0) lines.push(`- ${m.counts.unreachable} jump(s) the knight cannot make: a fix may be due`);
  if (m.counts.collectables > 0) {
    lines.push(
      `- ${m.counts.collectables} reward${m.counts.collectables === 1 ? "" : "s"} (coins/fruit)` +
        (m.rewardSpacing > 0 ? `, one every ${num(m.rewardSpacing, 1)} tiles` : "") +
        (m.counts.coins > 0 ? `; coins on jump arcs ${pct(m.coinsOnArcShare)}, flat on floors ${pct(m.coinsOnFloorShare)}` : ""),
    );
  } else {
    lines.push("- no coins or fruit yet");
  }
  lines.push(
    m.counts.enemies > 0
      ? `- ${m.counts.enemies} enem${m.counts.enemies === 1 ? "y" : "ies"}, pressure ${num(m.pressure)} (share of landings with an enemy within 3 tiles)`
      : "- no enemies yet",
  );
  lines.push(`- patterns here: ${m.patterns.length ? m.patterns.join(", ") : "none recognised yet"}`);
  lines.push("Keep these numbers unless the drawing is clearly changing them.");
  return lines.join("\n");
}

const OUTCOME_TEXT: Record<GhostOutcome, string> = {
  accepted: "accepted",
  partial: "partly accepted (some cells painted by hand)",
  esc: "dismissed with Esc",
  "drawn-over": "dismissed (drawn over)",
  replaced: "replaced by a newer ghost (no verdict)",
  timeout: "ignored until it timed out",
  pending: "still showing",
};

const isAccepted = (o: GhostOutcome) => o === "accepted" || o === "partial";
const isDismissed = (o: GhostOutcome) => o === "esc" || o === "drawn-over";

/** History lines plus the variety rule that follows from it. */
export function describeHistory(lastGhosts: readonly GhostHistoryItem[]): string {
  if (!lastGhosts.length) return "No earlier ghosts in this session.";
  const lines = ["Recent ghosts (oldest first):"];
  lastGhosts.forEach((g, i) => {
    const tags = g.patterns && g.patterns.length ? ` [${g.patterns.join(", ")}]` : "";
    lines.push(`${i + 1}. ${g.kind} "${g.label}"${tags}: ${OUTCOME_TEXT[g.outcome] ?? g.outcome}`);
  });
  lines.push(varietyRule(lastGhosts));
  return lines.join("\n");
}

/** The G-25 constraint as one or two sentences. */
export function varietyRule(lastGhosts: readonly GhostHistoryItem[]): string {
  const accepted = lastGhosts.filter((g) => isAccepted(g.outcome)).slice(-2);
  const dismissed = lastGhosts.filter((g) => isDismissed(g.outcome));
  const parts: string[] = [];
  if (accepted.length) {
    const names = accepted.map((g) => (g.patterns && g.patterns.length ? g.patterns.join("+") : `"${g.label}"`));
    parts.push(
      `Variety: the last ${accepted.length === 1 ? "accepted ghost was" : "two accepted were"} ${names.join(" and ")}. ` +
        `An extend must use a different pattern from ${accepted.length === 1 ? "it" : "both"}.`,
    );
  } else {
    parts.push("Variety: nothing accepted yet, so any pattern that fits is fine.");
  }
  if (dismissed.length) {
    const labels = [...new Set(dismissed.map((g) => `"${g.label}"`))];
    parts.push(`Do not offer again: ${labels.join(", ")} (dismissed).`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// buildBrief
// ---------------------------------------------------------------------------

export interface BriefContext {
  /** The level to measure (LevelModel.snapshot(), or a grid with entities). */
  level?: BriefLevel;
  /** Level column of the frontier (default: right edge of the drawn content). */
  frontierX?: number;
  /** Screens to measure, ending at the frontier's screen (default 2). */
  screens?: number;
  /** Precomputed measures (skips measuring); `rect` should come with them. */
  measures?: WindowMeasures;
  rect?: Rect;
  /** The model's levelGuess from its last answer. */
  lastGuess?: string;
  /** Past ghosts, oldest first (trimmed to `historyCount`). */
  lastGhosts?: readonly GhostHistoryItem[];
  /** Default config.historyCount. */
  historyCount?: number;
  knight?: KnightLimits;
  /** G-31 reference examples: a library (or chunks) and options. Off when omitted. */
  examples?: { library: ExampleLibrary | readonly Chunk[]; target?: MeasuredNumbers } & ExampleOptions;
  /** Budget for the dynamic part without examples (default BRIEF_BUDGET.dynamicTokens). */
  maxTokens?: number;
}

export interface Brief {
  /** Goes in FillRequest.brief. */
  text: string;
  /** Goes in FillRequest.briefVersion. */
  version: string;
  tokens: number;
  measures?: WindowMeasures;
  rect?: Rect;
  /** Patterns detected in the measured screens. */
  patterns: string[];
  /** Ids of the reference chunks included. */
  examples: string[];
}

export class BriefBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefBudgetError";
  }
}

function measureFor(ctx: BriefContext): { m?: WindowMeasures; rect?: Rect } {
  if (ctx.measures) return { m: ctx.measures, rect: ctx.rect };
  const level = ctx.level;
  if (!level) return {};
  let fx = ctx.frontierX;
  if (fx === undefined) {
    const b = contentBounds(level, level.entities);
    fx = b ? b.x + b.w - 1 : 0;
  }
  const rect = briefRect(level, fx, ctx.screens ?? 2);
  return { m: measuresOf(analyzeWindow(level, level.entities, rect)), rect };
}

/** Clip a guess to a short single line. */
const cleanGuess = (g: string) => g.replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * The dynamic brief for one request. Deterministic for equal inputs.
 * Throws BriefBudgetError if the text (without examples) exceeds the budget,
 * which only happens with absurd history labels; callers may catch and fall
 * back to a shorter history.
 */
export function buildBrief(ctx: BriefContext = {}): Brief {
  const knight = ctx.knight ?? knightLimits();
  const history = (ctx.lastGhosts ?? []).slice(-Math.max(0, ctx.historyCount ?? liveConfig.historyCount));
  const { m, rect } = measureFor(ctx);

  const sections: string[] = [];
  if (m && rect) sections.push(describeMeasures(m, rect, knight));
  else sections.push("Drawing so far: not measured for this request.");
  const guess = ctx.lastGuess ? cleanGuess(ctx.lastGuess) : "";
  sections.push(
    guess
      ? `Your last guess at the level type: ${guess}. Keep it or revise it in levelGuess.`
      : "You have not guessed the level type yet. Give one in levelGuess.",
  );
  sections.push(describeHistory(history));

  // Trim history labels if over budget (rare): drop oldest items first.
  const maxTokens = ctx.maxTokens ?? BRIEF_BUDGET.dynamicTokens;
  let text = sections.join("\n");
  let h = history;
  while (estimateTokens(text) > maxTokens && h.length > 0) {
    h = h.slice(1);
    sections[2] = describeHistory(h);
    text = sections.join("\n");
  }
  if (estimateTokens(text) > maxTokens)
    throw new BriefBudgetError(`dynamic brief is ${estimateTokens(text)} tokens; budget ${maxTokens}`);

  let picked: ExampleSelection | undefined;
  if (ctx.examples) {
    const target: MeasuredNumbers | undefined =
      ctx.examples.target ??
      (m
        ? {
            density: m.density,
            gapHist: m.gapHist,
            verticality: m.verticality,
            rewardSpacing: m.rewardSpacing,
            pressure: m.pressure,
            difficulty: m.difficulty,
            patterns: m.patterns,
          }
        : undefined);
    if (target) {
      const lib = ctx.examples.library;
      const chunks = lib instanceof ExampleLibrary ? lib.chunks : lib;
      picked = selectExamples(chunks, target, {
        ...ctx.examples,
        maxTokens: Math.min(ctx.examples.maxTokens ?? BRIEF_BUDGET.examplesTokens, BRIEF_BUDGET.examplesTokens),
      });
      if (picked.text) text += "\n" + picked.text;
    }
  }

  return {
    text,
    version: BRIEF_VERSION,
    tokens: estimateTokens(text),
    measures: m,
    rect,
    patterns: m ? [...m.patterns] : [],
    examples: picked ? picked.picked.map((p) => p.chunk.id) : [],
  };
}

/** Throws BriefBudgetError when a brief is over the combined dynamic + examples budget. */
export function assertBriefBudget(brief: Pick<Brief, "text">): void {
  const max = BRIEF_BUDGET.dynamicTokens + BRIEF_BUDGET.examplesTokens;
  const t = estimateTokens(brief.text);
  if (t > max) throw new BriefBudgetError(`brief is ${t} tokens; budget ${max}`);
}

/**
 * Caches the brief between placements (the timing budget wants the brief to
 * be a cached string). The key is whatever the caller says identifies the
 * inputs: level revision, frontier screen, history and last guess.
 */
export class BriefCache {
  private key = "";
  private value: Brief | undefined;
  hits = 0;
  misses = 0;

  get(ctx: BriefContext & { revision: number }): Brief {
    const fx = ctx.frontierX ?? -1;
    const screen = fx < 0 ? -1 : Math.floor(fx / SCREEN_COLS);
    const key = JSON.stringify([
      ctx.revision,
      screen,
      ctx.screens ?? 2,
      ctx.lastGuess ?? "",
      ctx.lastGhosts ?? [],
      ctx.historyCount ?? liveConfig.historyCount,
      ctx.examples ? (ctx.examples.library instanceof ExampleLibrary ? ctx.examples.library.size : ctx.examples.library.length) : 0,
    ]);
    if (this.value && key === this.key) {
      this.hits++;
      return this.value;
    }
    this.misses++;
    this.value = buildBrief(ctx);
    this.key = key;
    return this.value;
  }

  clear(): void {
    this.key = "";
    this.value = undefined;
  }
}
