/**
 * G-14 — Prompt v1: render a FillRequest for the model, the structured-output
 * schema, and strict parsing of the model's answer.
 *
 * Contract (contracts.ts "Prompt rendering"):
 *   PROMPT_VERSION: string
 *   renderFillPrompt(req: FillRequest): RenderedPrompt
 *   parseModelAnswer(raw: unknown): ModelAnswer | null
 *
 * system = prompts/fill.v1.md (knight numbers filled in from @jump-tables)
 *        + the static design brief (fill/brief.ts)
 *        + six few-shot examples (prompts/fewshot, rendered exactly like a live request)
 *   It is identical for every request, so the upstream can cache it.
 * user   = the request: grid, recent placements, frontier, knight, mode,
 *          blockedAt / previous failure, measured numbers, the dynamic brief
 *          (req.brief), last ghosts, summary of the rest of the level.
 *
 * PROMPT_VERSION = "fill.v1-<8 hex of sha256(system)>", so any change to the
 * prompt, brief, few-shots or jump tables shows up in the log.
 *
 * Parsing decisions (documented in docs/decisions.md):
 *  - `raw` may be the parsed JSON or the text (a ```json fence is stripped).
 *  - `act` must be a boolean. With act=false everything else is optional and
 *    the answer is normalised to empty arrays and confidence 0.
 *  - With act=true, `kind`, `label` and `confidence` are required; adds,
 *    removes and entities default to [] when missing.
 *  - Tile names and entity kinds are matched case-insensitively with "-" or
 *    " " read as "_" ("Grass-Half" -> grass_half); anything else outside the
 *    enums rejects the whole answer (a schema miss, counted in G-14 metrics).
 *  - Coordinates must be integers (3.0 is fine, 3.5 is not) within ±1000.
 *    Window bounds are checked later by fill/answer.ts, which drops cells.
 *  - confidence must be a finite number in [-0.05, 1.05] and is clamped to
 *    [0, 1]. Anything outside (85, -1, "high") rejects the answer: a model that
 *    answers on another scale cannot be trusted to rank its suggestions.
 *  - At most ANSWER_LIMITS.maxItems cells in total; more rejects.
 *  - Unknown extra keys are ignored. levelGuess is trimmed to 60 chars; a
 *    non-string levelGuess is dropped, not rejected.
 */
import { z } from "zod";
import { knightLimits, maxGap } from "@jump-tables";
import type {
  EntityKind,
  FillRequest,
  GhostHistoryItem,
  KnightLimits,
  MeasuredNumbers,
  ModelAnswer,
  RecentPlacement,
  RenderedPrompt,
  SuggestionKind,
  TileName,
} from "../contracts";
import { FEWSHOTS, FILL_PROMPT_V1 } from "../../../../prompts/bundle";
import { BRIEF_STATIC } from "./brief";
import { sha256HexSync } from "./hash";

// ---------------------------------------------------------------------------
// Enums and the response schema
// ---------------------------------------------------------------------------

export const TILE_NAMES: readonly TileName[] = ["grass", "dirt", "block", "grass_half", "question"];
export const ENTITY_KIND_NAMES: readonly EntityKind[] = ["coin", "fruit", "slime", "ultraslime", "flag", "sign"];
export const KIND_NAMES: readonly SuggestionKind[] = ["finish", "extend", "fix"];

/** Output key order: label and guess before the cells (the model commits to an idea, then draws it); confidence last. */
export const ANSWER_KEY_ORDER = ["act", "kind", "label", "levelGuess", "adds", "removes", "entities", "confidence"] as const;

export const ANSWER_LIMITS = {
  /** Most cells (adds + removes + entities) in one answer. */
  maxItems: 200,
  /** Largest |coordinate| accepted (window-relative; anything near this is garbage). */
  maxCoord: 1000,
  /** Confidence outside [-tol, 1 + tol] rejects; inside, it is clamped to [0, 1]. */
  confidenceTolerance: 0.05,
  levelGuessChars: 60,
} as const;

const cellSchema = (extra: Record<string, unknown>, order: string[]) => ({
  type: "OBJECT",
  properties: { x: { type: "INTEGER" }, y: { type: "INTEGER" }, ...extra },
  required: order,
  propertyOrdering: order,
});

