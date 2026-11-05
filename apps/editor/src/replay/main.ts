/**
 * Session replay viewer, served at /replay. Loads a session log from the
 * proxy's read endpoints (shared lab password) or from a local .jsonl file,
 * then plays it back: the editor view re-rendered from events, a cursor
 * trail, and a timeline. The model is never called.
 *
 * On the same machine as the proxy it needs no setup: /replay signs in with
 * the local password ("dev") and lists the newest sessions. Elsewhere add
 * ?api=<proxy url> and type the lab password. #<sessionId>[@<ms>] opens one.
 */
import "./replay.css";
import { DEFAULT_CONFIG } from "../suggest/config";
import { Replay, type ReplayFrame, type ReplayGhostSummary } from "../research/replay/replay";
import { navPoints, stepPoint, TRACK_ORDER, type Marker, type Segment, type TrackId } from "../research/replay/tracks";
import { formatLength, isWatchable, sessionTitle } from "./format";
import { Player, quietGaps, SPEEDS } from "./player";
import { AuthError, fetchSessionLog, isLocalApi, listSessions, parseHash, shareLink, type SessionListing } from "./source";
import { drawFrame, STAGE_H, STAGE_W } from "./stage";
import { fmt, Timeline, TRACK_LABEL } from "./timeline";

const PW_KEY = "pewter-ghost.replay.password";
/** Stops the playing viewer's animation loop and key handler (set by viewer()). */
let stopViewer: (() => void) | null = null;
const app = document.getElementById("replay-app")!;
const params = new URLSearchParams(location.search);
/** The proxy to read from: ?api=, else the editor's default (http://localhost:8787). */
const apiBase = (params.get("api") ?? DEFAULT_CONFIG.proxyUrl).replace(/\/+$/, "");
/** On the proxy's own machine the password is the dev one, so there is nothing to type. */
const LOCAL_PASSWORD = "dev";

type Child = Node | string | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

const getPw = (): string => {
  try {
    return sessionStorage.getItem(PW_KEY) ?? "";
  } catch {
    return "";
  }
};
const setPw = (v: string): void => {
  try {
    sessionStorage.setItem(PW_KEY, v);
  } catch {
    /* private window: the password just is not remembered */
  }
};

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------

async function startScreen(message?: string): Promise<void> {
  stopViewer?.();
  const my = ++screenToken;
  const pw = getPw() || (isLocalApi(apiBase) ? LOCAL_PASSWORD : "");
  if (!pw) return loginScreen(message);
  app.replaceChildren(shell(h("p", { class: "rp-muted" }, "Looking for sessions…"), message));
  try {
    const list = await listSessions(apiBase, pw);
    if (my !== screenToken) return;
    setPw(pw);
    listScreen(list.sessions, list.total, message);
  } catch (e) {
    if (my !== screenToken) return;
    if (e instanceof AuthError) return loginScreen(getPw() ? "That password was not accepted." : message);
    problemScreen(e instanceof Error ? e.message : String(e));
  }
}
/** Ignore a screen's late answer when another screen has been asked for since. */
let screenToken = 0;

/** The frame every start screen shares: title, a one-line explanation, then the content. */
function shell(content: Node, message?: string): HTMLElement {
  return h(
    "div",
    { class: "rp-start" },
    h("h1", {}, "Pewter Ghost replay"),
    h("p", { class: "rp-muted" }, "Watch back a recorded session: the level as it was built, the suggestions shown, and where the pointer went."),
    message ? h("div", { class: "rp-err" }, message) : null,
    content,
    fileCard(),
  );
}

function loginScreen(message?: string): void {
  const pw = h("input", { type: "password", placeholder: "Lab password", autocomplete: "current-password" });
  pw.value = getPw();
  const go = h("button", { class: "primary" }, "Show sessions");
  const submit = () => {
    setPw(pw.value);
    void startScreen();
  };
  go.addEventListener("click", submit);
  pw.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  app.replaceChildren(shell(h("div", { class: "rp-card" }, h("strong", {}, "Lab password"), h("div", { class: "rp-row" }, pw, go)), message));
  pw.focus();
}

