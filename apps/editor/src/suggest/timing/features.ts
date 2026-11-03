/**
 * Feature vectors for the CDHF acceptance predictor (Mozannar et al. 2023, §4).
 *
 *   context (stage 1, before any model call): what the person is doing and how
 *     the last ghosts went, the analogue of the paper's "previous five actions"
 *     and "last five suggestions" telemetry;
 *   suggestion (stage 2, after verification): the ghost itself, the analogue of
 *     suggestion length, Copilot's confidence and its textual features.
 *
 * Every feature is scaled to roughly 0..3 and centred where a neutral value
 * exists, so the prior weights in model.ts read as plain log-odds. Names are
 * part of the log (TimingEvent.features) and of trained weight files: rename
 * one only with a new weights version.
 */
import type { FillMode, VerifiedSuggestion } from "../../contracts";
import type { ActivitySnapshot } from "./activity";

export const CONTEXT_FEATURES = [
  "idleSec",
  "rate2s",
  "rate10s",
  "eraseShare",
  "acceptRate5",
  "dismissRun",
  "sinceGhostSec",
  "tidy",
] as const;

export const SUGGESTION_FEATURES = ["confidence", "cells", "finish", "fix", "sendBack", "dist"] as const;

export const FULL_FEATURES = [...CONTEXT_FEATURES, ...SUGGESTION_FEATURES] as const;

export type FeatureName = (typeof FULL_FEATURES)[number];
export type Features = Partial<Record<FeatureName, number>>;

const cap = (v: number, hi: number) => Math.min(hi, Math.max(0, Number.isFinite(v) ? v : hi));

export function contextFeatures(a: ActivitySnapshot, mode: FillMode): Features {
  return {
    idleSec: cap(a.idleMs, 10_000) / 1000,
    rate2s: cap(a.placements2s, 20) / 10,
    rate10s: cap(a.placements10s, 60) / 30,
    eraseShare: cap(a.eraseShare, 1),
    acceptRate5: a.acceptRate5 - 0.5,
    dismissRun: cap(a.dismissRun, 5),
    sinceGhostSec: cap(a.sinceGhostMs, 30_000) / 1000 / 10,
    tidy: mode === "tidy" ? 1 : 0,
  };
}

export function suggestionFeatures(s: VerifiedSuggestion, a: ActivitySnapshot): Features {
  const cells = s.adds.length + s.removes.length + s.entities.length;
  const p = a.lastPlacement;
  const dist = p ? Math.max(Math.abs(s.anchor.x - p.x), Math.abs(s.anchor.y - p.y)) : 30;
  return {
    confidence: (Number.isFinite(s.confidence) ? s.confidence : 0) - 0.5,
    cells: cap(cells, 40) / 10,
    finish: s.kind === "finish" ? 1 : 0,
    fix: s.kind === "fix" ? 1 : 0,
    sendBack: s.attempts > 1 ? 1 : 0,
    dist: cap(dist, 30) / 10,
  };
}

export function fullFeatures(s: VerifiedSuggestion, a: ActivitySnapshot): Features {
  return { ...contextFeatures(a, s.mode), ...suggestionFeatures(s, a) };
}

/** Rounded copy for the log (keeps events small and diffs stable). */
export function roundFeatures(f: Features): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined) out[k] = Math.round(v * 1000) / 1000;
  return out;
}
