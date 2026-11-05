/**
 * Starts session-replay recording on a ready editor: raw input (InputRecorder)
 * and level / camera / tool state (StateRecorder), both writing to `log`.
 * Returns one cleanup. Never throws: a recording problem must not break editing.
 */
import type { LogEvent } from "../contracts";
import type { EditorApi } from "../editor/api";
import type { Brush } from "../editor/modes";
import type { ConsoleTrace } from "./consoleTrace";
import { InputRecorder } from "./inputRecorder";
import type { EventLog } from "./log";
import { StateRecorder, type StateSource } from "./stateRecorder";

export const brushLabel = (b: Brush): string => (b.kind === "tile" ? `tile:${b.tile}` : b.kind === "entity" ? `entity:${b.entity}` : "start");

export function editorStateSource(api: EditorApi): StateSource {
  return {
    snapshot: () => api.model.snapshot(),
    onChange: (fn) => api.model.subscribe((c) => fn(c)),
    onLoaded: (fn) => api.on("level:loaded", () => fn()),
    onTool: (fn) => api.modes.subscribe((s) => fn({ mode: s.effective, brush: brushLabel(s.brush) })),
    viewTiles: () => api.camera.viewTiles(),
    zoom: () => api.camera.zoom,
    tool: () => ({ mode: api.modes.effective, brush: brushLabel(api.modes.brush) }),
  };
}

const TRACE_KEY = "pewter.trace";

/** Is the console trace asked for: `?trace=1`, or remembered from `pewterLog.trace()`? */
export function traceRequested(search: string): boolean {
  const p = new URLSearchParams(search).get("trace");
  if (p === "1" || p === "true") return true;
  if (p === "0" || p === "false") return false;
  try {
    return localStorage.getItem(TRACE_KEY) === "1";
  } catch {
    return false;
  }
}

/** What `window.pewterLog` offers in the browser console. */
export interface PewterLogApi {
  /** Print recorded keys, mouse buttons, hovers and edits as they happen. `trace(false)` stops. */
  trace(on?: boolean): boolean;
  /** Every event recorded so far this session. */
  events(): LogEvent[];
  /** The last `n` events (default 20). */
  tail(n?: number): LogEvent[];
  /** How many events were logged, sent, and are waiting to send. */
  stats(): unknown;
  /** Save this session's log as a .jsonl file. */
  download(): boolean;
}

export interface RecordingOptions {
  trace?: ConsoleTrace;
  eventLog?: () => EventLog | null;
}

export function startReplayRecording(api: EditorApi, log: (e: LogEvent) => void, clock: () => number, opts: RecordingOptions = {}): () => void {
  const cleanups: (() => void)[] = [];
  try {
    const { trace } = opts;
    if (trace) {
      // Hovers come from the editor in real time; the recorder's pointer batches would lag by up to half a second.
      cleanups.push(api.on("hover", (cell) => trace.hover(cell, clock())));
      const w = window as unknown as { pewterLog?: PewterLogApi };
      const store = () => opts.eventLog?.() ?? null;
      w.pewterLog = {
        trace: (on = true) => {
          trace.set(on);
          try {
            localStorage.setItem(TRACE_KEY, on ? "1" : "0");
          } catch {
            /* private window */
          }
          return on;
        },
        events: () => store()?.events() ?? [],
        tail: (n = 20) => store()?.events().slice(-n) ?? [],
        stats: () => store()?.getStats() ?? null,
        download: () => store()?.saveFile() ?? false,
      };
      cleanups.push(() => delete w.pewterLog);
    }
    const canvas = api.game.canvas;
    const source = editorStateSource(api);
    const input = new InputRecorder({
      log,
      clock,
      canvas: canvas as unknown as ConstructorParameters<typeof InputRecorder>[0]["canvas"],
      win: window,
      doc: document,
    });
    const state = new StateRecorder({ log, clock, source });
    state.start();
    input.start();
    cleanups.push(
      () => input.stop(),
      () => state.stop(),
    );
  } catch (e) {
    console.warn("replay recording could not start", e);
  }
  return () => {
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
  };
}
