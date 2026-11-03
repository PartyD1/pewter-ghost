/**
 * The Jev's prompt: a short, cheap "is now a good moment?" question, rendered
 * here so the proxy (/when), eval and tests share one text. Kept apart from
 * the fill prompt bundle on purpose: editing it never changes PROMPT_VERSION.
 */
import type { JevRequest, JevVerdict, RenderedPrompt } from "../../contracts";
import { sha256HexSync } from "../../fill/hash";

export const JEV_SYSTEM = `You decide WHEN an autocomplete "ghost" should appear in a 2D platformer level editor.

A person paints tiles. Another model proposes the next piece of level as a faint ghost the person can keep (Tab), ignore, or draw over. A ghost at a good moment saves them work. A ghost at a bad moment interrupts them, and they dismiss it. You are asked every second or two; answer about this moment only.

You see the window around their work (ASCII grid: # solid, . empty, other letters per the legend), their recent placements with the ms between them, activity numbers, the ghost that is ready to show ("held", if any), and how their last ghosts went.

Answer suggest: true when a ghost now would probably be kept:
- they paused after finishing a stroke or a structure;
- the held ghost clearly completes or continues what they were drawing;
- they have been keeping ghosts.
Answer suggest: false when:
- they are mid-stroke on something the held ghost does not continue;
- they are erasing;
- they dismissed the last ghosts;
- nothing is held and the window holds nothing to build on;
- a ghost is already showing.

p is your probability (0 to 1) that a ghost shown now would be kept. why is six words or fewer.
Return one JSON object only: {"suggest": true|false, "p": number, "why": "..."}`;

export const JEV_PROMPT_VERSION = `jev.v1-${sha256HexSync(new TextEncoder().encode(JEV_SYSTEM)).slice(0, 8)}`;

export const jevResponseSchema: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    suggest: { type: "BOOLEAN" },
    p: { type: "NUMBER", minimum: 0, maximum: 1 },
    why: { type: "STRING" },
  },
  required: ["suggest", "p", "why"],
  propertyOrdering: ["suggest", "p", "why"],
};

export function renderJevUser(r: JevRequest): string {
  const a = r.activity;
  const recent = r.recent.length
    ? r.recent.map((p) => `${p.tool === "erase" ? "erase" : p.tile}(${p.x},${p.y}) +${Math.round(p.dt)}ms`).join(" · ")
    : "none";
  const held = r.held
    ? `${r.held.kind} "${r.held.label}", ${r.held.cells} cells at (${r.held.anchor.x},${r.held.anchor.y}), its own confidence ${r.held.confidence.toFixed(2)}`
    : "none";
  const ghosts = r.lastGhosts.length ? r.lastGhosts.map((g) => `${g.kind} "${g.label}" ${g.outcome}`).join(" · ") : "none yet";
  return [
    r.grid,
    `recent (oldest first): ${recent}`,
    `activity: idle ${Math.round(a.idleMs)} ms; ${a.placements2s} placements in the last 2 s, ${a.placements10s} in 10 s; ` +
      `${Math.round(a.eraseShare * 100)}% erases; ${a.dismissRun} dismissals since the last kept ghost; ` +
      `recent keep rate ${a.acceptRate5.toFixed(2)}`,
    `held ghost: ${held}`,
    `showing now: ${r.showing ? "yes" : "no"}`,
    `last ghosts (oldest first): ${ghosts}`,
  ].join("\n");
}

export function renderJevPrompt(r: JevRequest): RenderedPrompt {
  return { system: JEV_SYSTEM, user: renderJevUser(r), responseSchema: jevResponseSchema, promptVersion: JEV_PROMPT_VERSION };
}

/** Strict parse; null on garbage. p is clamped to 0..1, why trimmed to 60 characters. */
export function parseJevVerdict(raw: unknown): JevVerdict | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.suggest !== "boolean") return null;
  const p = typeof o.p === "number" && Number.isFinite(o.p) ? Math.min(1, Math.max(0, o.p)) : o.suggest ? 1 : 0;
  const why = typeof o.why === "string" ? o.why.trim().slice(0, 60) : "";
  return { suggest: o.suggest, p, why };
}

/** Cheap structural check of a JevRequest (proxy). Returns a problem or null. */
export function jevRequestProblem(r: unknown): string | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "request must be an object";
  const q = r as Partial<JevRequest>;
  if (typeof q.grid !== "string" || !q.grid) return "grid must be a non-empty string";
  if (!Array.isArray(q.recent)) return "recent must be an array";
  if (!q.activity || typeof q.activity !== "object") return "activity must be an object";
  for (const k of ["idleMs", "placements2s", "placements10s", "eraseShare", "dismissRun", "acceptRate5"] as const)
    if (typeof q.activity[k] !== "number" || !Number.isFinite(q.activity[k])) return `activity.${k} must be a number`;
  if (q.held !== null && (typeof q.held !== "object" || typeof q.held?.label !== "string")) return "held must be null or a ghost";
  if (typeof q.showing !== "boolean") return "showing must be a boolean";
  if (!Array.isArray(q.lastGhosts)) return "lastGhosts must be an array";
  return null;
}
