/**
 * Zod schemas for every LogEvent variant (contracts.ts, plan §14).
 *
 * Two flavours:
 *  - `logEventSchema`: tolerant of extra fields (what the proxy accepts, so a
 *    newer client never loses events to an older server).
 *  - `strictLogEventSchema`: rejects unknown fields (tests and dev builds catch typos).
 */
import { z } from "zod";
import type { LogEvent } from "../contracts";

type Mode = "loose" | "strict";

const finite = () => z.number().finite();
const nonNeg = () => z.number().finite().min(0);
const int = () => z.number().int();

const fillerName = z.enum(["llm", "algo", "stub", "jev"]);
const fillMode = z.enum(["auto", "requested", "patrol", "tidy"]);
const suggestionKind = z.enum(["finish", "extend", "fix"]);
const verdictStage = z.enum(["shape", "measure", "repeat", "rules", "agent"]);
const shownBecause = z.enum(["now", "pause", "longPause", "requested", "patrol"]);
const ghostOutcome = z.enum(["accepted", "partial", "esc", "drawn-over", "replaced", "timeout", "pending"]);
const entityKind = z.enum(["coin", "fruit", "slime", "ultraslime", "flag", "sign"]);
const author = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const point = z.object({ x: finite(), y: finite() });
const tileValue = z.union([
  int().min(0),
  z.templateLiteral([z.literal("entity:"), entityKind]),
]);

function build(mode: Mode) {
  const obj = <S extends z.ZodRawShape>(shape: S) => (mode === "strict" ? z.strictObject(shape) : z.looseObject(shape));

  const session = obj({
    type: z.literal("session"),
    t: nonNeg(),
    sessionId: z.string().min(1),
    commit: z.string(),
    promptVersion: z.string(),
    briefVersion: z.string(),
    model: z.string(),
    filler: z.union([fillerName, z.literal("none")]),
    config: z.record(z.string(), z.unknown()),
  });

  const placementShape = {
    t: nonNeg(),
    x: int(),
    y: int(),
    tile: tileValue,
    author,
    stroke: z.string(),
    tool: z.enum(["paint", "erase"]),
  };
  const place = obj({ type: z.literal("place"), ...placementShape });
  const erase = obj({ type: z.literal("erase"), ...placementShape });

  const fillCall = obj({
    type: z.literal("fill.call"),
    t: nonNeg(),
    requestHash: z.string(),
    mode: fillMode,
    superseded: z.boolean(),
    latencyMs: nonNeg(),
    act: z.boolean().nullable(),
    kind: suggestionKind.optional(),
    confidence: z.number().min(0).max(1).optional(),
    tiles: int().min(0).optional(),
    verdictStage: z.union([verdictStage, z.literal("ok")]).optional(),
    reason: z.string().optional(),
    sendBack: z.boolean().optional(),
    error: z.string().optional(),
  });

  const ghostShow = obj({
    type: z.literal("ghost.show"),
    t: nonNeg(),
    suggestionId: z.string().min(1),
    kind: suggestionKind,
    confidence: z.number().min(0).max(1),
    shownBecause,
    cells: int().min(0),
    label: z.string(),
  });

  const ghostEnd = obj({
    type: z.literal("ghost.end"),
    t: nonNeg(),
    suggestionId: z.string().min(1),
    outcome: ghostOutcome,
    dwellMs: nonNeg(),
    acceptedCells: int().min(0).optional(),
  });

  const patrol = obj({
    type: z.literal("patrol"),
    t: nonNeg(),
    beatable: z.boolean(),
    blockedAt: point.optional(),
    ms: nonNeg(),
  });

  const playStart = obj({ type: z.literal("play.start"), t: nonNeg() });
  const playEnd = obj({
    type: z.literal("play.end"),
    t: nonNeg(),
    reachedGoal: z.boolean(),
    deaths: int().min(0),
  });

  const what = z.enum(["own", "ghost", "mixed"]);
  const undo = obj({ type: z.literal("undo"), t: nonNeg(), what });
  const redo = obj({ type: z.literal("redo"), t: nonNeg(), what });
  const save = obj({ type: z.literal("save"), t: nonNeg(), snapshotId: z.string().min(1) });

  const variants = {
    session,
    place,
    erase,
    "fill.call": fillCall,
    "ghost.show": ghostShow,
    "ghost.end": ghostEnd,
    patrol,
    "play.start": playStart,
    "play.end": playEnd,
    undo,
    redo,
    save,
  } as const;

  const union = z.discriminatedUnion("type", [
    session,
    place,
    erase,
    fillCall,
    ghostShow,
    ghostEnd,
    patrol,
    playStart,
    playEnd,
    undo,
    redo,
    save,
  ]);
  return { variants, union };
}

const loose = build("loose");
const strict = build("strict");

/** Per-variant schemas keyed by `type` (loose flavour). */
export const eventSchemas = loose.variants;
/** Per-variant schemas keyed by `type` (strict flavour). */
export const strictEventSchemas = strict.variants;
export const logEventSchema = loose.union;
export const strictLogEventSchema = strict.union;

export type LogEventType = LogEvent["type"];
export const LOG_EVENT_TYPES = Object.keys(loose.variants) as LogEventType[];

// Compile-time proof that the schema and the contract agree in both directions.
type Parsed = z.infer<typeof strictLogEventSchema>;
type _SchemaCoversContract = LogEvent extends Parsed ? true : never;
type _ContractCoversSchema = Parsed extends LogEvent ? true : never;
const _a: _SchemaCoversContract = true;
const _b: _ContractCoversSchema = true;
void _a;
void _b;

export type ValidationResult =
  | { ok: true; event: LogEvent }
  | { ok: false; error: string };

/**
 * Validate one event. Never throws. On success returns the event as given
 * (extra fields kept in loose mode). The error is a short human-readable path list.
 */
export function validateEvent(value: unknown, opts: { strict?: boolean } = {}): ValidationResult {
  const schema = opts.strict ? strictLogEventSchema : logEventSchema;
  let res;
  try {
    res = schema.safeParse(value);
  } catch (e) {
    return { ok: false, error: `validator crashed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.success) return { ok: true, event: value as LogEvent };
  return { ok: false, error: formatIssues(value, res.error.issues) };
}

/** True when `value` is a valid LogEvent. */
export function isLogEvent(value: unknown, opts: { strict?: boolean } = {}): value is LogEvent {
  return validateEvent(value, opts).ok;
}

function formatIssues(value: unknown, issues: readonly z.core.$ZodIssue[]): string {
  const type =
    value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
      ? (value as { type: string }).type
      : undefined;
  const head = type ? `${type}: ` : "";
  const parts = issues.slice(0, 5).map((i) => {
    const path = i.path.length ? i.path.map(String).join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  if (issues.length > 5) parts.push(`(+${issues.length - 5} more)`);
  return head + parts.join("; ");
}
