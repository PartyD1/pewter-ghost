/**
 * Default ghost wiring: importing this module starts the ghost session as
 * soon as the editor is ready (or at once if it already is) and disposes it
 * when the editor goes away. main.ts (integration) imports it; the ghost e2e
 * check loads it into a running dev server when main.ts does not yet.
 *
 * Fill orchestration (Ctrl+Space → a "requested" fill, verified offers) is
 * attached by the integration code through `getGhostSession()`.
 */
import { registerGhostStarter } from "../editor/api";
import { startGhost, type GhostSession } from "./session";

let current: GhostSession | null = null;

/** The running ghost session, if the editor is ready. */
export function getGhostSession(): GhostSession | null {
  return current;
}

registerGhostStarter((api) => {
  current?.dispose();
  const session = startGhost(api);
  current = session;
  return () => {
    session.dispose();
    if (current === session) current = null;
  };
});
