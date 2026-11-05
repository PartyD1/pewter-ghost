/**
 * Timeline data for the replay viewer: segments (things with a duration) and
 * markers (instants), grouped into tracks like a video editor's timeline.
 *
 *   suggestions  each ghost, shown -> ended, coloured by outcome
 *   api          each model / timing / patrol call, from request to answer
 *   edits        each stroke, plus undo / redo / ghost-accept / save markers
 *   input        bursts of pointer, key and wheel activity (gaps >= 1.5 s are idle)
 *   play         play-mode runs
 *   away         stretches with the window unfocused or the tab hidden
 */
import type { LogEvent } from "../../contracts";
import type { Replay } from "./replay";

export type TrackId = "suggestions" | "api" | "edits" | "input" | "play" | "away";

export const TRACK_ORDER: readonly TrackId[] = ["suggestions", "api", "edits", "input", "play", "away"];

export interface Segment {
  id: string;
  track: TrackId;
  start: number;
  end: number;
  label: string;
  /** Colour key: ghost outcome, call result, "person", ... */
  kind: string;
}

export interface Marker {
  id: string;
  track: TrackId;
  t: number;
  label: string;
  kind: string;
}

export interface Tracks {
  duration: number;
  segments: Segment[];
  markers: Marker[];
}

/** Pointer / key activity closer together than this belongs to one burst. */
export const ACTIVITY_GAP_MS = 1500;

export function buildTracks(replay: Replay): Tracks {
  const segments: Segment[] = [];
  const markers: Marker[] = [];
  const n: Record<string, number> = {};
  const id = (track: string) => `${track}-${(n[track] = (n[track] ?? 0) + 1)}`;
  const seg = (track: TrackId, start: number, end: number, label: string, kind: string) =>
    segments.push({ id: id(track), track, start, end: Math.max(start, end), label, kind });
  const mark = (track: TrackId, t: number, label: string, kind: string) => markers.push({ id: id(track), track, t, label, kind });

  const { ghosts, play, focus } = replay.internals;

  for (const g of ghosts) seg("suggestions", g.startT, g.endT, `${g.kind} · ${g.label}`, g.outcome ?? "open");

  const strokes = new Map<string, { start: number; end: number; count: number; tool: string }>();
  const activity: number[] = [];
  for (const e of replay.events) {
    switch (e.type) {
      case "fill.call": {
        const kind = e.superseded ? "dropped" : e.error ? "error" : e.act === false ? "no-act" : "suggested";
        const what = e.superseded ? `dropped${e.reason ? ` (${e.reason})` : ""}` : e.error ? `error: ${e.error}` : e.act === false ? "no suggestion" : `${e.kind ?? "suggestion"} ${e.confidence !== undefined ? e.confidence.toFixed(2) : ""}`.trim();
        seg("api", e.t - e.latencyMs, e.t, `fill ${e.mode} · ${Math.round(e.latencyMs)} ms · ${what}`, kind);
        break;
      }
      case "timing":
        if (e.latencyMs !== undefined && e.latencyMs > 0)
          seg("api", e.t - e.latencyMs, e.t, `timing ${e.stage} · ${Math.round(e.latencyMs)} ms · ${e.decision}`, e.decision === "error" ? "error" : "timing");
        break;
      case "patrol":
        seg("api", e.t - e.ms, e.t, `patrol · ${e.beatable ? "beatable" : "blocked"} · ${Math.round(e.ms)} ms`, e.beatable ? "patrol-ok" : "patrol-blocked");
        break;
      case "place":
      case "erase": {
        const s = strokes.get(e.stroke);
        if (s) {
          s.end = e.t;
          s.count++;
        } else strokes.set(e.stroke, { start: e.t, end: e.t, count: 1, tool: e.tool });
        break;
      }
      case "undo":
      case "redo":
        mark("edits", e.t, `${e.type} (${e.what})`, e.type);
        break;
      case "delta":
        if (e.source === "ghost") mark("edits", e.t, `ghost applied · ${e.cells.length} cells`, "ghost-accept");
        break;
      case "save":
        mark("edits", e.t, "save", "save");
        break;
      case "variant":
        mark("api", e.t, `variant: ${e.filler} / ${e.timing}`, "variant");
        break;
      case "pointer.path":
        for (let k = 0; k < e.dt.length; k++) activity.push(e.t + e.dt[k]);
        break;
      case "pointer.btn":
      case "key":
      case "wheel":
        activity.push(e.t);
        break;
      default:
        break;
    }
  }
  for (const s of strokes.values()) seg("edits", s.start, s.end, `${s.tool} ×${s.count}`, s.tool === "erase" ? "erase" : "person");

  for (const p of play) {
    const endEv = replay.events.find((e): e is Extract<LogEvent, { type: "play.end" }> => e.type === "play.end" && e.t === p.end);
    seg("play", p.start, p.end, endEv ? `play · ${endEv.reachedGoal ? "reached goal" : "did not finish"} · ${endEv.deaths} deaths` : "play", endEv?.reachedGoal ? "goal" : "play");
  }

  // Input bursts.
  activity.sort((a, b) => a - b);
  let start = NaN;
  let prev = NaN;
  for (const t of activity) {
    if (Number.isNaN(start)) start = t;
    else if (t - prev >= ACTIVITY_GAP_MS) {
      seg("input", start, prev, "active", "active");
      start = t;
    }
    prev = t;
  }
  if (!Number.isNaN(start)) seg("input", start, prev, "active", "active");

  // Away: focus false .. focus true.
  let awayFrom: number | null = null;
  for (const f of focus) {
    if (!f.v && awayFrom === null) awayFrom = f.t;
    else if (f.v && awayFrom !== null) {
      seg("away", awayFrom, f.t, "away (unfocused or tab hidden)", "away");
      awayFrom = null;
    }
  }
  if (awayFrom !== null) seg("away", awayFrom, replay.duration, "away (unfocused or tab hidden)", "away");

  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  markers.sort((a, b) => a.t - b.t);
  return { duration: replay.duration, segments, markers };
}

/** Sorted, de-duplicated start times of the given tracks (segment starts and markers). */
export function navPoints(tracks: Tracks, ids: readonly TrackId[] = TRACK_ORDER): number[] {
  const want = new Set(ids);
  const ts = new Set<number>();
  for (const s of tracks.segments) if (want.has(s.track)) ts.add(s.start);
  for (const m of tracks.markers) if (want.has(m.track)) ts.add(m.t);
  return [...ts].sort((a, b) => a - b);
}

/** The next point after t (dir 1) or the previous point before t (dir -1); null at the ends. */
export function stepPoint(points: readonly number[], t: number, dir: 1 | -1, epsilon = 1): number | null {
  if (dir === 1) {
    for (const p of points) if (p > t + epsilon) return p;
    return null;
  }
  for (let i = points.length - 1; i >= 0; i--) if (points[i] < t - epsilon) return points[i];
  return null;
}