/** Gemini responseSchema (OpenAPI subset). */
export const responseSchema: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    act: { type: "BOOLEAN", description: "false = nothing worth suggesting now" },
    kind: { type: "STRING", enum: [...KIND_NAMES] },
    label: { type: "STRING", description: "caption, 8 words or fewer; a fix states the measurement" },
    levelGuess: { type: "STRING", description: "parkour | maze | collect-a-thon | story | speedrun | mixed" },
    adds: {
      type: "ARRAY",
      items: cellSchema({ tile: { type: "STRING", enum: [...TILE_NAMES] } }, ["x", "y", "tile"]),
    },
    removes: { type: "ARRAY", items: cellSchema({}, ["x", "y"]) },
    entities: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { kind: { type: "STRING", enum: [...ENTITY_KIND_NAMES] }, x: { type: "INTEGER" }, y: { type: "INTEGER" } },
        required: ["kind", "x", "y"],
        propertyOrdering: ["kind", "x", "y"],
      },
    },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
  },
  required: ["act", "kind", "label", "adds", "removes", "entities", "confidence"],
  propertyOrdering: [...ANSWER_KEY_ORDER],
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const normName = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : v);
const normKind = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

const coord = z
  .number()
  .refine((n) => Number.isInteger(n) && Math.abs(n) <= ANSWER_LIMITS.maxCoord, "coordinate must be an integer within range");

const addZ = z.object({
  x: coord,
  y: coord,
  tile: z.preprocess(normName, z.enum(TILE_NAMES as [TileName, ...TileName[]])),
});
const removeZ = z.object({ x: coord, y: coord });
const entityZ = z.object({
  kind: z.preprocess(normName, z.enum(ENTITY_KIND_NAMES as [EntityKind, ...EntityKind[]])),
  x: coord,
  y: coord,
});
const kindZ = z.preprocess(normKind, z.enum(KIND_NAMES as [SuggestionKind, ...SuggestionKind[]]));

const actTrueZ = z.object({
  act: z.literal(true),
  kind: kindZ,
  label: z.string(),
  levelGuess: z.unknown().optional(),
  adds: z.array(addZ).default([]),
  removes: z.array(removeZ).default([]),
  entities: z.array(entityZ).default([]),
  confidence: z
    .number()
    .refine(
      (c) => Number.isFinite(c) && c >= -ANSWER_LIMITS.confidenceTolerance && c <= 1 + ANSWER_LIMITS.confidenceTolerance,
      "confidence must be in [0, 1]",
    ),
});

const actFalseZ = z.object({
  act: z.literal(false),
  kind: kindZ.optional().catch(undefined),
  label: z.string().optional().catch(undefined),
  levelGuess: z.unknown().optional(),
});

export interface ParseResult {
  answer: ModelAnswer | null;
  /** Why the answer was rejected (for logs and the suite). */
  error?: string;
}

/** Strip a ```json ... ``` fence and surrounding whitespace. */
export function stripJsonFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1] : t;
}

function cleanGuess(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, ANSWER_LIMITS.levelGuessChars) : undefined;
}

/** parseModelAnswer with the rejection reason. */
export function parseModelAnswerDetailed(raw: unknown): ParseResult {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(stripJsonFence(value));
    } catch {
      return { answer: null, error: "not JSON" };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { answer: null, error: "not a JSON object" };
  const act = (value as { act?: unknown }).act;
  if (act === false) {
    const r = actFalseZ.safeParse(value);
    if (!r.success) return { answer: null, error: zodMessage(r.error) };
    const a: ModelAnswer = {
      act: false,
      kind: r.data.kind ?? "extend",
      adds: [],
      removes: [],
      entities: [],
      confidence: 0,
      label: (r.data.label ?? "").trim(),
    };
    const guess = cleanGuess(r.data.levelGuess);
    if (guess) a.levelGuess = guess;
    return { answer: a };
  }
  if (act !== true) return { answer: null, error: "act must be true or false" };
  const r = actTrueZ.safeParse(value);
  if (!r.success) return { answer: null, error: zodMessage(r.error) };
  const d = r.data;
  const items = d.adds.length + d.removes.length + d.entities.length;
  if (items > ANSWER_LIMITS.maxItems) return { answer: null, error: `too many cells (${items} > ${ANSWER_LIMITS.maxItems})` };
  const a: ModelAnswer = {
    act: true,
    kind: d.kind,
    adds: d.adds.map((c) => ({ x: c.x, y: c.y, tile: c.tile })),
    removes: d.removes.map((c) => ({ x: c.x, y: c.y })),
    entities: d.entities.map((e) => ({ kind: e.kind, x: e.x, y: e.y })),
    confidence: Math.max(0, Math.min(1, d.confidence)),
    label: d.label.trim(),
  };
  const guess = cleanGuess(d.levelGuess);
  if (guess) a.levelGuess = guess;
  return { answer: a };
}