/** The server could not be reached or refused: say what to do, not just what failed. */
function problemScreen(detail: string): void {
  const retry = h("button", { class: "primary" }, "Try again");
  retry.addEventListener("click", () => void startScreen());
  const where = isLocalApi(apiBase)
    ? h("p", {}, "Replays are saved by the local server. Start the app with ", h("code", {}, "npm run dev"), ", use the editor for a bit, then try again.")
    : h("p", {}, `Looked for the session server at ${apiBase}.`);
  app.replaceChildren(shell(h("div", { class: "rp-card" }, h("strong", {}, "Can't load sessions"), h("p", { class: "rp-err" }, detail), where, h("div", { class: "rp-row" }, retry))));
}

function listScreen(all: SessionListing[], total: number, message?: string): void {
  const now = Date.now();
  const watchable = all.filter(isWatchable);
  const hidden = all.filter((s) => !isWatchable(s));
  const content = h("div");
  const row = (s: SessionListing, muted = false): HTMLElement => {
    const t = sessionTitle(s, now);
    const b = h("button", { class: `rp-session${muted ? " muted" : ""}` }, h("span", { class: "rp-s-title" }, t.title), h("span", { class: "rp-s-sub" }, muted ? `${t.sub || "no details"} · nothing to replay` : t.sub));
    b.addEventListener("click", () => void openRemote(s.sessionId, 0));
    return b;
  };

  if (watchable.length) {
    const latest = watchable[0];
    const t = sessionTitle(latest, now);
    const big = h("button", { class: "primary rp-latest" }, h("span", { class: "rp-latest-main" }, "▶ Watch the latest session"), h("span", { class: "rp-latest-sub" }, `${t.title}${t.sub ? ` · ${t.sub}` : ""}`));
    big.addEventListener("click", () => void openRemote(latest.sessionId, 0));
    content.append(big);
    if (watchable.length > 1) content.append(h("h2", { class: "rp-h2" }, "Recent sessions"), h("div", { class: "rp-list" }, ...watchable.slice(1).map((s) => row(s))));
  } else {
    const editor = h("a", { href: "../", target: "_blank", rel: "noopener" }, "Open the editor");
    content.append(h("div", { class: "rp-card" }, h("strong", {}, "No replays yet"), h("p", {}, "Nothing recorded has anything to replay. ", editor, ", paint for a few seconds, then press Refresh.")));
  }

  if (hidden.length) {
    const older = h("div", { class: "rp-list", hidden: "" }, ...hidden.map((s) => row(s, true)));
    const label = (open: boolean) => (open ? "Hide older and empty sessions" : `Show ${hidden.length} older or empty session${hidden.length === 1 ? "" : "s"}`);
    const toggle = h("button", { class: "rp-link" }, label(false));
    toggle.addEventListener("click", () => {
      older.hidden = !older.hidden;
      toggle.textContent = label(!older.hidden);
    });
    content.append(toggle, older);
  }

  const refresh = h("button", { class: "rp-link" }, "Refresh");
  refresh.addEventListener("click", () => void startScreen());
  const more = total > all.length ? ` · showing the newest ${all.length} of ${total}` : "";
  content.append(h("p", { class: "rp-foot rp-muted" }, `${watchable.length} replay${watchable.length === 1 ? "" : "s"}${more} · `, refresh));
  app.replaceChildren(shell(content, message));
}

/** Drop or choose a downloaded .jsonl log (kept out of the way: most people use the list). */
function fileCard(): HTMLElement {
  const fileInput = h("input", { type: "file", accept: ".jsonl,.ndjson,.json,text/plain" });
  const drop = h("div", { class: "rp-drop" }, "Drop a session .jsonl file here, or ", fileInput);
  const openFile = async (f: File | undefined) => {
    if (!f) return;
    openText(await f.text(), { name: f.name });
  };
  fileInput.addEventListener("change", () => void openFile(fileInput.files?.[0]));
  drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")));
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    void openFile(e.dataTransfer?.files?.[0]);
  });
  return h("details", { class: "rp-file" }, h("summary", {}, "Have a downloaded log file instead?"), drop);
}

