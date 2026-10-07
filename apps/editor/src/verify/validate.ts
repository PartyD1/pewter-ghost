/**
 * G-15 / G-25 / G-26 — the validator: cheap checks that run before the
 * playtest agent, so obviously wrong answers never cost an agent run or reach
 * the screen.
 *
 * Stages, in order (the first failure is the verdict):
 *  1. shape   — integer coordinates inside the level; terrain tiles only; no
 *               adds over occupied cells unless kind "fix"; removes only in a
 *               fix and only on cells that hold something; entities in empty
 *               cells, enemies/flags/signs standing on ground; not empty
 *               unless the model said act=false; not absurdly large.
 *  2. repeat  — the same cell set as one of the last two ghosts, or (for the
 *               kinds in REPEAT_TAG_KINDS, i.e. Extend) the same pattern tags
 *               as BOTH of the last two ghosts (@measure tags).
 *  3. measure — on the merged level (the level as it would be after Tab):
 *               every gap the suggestion creates or lands on clearable at the
 *               design tier; for finish/extend also the density of the screen
 *               around it within a band around the drawing's last two
 *               screens, and gaps no wider than a band around the widest gap
 *               drawn so far (a fix is judged by playability instead);
 *               coins not flat on floors in a coin-looking level; enemies
 *               with >= 4 tiles of patrol and not within 2 tiles of a landing.
 *
 * Every reason is written for the model to read on send-back, in level
 * coordinates, with the measurement ("gap at x=41 is 9 wide; the knight
 * clears 8 with a full run-up").
 *
 * Pure functions, no Phaser.
 */
import {
  analyzeWindow,
  isStanding,
  measureLevel,
  recentScreens,
  SCREEN_COLS,
  type LevelMeasures,
  type PatternTag,
  type Rect,
  type WindowAnalysis,
} from "@measure";
import { DESIGN_TIER, FULL_RUNWAY, knightLimits, maxGap, type Tier } from "@jump-tables";
import {
  ENEMY_KINDS,
  SOLID_TILES,
  type LevelSnapshot,
  type Point,
  type Suggestion,
  type SuggestionKind,
  type Verdict,
  type VerdictStage,
} from "../contracts";
import { computePatrol, isEntityKind } from "../level/entities";
import {
  inBounds,
  mergeSuggestion,
  nowMs,
  snapshotOf,
  spanText,
  suggestionBounds,
  suggestionCells,
  type LevelSource,
} from "./merge";

/**
 * Every band and threshold the validator decides with. Start wide (plan:
 * "bands too tight reject good ideas"); tune from the offline suite.
 */
export const VALIDATION_BANDS = {
  /** Most cells (adds + removes + entities) one suggestion may touch. */
  maxCells: 160,
  /**
   * Density band: |merged - reference| <= densityAbs + densityRel * reference.
   * Started wide: the upper bound catches walls of solid fill. With
   * densityRel < 1 the lower bound bites only once the drawing is dense
   * (reference > densityAbs / (1 - densityRel) = 48%), e.g. an empty screen
   * offered after screens of dense terrain; below that it is 0 (upper-only).
   */
  densityAbs: 0.12,
  densityRel: 0.75,
  /** Widest gap the suggestion may involve, as a fraction of maxGapRun:
   * max(gapRatioFloor, widest gap in the last two screens + gapRatioSlack). */
  gapRatioSlack: 0.4,
  gapRatioFloor: 0.6,
  /** Screens of the drawing (up to the suggestion) the bands are taken from. */
  referenceScreens: 2,
  /** A level with at least this many coins (before the suggestion) is coin-looking ... */
  coinLevelMin: 4,
  /** ... as is a suggestion that adds at least this many coins. */
  coinGroupForLevel: 3,
  /** In a coin-looking level, at most this many suggested coins may lie flat on a floor. */
  floorCoinsMax: 1,
  /** Enemies need at least this many tiles of patrol (floor width). */
  enemyMinPatrol: 4,
  /** Enemies may not be within this many tiles (Chebyshev) of a landing. */
  enemyLandingClearance: 2,
  /** Tags that never count toward "same pattern as before" (they are everywhere). */
  neutralTags: ["rest"] as readonly string[],
  /** Suggestion kinds the same-tags repeat rule applies to (G-25: Extend). */
  repeatTagKinds: ["extend"] as readonly SuggestionKind[],
};

