/**
 * Live trace of what the recorder sees, printed to the browser console, so a
 * person (or a script reading the console) can watch keys, mouse buttons and
 * hovers as they are recorded.
 *
 *   ?trace=1                      turn it on from the address
 *   pewterLog.trace()             turn it on from the console (pewterLog.trace(false) to stop)
 *   localStorage["pewter.trace"]  "1" keeps it on across reloads
 *
 * Pure formatting plus a tiny state machine; the console and the clock are
 * injected so it runs in Node tests.
 */
import type { LogEvent, Point } from "../contracts";
import { Replay, type ReplayCamera } from "./replay/replay";

const BUTTON = ["left", "middle", "right"] as const;

export interface TraceOptions {
  print: (line: string) => void;
  enabled?: boolean;
}

export class ConsoleTrace {
  enabled: boolean;
  private camera: ReplayCamera | null = null;
  private lastTile = "";
  private t0: number | null = null;
  private readonly print: (line: string) => void;

  constructor(o: TraceOptions) {
    this.print = o.print;
    this.enabled = o.enabled ?? false;
  }

  set(on: boolean): void {
    this.enabled = on;
    if (on) this.announce();
  }

  /** One line saying the trace is on and how to stop it. */
  announce(): void {
    this.print("[pewter] trace on: keys, mouse buttons, wheel, hovers, focus and edits print here. Stop with pewterLog.trace(false)");
  }

  /** Feed every logged event (cheap when off: only the camera is remembered). */
  tap(e: LogEvent): void {
    this.t0 ??= e.t; // the clock starts at the first event, not at the first line printed
    if (e.type === "camera") this.camera = { x: e.x, y: e.y, w: e.w, h: e.h, zoom: e.zoom };
    if (!this.enabled) return;
    const line = this.describe(e);
    if (line) this.print(`[pewter ${this.stamp(e.t)}] ${line}`);
  }

  /** The editor's own hover cell (real time; the recorder's pointer batches arrive up to half a second late). */
  hover(cell: Point | undefined, nowMs: number): void {
    if (!this.enabled) return;
    const key = cell ? `${cell.x},${cell.y}` : "";
    if (key === this.lastTile) return;
    this.lastTile = key;
    this.print(`[pewter ${this.stamp(nowMs)}] hover ${cell ? `tile (${cell.x}, ${cell.y})` : "off the level"}`);
  }

  private stamp(t: number): string {
    this.t0 ??= t;
    return `+${((t - this.t0) / 1000).toFixed(2)}s`;
  }

  private tile(px: number, py: number): string {
    if (!this.camera) return "";
    const t = Replay.pixelToTile(this.camera, px, py);
    return ` tile (${t.x}, ${t.y})`;
  }

  private describe(e: LogEvent): string | null {
    switch (e.type) {
      case "key":
        return `key ${e.code} ${e.down ? "down" : "up"}`;
      case "pointer.btn":
        return `mouse ${BUTTON[e.button] ?? `button ${e.button}`} ${e.down ? "down" : "up"} at px (${e.x}, ${e.y})${this.tile(e.x, e.y)}`;
      case "wheel":
        return `wheel ${e.dy < 0 ? "up" : "down"} (${e.dy})${e.ctrl ? " with ctrl" : ""}`;
      case "pointer.edge":
        return `pointer ${e.inside ? "entered" : "left"} the canvas`;
      case "focus":
        return e.focused ? "window focused" : "window unfocused or tab hidden (away)";
      case "tool":
        return `tool ${e.mode} · ${e.brush}`;
      case "delta":
        return `edit by ${e.source}: ${e.cells.length} cell${e.cells.length === 1 ? "" : "s"}${e.entitiesAdded?.length ? `, +${e.entitiesAdded.length} entities` : ""}${e.entitiesRemoved?.length ? `, -${e.entitiesRemoved.length} entities` : ""}`;
      case "undo":
      case "redo":
        return `${e.type} (${e.what})`;
      case "ghost.show":
        return `ghost shown: ${e.kind} "${e.label}" (${e.cells} cells, confidence ${e.confidence.toFixed(2)})`;
      case "ghost.end":
        return `ghost ended: ${e.outcome} after ${(e.dwellMs / 1000).toFixed(1)} s`;
      case "play.start":
        return "play started";
      case "play.end":
        return `play ended (${e.reachedGoal ? "reached the goal" : "did not finish"}, ${e.deaths} deaths)`;
      default:
        return null; // pointer.path (see hover), camera, snapshot, fill.call, timing: not echoed
    }
  }
}
