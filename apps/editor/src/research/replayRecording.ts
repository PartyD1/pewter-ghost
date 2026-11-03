/**
 * Starts session-replay recording on a ready editor: raw input (InputRecorder)
 * and level / camera / tool state (StateRecorder), both writing to `log`.
 * Returns one cleanup. Never throws: a recording problem must not break editing.
 */
import type { LogEvent } from "../contracts";
import type { EditorApi } from "../editor/api";
import type { Brush } from "../editor/modes";
import { InputRecorder } from "./inputRecorder";
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

export function startReplayRecording(api: EditorApi, log: (e: LogEvent) => void, clock: () => number): () => void {
  const cleanups: (() => void)[] = [];
  try {
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