export type ValidationBands = typeof VALIDATION_BANDS;

/** A past ghost for the repeat check. Any of Suggestion, GhostHistoryItem or plain cells fits. */
export interface RecentGhost {
  kind?: SuggestionKind;
  /** Cells it touched (if absent, taken from adds/removes/entities). */
  cells?: readonly Point[];
  adds?: readonly Point[];
  removes?: readonly Point[];
  entities?: readonly Point[];
  /** Pattern tags (GhostHistoryItem.patterns). */
  patterns?: readonly string[];
}

export interface ValidateContext {
  /** Past ghosts, OLDEST FIRST; the last two are compared. */
  lastGhosts?: readonly RecentGhost[];
  /** The model's act flag; act=false allows an empty answer. */
  act?: boolean;
  /** Column the reference screens end at (the person's frontier). Default: just left of the suggestion. */
  frontierX?: number;
  /** Precomputed measures of the level BEFORE the suggestion (cache). */
  levelMeasures?: LevelMeasures;
  /** Band overrides. */
  bands?: Partial<ValidationBands>;
  tier?: Tier;
  /** Clock for Verdict.ms (tests). */
  now?: () => number;
}

/** Validation verdict plus what the later stages and the logger can reuse. */
export interface ValidationVerdict extends Verdict {
  /** Pattern tags of the structures the suggestion is part of. */
  tags?: PatternTag[];
}

type Edits = Pick<Suggestion, "kind" | "adds" | "removes" | "entities">;

interface Fail {
  stage: VerdictStage;
  reason: string;
}

/** Run every validation stage; first failure wins. */
export function validateSuggestion(
  level: LevelSource,
  suggestion: Edits,
  ctx: ValidateContext = {},
): ValidationVerdict {
  const clock = ctx.now ?? nowMs;
  const t0 = clock();
  const bands: ValidationBands = { ...VALIDATION_BANDS, ...ctx.bands };
  const before = snapshotOf(level);
  const done = (stage: VerdictStage, ok: boolean, reason?: string, tags?: PatternTag[]): ValidationVerdict => {
    const v: ValidationVerdict = { ok, stage, ms: clock() - t0 };
    if (reason !== undefined) v.reason = reason;
    if (tags) v.tags = tags;
    return v;
  };

  const shape = checkShape(before, suggestion, ctx, bands);
  if (shape) return done(shape.stage, false, shape.reason);
  if (suggestionCells(suggestion).length === 0) return done("shape", true, "nothing to suggest", []);

  const merged = mergeSuggestion(before, suggestion);
  const tier = ctx.tier ?? DESIGN_TIER;
  const rect = analysisRect(merged, suggestion, tier);
  const analysis = analyzeWindow(merged, merged.entities, rect, { tier });
  const tags = suggestionTags(analysis, suggestion, bands);

  const repeat = checkRepeat(suggestion, tags, ctx.lastGhosts ?? [], bands);
  if (repeat) return done(repeat.stage, false, repeat.reason, tags);

  const measure =
    checkMeasure(before, merged, analysis, suggestion, ctx, bands, tier) ??
    checkCollectables(before, merged, suggestion, bands) ??
    checkEnemies(merged, analysis, suggestion, bands);
  if (measure) return done(measure.stage, false, measure.reason, tags);

  return done("measure", true, undefined, tags);
}

// ---------------------------------------------------------------------------
// Stage 1: shape
// ---------------------------------------------------------------------------

const fmtP = (p: Point) => `(${p.x},${p.y})`;

