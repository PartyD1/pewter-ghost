/**
 * Web Worker entry for the playtest agent (G-16).
 *
 *   const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
 *   w.postMessage({ id: 1, type: "verify", grid, w: 200, h: 20, from, to, capMs: 300, xRange: [40, 66] });
 *   w.onmessage = (e) => e.data  // AgentResponse | AgentFailure with the same id
 *   w.postMessage({ id: 1, type: "cancel" });
 *
 * Usually driven through AgentClient (client.ts), which adds promises,
 * cancellation, a watchdog and an in-process fallback.
 */
import { AgentRunner, type AgentMessage, type AgentReply } from "./protocol";

/** The part of a worker global scope this module uses. */
export interface WorkerScopeLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: MessageEvent<AgentMessage>) => void): void;
}

/** Wire a runner to a worker scope (exported for tests). */
export function attachAgentWorker(scope: WorkerScopeLike, sliceMs = 12): AgentRunner {
  const runner = new AgentRunner((reply: AgentReply) => scope.postMessage(reply), sliceMs);
  scope.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;
    runner.handle(msg);
  });
  return runner;
}

// Attach only when actually running as a worker (not when imported by tests or the main thread).
if (typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope) {
  attachAgentWorker(self as unknown as WorkerScopeLike);
}
