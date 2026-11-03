/**
 * Where the viewer gets a session log from: the proxy's read endpoints
 * (shared lab password) or a local JSONL file. Pure fetch logic, injectable.
 */

export interface SessionListing {
  sessionId: string;
  /** Log size, when the server reports it (the proxy lists ids only). */
  bytes?: number;
}

export class AuthError extends Error {
  constructor(message = "wrong or missing lab password") {
    super(message);
    this.name = "AuthError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const base = (api: string) => api.replace(/\/+$/, "");

async function get(api: string, path: string, password: string, f: FetchLike): Promise<Response> {
  let res: Response;
  try {
    res = await f(`${base(api)}${path}`, { headers: { Authorization: `Bearer ${password}` } });
  } catch (e) {
    throw new Error(`could not reach the replay server (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res.status === 401 || res.status === 403) throw new AuthError();
  if (res.status === 404) throw new Error("no such session");
  if (res.status === 503) throw new Error("replay reading is not enabled on this server (no read password configured)");
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  return res;
}

export async function listSessions(api: string, password: string, f: FetchLike = fetch): Promise<SessionListing[]> {
  const res = await get(api, "/replay/sessions", password, f);
  const body = (await res.json()) as { sessions?: SessionListing[] };
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export async function fetchSessionLog(api: string, sessionId: string, password: string, f: FetchLike = fetch): Promise<string> {
  const res = await get(api, `/replay/sessions/${encodeURIComponent(sessionId)}`, password, f);
  return res.text();
}

/** Link to open a session in the viewer: `<viewer>?api=<proxy>#<sessionId>`. */
export function shareLink(viewerUrl: string, api: string, sessionId: string, t?: number): string {
  const u = new URL(viewerUrl);
  u.search = "";
  u.hash = "";
  u.searchParams.set("api", base(api));
  u.hash = t && t > 0 ? `${sessionId}@${Math.round(t)}` : sessionId;
  return u.toString();
}

/** Parse `#<sessionId>` or `#<sessionId>@<ms>` from a location hash. */
export function parseHash(hash: string): { sessionId: string; t: number } | null {
  const m = /^#?([A-Za-z0-9._-]{1,128})(?:@(\d{1,9}))?$/.exec(hash);
  return m ? { sessionId: m[1], t: m[2] ? Number(m[2]) : 0 } : null;
}