async function openRemote(sessionId: string, t: number): Promise<void> {
  const my = ++screenToken;
  app.replaceChildren(h("div", { class: "rp-start" }, h("p", { class: "rp-muted" }, `Loading ${sessionId}…`)));
  try {
    const text = await fetchSessionLog(apiBase, sessionId, getPw() || (isLocalApi(apiBase) ? LOCAL_PASSWORD : ""));
    if (my !== screenToken) return;
    openText(text, { name: sessionId, sessionId, t });
  } catch (e) {
    if (my !== screenToken) return;
    if (e instanceof AuthError) return loginScreen("Enter the lab password to open this session.");
    void startScreen(e instanceof Error ? e.message : String(e));
  }
}

function openText(text: string, src: { name: string; sessionId?: string; t?: number }): void {
  const replay = Replay.fromJsonl(text);
  if (replay.events.length === 0) return void startScreen(`${src.name}: no events could be read from that file.`);
  viewer(replay, src);
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

function viewer(replay: Replay, src: { name: string; sessionId?: string; t?: number }): void {
  const tracks = replay.tracks();
  const base = replay.baseCells();
  const player = new Player(replay.duration, { gaps: quietGaps(tracks), onEnd: () => syncButtons() });
  player.seek(src.t ?? 0);

  const canvas = h("canvas", { width: String(STAGE_W), height: String(STAGE_H) });
  const ctx = canvas.getContext("2d")!;
  const hud = h("div", { class: "rp-hud" });
  const time = h("span", { class: "time" });
  const playBtn = h("button", { class: "primary", title: "Play / pause (Space)" }, "Play");
  const speed = h("select", { title: "Playback speed" });
  for (const s of SPEEDS) speed.append(h("option", { value: String(s) }, `${s}×`));
  speed.value = "1";
  const skip = h("input", { type: "checkbox" });
  const jumpKind = h("select", { title: "What the jump buttons move between" });
  const jumpOptions: [string, TrackId[]][] = [
    ["Suggestion", ["suggestions"]],
    ["API call", ["api"]],
    ["Edit / undo", ["edits"]],
    ["Input burst", ["input"]],
    ["Play run", ["play"]],
    ["Anything", [...TRACK_ORDER]],
  ];
  jumpOptions.forEach(([label], i) => jumpKind.append(h("option", { value: String(i) }, label)));
  const prev = h("button", { title: "Previous (,)" }, "◀");
  const next = h("button", { title: "Next (.)" }, "▶");

  const zoomOut = h("button", { title: "Zoom out timeline (-)" }, "−");
  const zoomIn = h("button", { title: "Zoom in timeline (+)" }, "+");
  const fitBtn = h("button", { title: "Fit whole session (F)" }, "Fit");
  const copy = h("button", { title: "Copy a link to this moment" }, "Copy link");
  copy.disabled = !(apiBase && src.sessionId);
  copy.addEventListener("click", () => {
    if (!apiBase || !src.sessionId) return;
    void navigator.clipboard?.writeText(shareLink(location.href, apiBase, src.sessionId, player.t));
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy link"), 1200);
  });

  const timelineHost = h("div");
  const timeline = new Timeline(timelineHost, tracks, {
    onSeek: (t) => seek(t),
    onPick: ({ segment, marker }) => showPick(segment, marker),
  });

  const pick = h("div", { class: "rp-kv" });
  const ghostList = h("div");
  const side = h("aside", { class: "rp-side" }, h("h2", {}, "Session"), sessionInfo(replay, src.name), h("h2", {}, "Selected"), pick, h("h2", {}, "Suggestions — how fast they reacted"), ghostList);

  const trackToggles = h("span", { class: "rp-jump" });
  for (const id of TRACK_ORDER) {
    const cb = h("input", { type: "checkbox" });
    cb.checked = true;
    cb.addEventListener("change", () => timeline.setTrackHidden(id, !cb.checked));
    trackToggles.append(h("label", {}, cb, TRACK_LABEL[id]));
  }

  const bar = h(
    "div",
    { class: "rp-bar" },
    playBtn,
    time,
    speed,
    h("label", {}, skip, "Skip quiet stretches"),
    h("span", { class: "sp" }),
    h("span", { class: "rp-jump" }, "Jump:", jumpKind, prev, next),
    zoomOut,
    zoomIn,
    fitBtn,
    copy,
  );

  const head = h("header", { class: "rp-head" }, h("h1", {}, "Pewter Ghost replay"), h("span", { class: "meta" }, `${src.name} · ${fmt(replay.duration)}${replay.skipped.length ? ` · ${replay.skipped.length} unreadable lines skipped` : ""}`), h("button", {}, "Open another"));
  (head.lastElementChild as HTMLButtonElement).addEventListener("click", () => {
    stop();
    startScreen();
  });

  app.replaceChildren(
    head,
    h("div", { class: "rp-main" }, h("div", { class: "rp-stagewrap" }, h("div", { class: "rp-stage" }, canvas), hud), side),
    h("div", { class: "rp-bottom" }, bar, h("div", { class: "rp-jump", style: "margin-bottom:6px" }, "Tracks:", trackToggles), timelineHost),
  );
  timeline.fit();

  // ----- behaviour
  function points(): number[] {
    return navPoints(tracks, jumpOptions[Number(jumpKind.value)][1]);
  }
  function seek(t: number): void {
    player.seek(t);
    timeline.setPlayhead(player.t);
    draw(true);
  }
  function jump(dir: 1 | -1): void {
    const p = stepPoint(points(), player.t, dir);
    if (p === null) return;
    seek(p);
    timeline.reveal(p);
  }
  function syncButtons(): void {
    playBtn.textContent = player.playing ? "Pause" : "Play";
  }
  function showPick(segment?: Segment, marker?: Marker): void {
    pick.replaceChildren();
    const rows: [string, string][] = segment
      ? [["Track", TRACK_LABEL[segment.track]], ["What", segment.label], ["From", fmt(segment.start)], ["To", fmt(segment.end)], ["Length", `${((segment.end - segment.start) / 1000).toFixed(2)} s`]]
      : marker
        ? [["Track", TRACK_LABEL[marker.track]], ["What", marker.label], ["At", fmt(marker.t)]]
        : [];
    for (const [k, v] of rows) pick.append(h("span", {}, k), h("span", {}, v));
  }
  function renderGhosts(): void {
    ghostList.replaceChildren();
    const gs = replay.ghostSummaries();
    if (!gs.length) ghostList.append(h("p", { class: "meta" }, "No suggestions were shown."));
    gs.forEach((g, i) => ghostList.append(ghostRow(g, i + 1)));
  }
  function ghostRow(g: ReplayGhostSummary, n: number): HTMLElement {
    const react = g.firstMoveMs === null ? "no pointer movement" : `moved after ${(g.firstMoveMs / 1000).toFixed(1)} s`;
    const away = g.awayMs > 0 ? ` · away ${(g.awayMs / 1000).toFixed(1)} s` : "";
    const b = h(
      "button",
      { class: "rp-ghost" },
      h("div", { class: "top" }, h("span", { class: "lbl" }, `${n}. ${g.kind} · ${g.label}`), h("span", { class: `pill ${g.outcome ?? "open"}` }, g.outcome ?? "open")),
      h("div", { class: "sub" }, `${fmt(g.startT)} · ${react} · decided in ${(g.decisionMs / 1000).toFixed(1)} s${away}`),
    );
    b.addEventListener("click", () => {
      seek(g.startT);
      timeline.reveal(g.startT);
    });
    return b;
  }
  function updateHud(f: ReplayFrame): void {
    const parts: [string, string][] = [["Tool", f.tool ? `${f.tool.mode} · ${f.tool.brush}` : "—"]];
    if (f.pointer?.tile) parts.push(["Tile", `${f.pointer.tile.x}, ${f.pointer.tile.y}`]);
    if (f.keys.length) parts.push(["Keys", f.keys.join(" + ")]);
    if (f.ghost) parts.push(["Ghost", `${f.ghost.label} (${f.ghost.confidence.toFixed(2)}) shown ${((f.t - f.ghost.startT) / 1000).toFixed(1)} s ago`]);
    hud.replaceChildren(...parts.map(([k, v]) => h("span", {}, `${k}: `, h("b", {}, v))));
  }
  function draw(force = false): void {
    const f = replay.stateAt(player.t);
    time.textContent = `${fmt(player.t)} / ${fmt(replay.duration)}`;
    if (force || player.playing) drawFrame(ctx, f, { base });
    updateHud(f);
  }

  playBtn.addEventListener("click", () => (player.toggle(), syncButtons()));
  speed.addEventListener("change", () => player.setSpeed(Number(speed.value)));
  skip.addEventListener("change", () => (player.skipQuiet = skip.checked));
  prev.addEventListener("click", () => jump(-1));
  next.addEventListener("click", () => jump(1));
  zoomOut.addEventListener("click", () => timeline.zoomBy(0.7));
  zoomIn.addEventListener("click", () => timeline.zoomBy(1.4));
  fitBtn.addEventListener("click", () => timeline.fit());

  const onKey = (e: KeyboardEvent) => {
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === "INPUT" || tg.tagName === "SELECT" || tg.tagName === "TEXTAREA")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? 5000 : 1000;
    switch (e.key) {
      case " ":
        player.toggle();
        syncButtons();
        break;
      case "ArrowLeft":
        seek(player.t - step);
        break;
      case "ArrowRight":
        seek(player.t + step);
        break;
      case ",":
        jump(-1);
        break;
      case ".":
        jump(1);
        break;
      case "+":
      case "=":
        timeline.zoomBy(1.4);
        break;
      case "-":
        timeline.zoomBy(0.7);
        break;
      case "f":
      case "F":
        timeline.fit();
        break;
      default:
        return;
    }
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);

  let raf = 0;
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    if (player.playing) {
      player.tick(dt);
      timeline.setPlayhead(player.t, true);
      draw();
      if (!player.playing) syncButtons();
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  function stop(): void {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey);
    if (stopViewer === stop) stopViewer = null;
  }
  stopViewer?.();
  stopViewer = stop;

  renderGhosts();
  timeline.setPlayhead(player.t);
  draw(true);
  syncButtons();
}

function sessionInfo(r: Replay, name: string): HTMLElement {
  const s = r.events.find((e) => e.type === "session") as Extract<Replay["events"][number], { type: "session" }> | undefined;
  const rows: [string, string][] = [["Session", r.sessionId || name], ["Length", fmt(r.duration)], ["Events", String(r.events.length)]];
  if (s) rows.push(["Filler", s.filler], ["Model", s.model], ["Build", s.commit]);
  if (!r.hasLevel) rows.push(["Note", "no level snapshot (old log)"]);
  const kv = h("div", { class: "rp-kv" });
  for (const [k, v] of rows) kv.append(h("span", {}, k), h("span", {}, v));
  return kv;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot(): void {
  stopViewer?.();
  const initial = parseHash(location.hash);
  // A link opens straight in when a password is known (remembered, or the local one);
  // otherwise ask for it first rather than send a request that can only fail.
  if (initial && (getPw() || isLocalApi(apiBase))) void openRemote(initial.sessionId, initial.t);
  else void startScreen(initial ? "Enter the lab password to open this session." : undefined);
}
boot();
// Pasting another link into the same tab only changes the hash: open that one.
window.addEventListener("hashchange", boot);