function zodMessage(e: z.ZodError): string {
  const first = e.issues[0];
  if (!first) return "invalid answer";
  const path = first.path.length ? first.path.join(".") : "answer";
  return `${path}: ${first.message}`;
}

/** Strict validation of a model answer; null on anything that does not fit the schema. */
export function parseModelAnswer(raw: unknown): ModelAnswer | null {
  return parseModelAnswerDetailed(raw).answer;
}

/** An answer as compact JSON in ANSWER_KEY_ORDER (the format shown in few-shots). */
export function answerJson(a: ModelAnswer): string {
  const o: Record<string, unknown> = {};
  for (const k of ANSWER_KEY_ORDER) if (a[k] !== undefined) o[k] = a[k];
  return JSON.stringify(o);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Widest-gap table by height difference, for the system prompt. */
export function knightReachTable(): string {
  const dys = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4];
  const head = (dy: number) => (dy < 0 ? `rise ${-dy}` : dy === 0 ? "level" : dy === 4 ? "drop 4+" : `drop ${dy}`);
  const cols = dys.map(head);
  const w = Math.max(...cols.map((c) => c.length));
  const cell = (s: string | number) => String(s).padStart(w);
  const label = (s: string) => s.padEnd(13);
  return [
    label("") + cols.map(cell).join(" "),
    label("full run-up") + dys.map((dy) => cell(maxGap(dy, true))).join(" "),
    label("standing") + dys.map((dy) => cell(maxGap(dy, false))).join(" "),
  ]
    .map((l) => "    " + l.trimEnd())
    .join("\n");
}

function fillTemplate(md: string, k: KnightLimits): string {
  const vars: Record<string, string> = {
    RUN: String(k.maxGapRun),
    STAND: String(k.maxGapStand),
    RISE: String(k.maxRise),
    REACH_TABLE: knightReachTable(),
    STAND_RISE2: String(maxGap(-2, false)),
    RUN_RISE4: String(maxGap(-4, true)),
  };
  return md.replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`prompt template variable ${all} has no value`);
    return v;
  });
}

const MODE_TEXT: Record<FillRequest["mode"], string> = {
  auto: "auto (fired by the person's last placement; they may still be drawing)",
  requested: "requested (the person pressed Ctrl+Space and wants an idea now)",
  patrol: "patrol (the physics agent playing from the start is stuck at blockedAt; answer with a fix there)",
};

const OUTCOME_SHORT: Record<string, string> = {
  accepted: "accepted",
  partial: "partly accepted",
  esc: "dismissed (Esc)",
  "drawn-over": "dismissed (drawn over)",
  replaced: "replaced",
  timeout: "timed out",
  pending: "showing",
};

/** One placement as "grass (3,9) +120". */
function placementText(r: RecentPlacement): string {
  const what = r.tool === "erase" ? "erase" : r.tile;
  return `${what} (${r.x},${r.y}) +${Math.max(0, Math.round(r.dt))}`;
}

function recentText(recent: readonly RecentPlacement[]): string {
  if (!recent.length) return "recent: none (nothing placed yet this session)";
  return `recent (oldest first; tile (x,y) +ms since the previous placement): ${recent.map(placementText).join(" · ")}`;
}