function checkShape(
  snap: LevelSnapshot,
  s: Edits,
  ctx: ValidateContext,
  bands: ValidationBands,
): Fail | null {
  const fail = (reason: string): Fail => ({ stage: "shape", reason });
  const adds = Array.isArray(s.adds) ? s.adds : null;
  const removes = Array.isArray(s.removes) ? s.removes : null;
  const entities = Array.isArray(s.entities) ? s.entities : null;
  if (!adds || !removes || !entities) return fail("the answer must have adds, removes and entities lists");
  const total = adds.length + removes.length + entities.length;
  if (total === 0) return ctx.act === false ? null : fail("the answer changes nothing; return act=false instead of an empty suggestion");
  if (total > bands.maxCells)
    return fail(`the answer changes ${total} cells; keep one suggestion to at most ${bands.maxCells}`);

  const bad = [...adds, ...removes, ...entities].find(
    (p) => !p || !Number.isInteger(p.x) || !Number.isInteger(p.y),
  );
  if (bad) return fail(`cell (${bad?.x},${bad?.y}) is not on the tile grid; use whole-number coordinates`);
  const out = [...adds, ...removes, ...entities].find((p) => !inBounds(snap, p.x, p.y));
  if (out) return fail(`cell ${fmtP(out)} is outside the level (0..${snap.w - 1}, 0..${snap.h - 1})`);

  const isFix = s.kind === "fix";
  const tile = (p: Point) => snap.cells[p.y * snap.w + p.x];
  const entityAt = (p: Point) => snap.entities.find((e) => e.x === p.x && e.y === p.y);
  const key = (p: Point) => `${p.x},${p.y}`;

  const addKeys = new Set<string>();
  for (const a of adds) {
    if (!SOLID_TILES.has(a.tile)) return fail(`tile ${String(a.tile)} at ${fmtP(a)} is not a terrain tile`);
    if (addKeys.has(key(a))) return fail(`cell ${fmtP(a)} is added twice`);
    addKeys.add(key(a));
    if (a.x === snap.start.x && a.y === snap.start.y)
      return fail(`the tile at ${fmtP(a)} would bury the knight's start`);
    if (!isFix) {
      if (tile(a) !== 0)
        return fail(`cell ${fmtP(a)} already holds a tile; a ${s.kind} only adds to empty cells (use kind "fix" to change existing tiles)`);
      const e = entityAt(a);
      if (e) return fail(`cell ${fmtP(a)} holds a ${e.kind}; a ${s.kind} only adds to empty cells`);
    }
  }

  if (removes.length > 0 && !isFix)
    return fail(`removes are only allowed in a fix; this answer is a ${s.kind}`);
  const removeKeys = new Set<string>();
  for (const r of removes) {
    if (removeKeys.has(key(r))) return fail(`cell ${fmtP(r)} is removed twice`);
    removeKeys.add(key(r));
    if (tile(r) === 0 && !entityAt(r)) return fail(`cell ${fmtP(r)} is already empty; remove only cells that hold something`);
  }

  // Solid after the edits (for "standing on ground").
  const solidAfter = (x: number, y: number): boolean => {
    if (!inBounds(snap, x, y)) return false;
    const k = `${x},${y}`;
    if (addKeys.has(k)) return true;
    if (removeKeys.has(k)) return false;
    return SOLID_TILES.has(snap.cells[y * snap.w + x]);
  };
  const entityKeys = new Set<string>();
  let flags = snap.entities.filter((e) => e.kind === "flag").length;
  for (const e of entities) {
    if (!isEntityKind(e.kind)) return fail(`"${String(e.kind)}" at ${fmtP(e)} is not an entity kind`);
    if (entityKeys.has(key(e))) return fail(`two entities at ${fmtP(e)}`);
    entityKeys.add(key(e));
    if (addKeys.has(key(e))) return fail(`the ${e.kind} at ${fmtP(e)} sits inside a tile the answer adds`);
    if (tile(e) !== 0 && !removeKeys.has(key(e)))
      return fail(`the ${e.kind} at ${fmtP(e)} is inside a solid tile; entities go in empty cells`);
    const other = entityAt(e);
    if (other && !removeKeys.has(key(e))) return fail(`cell ${fmtP(e)} already holds a ${other.kind}`);
    if (e.x === snap.start.x && e.y === snap.start.y) return fail(`the ${e.kind} at ${fmtP(e)} is on the knight's start`);
    if ((ENEMY_KINDS.has(e.kind) || e.kind === "flag" || e.kind === "sign") && !solidAfter(e.x, e.y + 1))
      return fail(`the ${e.kind} at ${fmtP(e)} has no ground under it; put it on a surface (the cell above a solid tile)`);
    if (e.kind === "flag" && ++flags > 1) return fail(`the level already has a goal flag; there can be only one`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 2: repeat
// ---------------------------------------------------------------------------

function ghostCellKeys(g: RecentGhost): Set<string> {
  const pts = g.cells ?? [...(g.adds ?? []), ...(g.removes ?? []), ...(g.entities ?? [])];
  return new Set(pts.map((p) => `${p.x},${p.y}`));
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));

function checkRepeat(
  s: Edits,
  tags: PatternTag[],
  lastGhosts: readonly RecentGhost[],
  bands: ValidationBands,
): Fail | null {
  const recent = lastGhosts.slice(-2);
  if (recent.length === 0) return null;
  const mine = new Set(suggestionCells(s).map((p) => `${p.x},${p.y}`));
  for (let i = recent.length - 1; i >= 0; i--) {
    const cells = ghostCellKeys(recent[i]);
    if (cells.size > 0 && sameSet(mine, cells))
      return {
        stage: "repeat",
        reason: `this is the same ${mine.size} cells as ${i === recent.length - 1 ? "the last ghost" : "the ghost before last"}; suggest something different`,
      };
  }
  if (!bands.repeatTagKinds.includes(s.kind) || recent.length < 2) return null;
  const neutral = new Set(bands.neutralTags);
  const norm = (t: readonly string[] | undefined) => new Set((t ?? []).filter((x) => !neutral.has(x)));
  const mineTags = norm(tags);
  if (mineTags.size === 0) return null;
  if (recent.every((g) => sameSet(mineTags, norm(g.patterns)))) {
    const list = [...mineTags].join(", ");
    return {
      stage: "repeat",
      reason: `the last two ghosts were also ${list}; an extend must differ in pattern from both`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 3: measure (bands, gaps, collectables, enemies)
// ---------------------------------------------------------------------------

/**
 * The window the gap and enemy checks look at: the suggestion plus the
 * knight's longest jump (+4) each side, so the surfaces it jumps from and to are in
 * view; at least one screen wide; full height.
 */
function analysisRect(snap: LevelSnapshot, s: Edits, tier: Tier): Rect {
  const b = suggestionBounds(s)!;
  const pad = knightLimits(tier).maxGapRun + 4;
  let x0 = Math.max(0, b.x0 - pad);
  let x1 = Math.min(snap.w - 1, b.x1 + pad);
  while (x1 - x0 + 1 < Math.min(SCREEN_COLS, snap.w)) {
    if (x0 > 0) x0--;
    if (x1 < snap.w - 1) x1++;
  }
  return { x: x0, y: 0, w: x1 - x0 + 1, h: snap.h };
}

/** One screen (SCREEN_COLS, wider if the suggestion is) centred on the suggestion, full height. */
function screenRect(snap: LevelSnapshot, b: { x0: number; x1: number }): Rect {
  const w = Math.min(snap.w, Math.max(SCREEN_COLS, b.x1 - b.x0 + 1));
  const x = Math.max(0, Math.min(snap.w - w, Math.round((b.x0 + b.x1 + 1) / 2 - w / 2)));
  return { x, y: 0, w, h: snap.h };
}

function densityIn(snap: LevelSnapshot, r: Rect): number {
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (SOLID_TILES.has(snap.cells[y * snap.w + x])) n++;
  return r.w * r.h ? n / (r.w * r.h) : 0;
}

const near = (p: Point, b: { x0: number; x1: number; y0: number; y1: number }, d: number) =>
  p.x >= b.x0 - d && p.x <= b.x1 + d && p.y >= b.y0 - d && p.y <= b.y1 + d;

/** Tags of pattern hits that contain (or touch) a suggestion cell. */
function suggestionTags(a: WindowAnalysis, s: Edits, bands: ValidationBands): PatternTag[] {
  const cells = suggestionCells(s);
  const out = new Set<PatternTag>();
  for (const h of a.hits) if (cells.some((p) => near(p, h, 1))) out.add(h.tag);
  // Keep catalogue order (hits are already in catalogue order per tag).
  return a.patterns.filter((t) => out.has(t));
}

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function checkMeasure(
  before: LevelSnapshot,
  merged: LevelSnapshot,
  analysis: WindowAnalysis,
  s: Edits,
  ctx: ValidateContext,
  bands: ValidationBands,
  tier: Tier,
): Fail | null {
  const b = suggestionBounds(s)!;
  const lm = ctx.levelMeasures ?? measureLevel(before, { tier });
  const refX = ctx.frontierX ?? Math.max(0, b.x0 - 1);
  const ref = recentScreens(lm, refX, bands.referenceScreens).filter((sc) => sc.hasContent);
  const limits = knightLimits(tier);

  // Density band (finish / extend only: a fix is judged by playability).
  if (ref.length > 0 && s.kind !== "fix") {
    const refDensity = mean(ref.map((sc) => sc.measures.density));
    const tol = bands.densityAbs + bands.densityRel * refDensity;
    const lo = Math.max(0, refDensity - tol);
    const hi = refDensity + tol;
    const d = densityIn(merged, screenRect(merged, b));
    if (d > hi || d < lo) {
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      return {
        stage: "measure",
        reason: `with this suggestion the screen around ${spanText(b.x0, b.x1)} is ${pct(d)} solid; the drawing so far is ${pct(refDensity)} (keep it within ${pct(lo)}..${pct(hi)})`,
      };
    }
  }

  // Gaps the suggestion creates, widens, or takes off from / lands on.
  const added = new Set(s.adds.map((p) => `${p.x},${p.y}`));
  const changedCols = new Set([...s.adds, ...s.removes].map((p) => p.x));
  const surf = analysis.graph.surfaces;
  const surfaceTouched = (id: number) => {
    const sf = surf[id];
    for (let x = sf.x0; x <= sf.x1; x++) if (added.has(`${x},${sf.y + 1}`)) return true;
    return false;
  };
  const refMaxRatio = ref.length ? Math.max(...ref.map((sc) => sc.measures.difficultyParts.maxGapRatio)) : 0;
  const allowedRatio = Math.min(1, Math.max(bands.gapRatioFloor, refMaxRatio + bands.gapRatioSlack));
  const allowedGap = Math.floor(allowedRatio * limits.maxGapRun + 1e-9);
  for (const t of analysis.graph.transitions) {
    if (t.kind !== "jump") continue;
    const lo = Math.min(t.takeoff.x, t.landing.x);
    const hi = Math.max(t.takeoff.x, t.landing.x);
    let involved = surfaceTouched(t.from) || surfaceTouched(t.to);
    for (let x = lo + 1; x < hi && !involved; x++) if (changedCols.has(x)) involved = true;
    if (!involved) continue;
    const gx = lo + 1;
    const height = t.dy === 0 ? "" : t.dy < 0 ? ` and ${-t.dy} up` : ` and ${t.dy} down`;
    if (!t.reachable) {
      const clears = maxGap(t.dy, t.runway, tier);
      const full = maxGap(t.dy, FULL_RUNWAY, tier);
      const clearText =
        clears < 0
          ? `the knight cannot reach ${-t.dy} rows up`
          : `the knight clears ${clears}${t.runway < FULL_RUNWAY ? ` with a ${t.runway}-tile run-up (${full} with a full run-up)` : " with a full run-up"}`;
      return { stage: "measure", reason: `gap at x=${gx} is ${t.gap} wide${height}; ${clearText}` };
    }
    // The band is about style (finish / extend); a fix is judged by playability.
    if (s.kind !== "fix" && t.gap > allowedGap) {
      const refGap = Math.round(refMaxRatio * limits.maxGapRun);
      return {
        stage: "measure",
        reason: `gap at x=${gx} is ${t.gap} wide${height}; the drawing so far jumps at most ${refGap}, so keep gaps to ${allowedGap} or less here`,
      };
    }
  }
  return null;
}

function checkCollectables(before: LevelSnapshot, merged: LevelSnapshot, s: Edits, bands: ValidationBands): Fail | null {
  const coins = s.entities.filter((e) => e.kind === "coin");
  if (coins.length === 0) return null;
  const levelCoins = before.entities.filter((e) => e.kind === "coin").length;
  const coinLevel = levelCoins >= bands.coinLevelMin || coins.length >= bands.coinGroupForLevel;
  if (!coinLevel) return null;
  const onFloor = coins.filter((c) => isStanding(merged, c.x, c.y));
  if (onFloor.length <= bands.floorCoinsMax) return null;
  const xs = onFloor.map((c) => c.x).sort((a, b) => a - b);
  const rows = [...new Set(onFloor.map((c) => c.y))].join(",");
  return {
    stage: "measure",
    reason: `${onFloor.length} coins at ${spanText(xs[0], xs[xs.length - 1])} lie flat on the floor (row ${rows}); in a coin level put coins on the arc of a jump between two surfaces, up a climb, or over a pit`,
  };
}

function checkEnemies(merged: LevelSnapshot, a: WindowAnalysis, s: Edits, bands: ValidationBands): Fail | null {
  const enemies = s.entities.filter((e) => ENEMY_KINDS.has(e.kind));
  if (enemies.length === 0) return null;
  const reader = {
    w: merged.w,
    h: merged.h,
    isSolid: (x: number, y: number) => inBounds(merged, x, y) && SOLID_TILES.has(merged.cells[y * merged.w + x]),
  };
  const landings: Point[] = a.graph.transitions.filter((t) => t.kind !== "step").map((t) => t.landing);
  landings.push(merged.start);
  for (const e of enemies) {
    const p = computePatrol(reader, e.x, e.y);
    if (!p) return { stage: "shape", reason: `the ${e.kind} at ${fmtP(e)} has no floor to patrol` };
    const width = p[1] - p[0] + 1;
    if (width < bands.enemyMinPatrol)
      return {
        stage: "measure",
        reason: `the ${e.kind} at ${fmtP(e)} can patrol only ${width} tile${width === 1 ? "" : "s"} (${spanText(p[0], p[1])}); enemies need a floor at least ${bands.enemyMinPatrol} wide`,
      };
    for (const l of landings) {
      const d = Math.max(Math.abs(l.x - e.x), Math.abs(l.y - e.y));
      if (d <= bands.enemyLandingClearance)
        return {
          stage: "measure",
          reason: `the ${e.kind} at ${fmtP(e)} is ${d} tile${d === 1 ? "" : "s"} from where the knight lands at ${fmtP(l)}; keep enemies more than ${bands.enemyLandingClearance} tiles from a landing`,
        };
    }
  }
  return null;
}

/** Is the level (with the suggestion's coins) "coin-looking" by the G-26 rule? */
export function isCoinLevel(level: LevelSource, s?: Pick<Suggestion, "entities">, bands: ValidationBands = VALIDATION_BANDS): boolean {
  const snap = snapshotOf(level);
  const n = snap.entities.filter((e) => e.kind === "coin").length;
  const m = s ? s.entities.filter((e) => e.kind === "coin").length : 0;
  return n >= bands.coinLevelMin || m >= bands.coinGroupForLevel;
}