function historyText(h: readonly GhostHistoryItem[]): string {
  if (!h.length) return "last ghosts: none";
  return (
    "last ghosts (oldest first): " +
    h
      .map((g) => {
        const tags = g.patterns && g.patterns.length ? ` [${g.patterns.join(", ")}]` : "";
        return `${g.kind} "${g.label}"${tags} ${OUTCOME_SHORT[g.outcome] ?? g.outcome}`;
      })
      .join(" · ")
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function measuredText(m: MeasuredNumbers): string {
  const bins = ["0-20", "20-40", "40-60", "60-80", "80+"];
  const gaps = m.gapHist.some((v) => v > 0)
    ? m.gapHist
        .map((v, i) => (v > 0 ? `${bins[i]}% ${pct(v)}` : ""))
        .filter(Boolean)
        .join(", ")
    : "none";
  const parts = [
    `density ${m.density.toFixed(2)}`,
    `verticality ${m.verticality.toFixed(2)}`,
    `gap widths as share of run limit: ${gaps}`,
    `reward spacing ${m.rewardSpacing > 0 ? m.rewardSpacing.toFixed(1) + " tiles" : "no rewards"}`,
    `enemy pressure ${m.pressure.toFixed(2)}`,
  ];
  if (m.difficulty !== undefined) parts.push(`difficulty ${m.difficulty.toFixed(2)}`);
  if (m.patterns && m.patterns.length) parts.push(`patterns ${m.patterns.join(", ")}`);
  return `measured (this window): ${parts.join("; ")}`;
}

export interface RenderUserOptions {
  /** Few-shot form: no measured numbers, brief or summary. */
  compact?: boolean;
}

/** The request as the model reads it (also used for the few-shot examples). */
export function renderUserMessage(
  req: Pick<FillRequest, "grid" | "origin" | "size" | "recent" | "frontier" | "mode" | "lastGhosts" | "knight"> &
    Partial<Pick<FillRequest, "measured" | "brief" | "summary" | "blockedAt" | "previousFailure">>,
  opts: RenderUserOptions = {},
): string {
  const out: string[] = [];
  out.push(`mode: ${MODE_TEXT[req.mode] ?? req.mode}`);
  out.push(req.grid);
  out.push(recentText(req.recent));
  out.push(`frontier: (${req.frontier.x},${req.frontier.y}), idle ${Math.max(0, Math.round(req.frontier.idleMs))} ms`);
  const k = req.knight;
  out.push(`knight: clears gaps of ${k.maxGapStand} standing, ${k.maxGapRun} with a run-up; rises ${k.maxRise} at most`);
  if (req.blockedAt) out.push(`blockedAt: (${req.blockedAt.x},${req.blockedAt.y}), the agent could not get past this cell`);
  if (req.previousFailure) {
    out.push(
      `previous failure (stage ${req.previousFailure.stage}; LEVEL coordinates, subtract the window origin ` +
        `(${req.origin.x},${req.origin.y})): ${req.previousFailure.reason}`,
    );
  }
  if (!opts.compact) {
    if (req.measured) out.push(measuredText(req.measured));
    if (req.summary) out.push(`rest of the level: ${req.summary}`);
  }
  out.push(historyText(req.lastGhosts));
  if (!opts.compact && req.brief) out.push(`\nDesign notes for this request:\n${req.brief.trim()}`);
  return out.join("\n");
}

function renderFewShots(): string {
  const blocks = FEWSHOTS.map((s, i) =>
    [
      `### Example ${i + 1}: ${s.title}`,
      renderUserMessage(s.request, { compact: true }),
      `Answer: ${answerJson(s.answer)}`,
      `Why: ${s.why}`,
    ].join("\n"),
  );
  return [
    "## Examples",
    "Six past requests with good answers. The grids omit the legend line and the requests omit the measured numbers and notes. Everything else is exactly what you will receive.",
    ...blocks,
  ].join("\n\n");
}

function buildSystem(): string {
  const k = knightLimits();
  return [
    fillTemplate(FILL_PROMPT_V1, k).trim(),
    "# Design brief\n\n" + BRIEF_STATIC.trim(),
    renderFewShots(),
    "Now answer the request below with the JSON object only.",
  ].join("\n\n");
}

/** The system prompt (identical for every request). */
export const SYSTEM_PROMPT: string = buildSystem();

/** "fill.v1-<first 8 hex of sha256(system prompt)>". */
export const PROMPT_VERSION: string = `fill.v1-${sha256HexSync(new TextEncoder().encode(SYSTEM_PROMPT)).slice(0, 8)}`;

/** Render a request for the model (pure; the proxy, eval and smoke script call this). */
export function renderFillPrompt(req: FillRequest): RenderedPrompt {
  return {
    system: SYSTEM_PROMPT,
    user: renderUserMessage(req),
    responseSchema,
    promptVersion: PROMPT_VERSION,
  };
}
