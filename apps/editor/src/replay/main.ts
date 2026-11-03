/**
 * Session replay viewer (replay.html). Loads a session log from the proxy's
 * read endpoints (?api=<proxy>#<sessionId>, shared lab password) or from a
 * local .jsonl file, then plays it back: the editor view re-rendered from
 * events, a cursor trail, and a timeline. The model is never called.
 */
import "./replay.css";
import { Replay, type ReplayFrame, type ReplayGhostSummary } from "../research/replay/replay";
import { navPoints, stepPoint, TRACK_ORDER, type Marker, type Segment, type TrackId } from "../research/replay/tracks";
import { Player, quietGaps, SPEEDS } from "./player";
import { AuthError, fetchSessionLog, listSessions, parseHash, shareLink, type SessionListing } from "./source";
import { drawFrame, STAGE_H, STAGE_W } from "./stage";
import { fmt, Timeline, TRACK_LABEL } from "./timeline";

const PW_KEY = "pewter-ghost.replay.password";
/** Stops the playing viewer's animation loop and key handler (set by viewer()). */
let stopViewer: (() => void) | null = null;
const app = document.getElementById("replay-app")!;
const params = new URLSearchParams(location.search);
const apiBase = params.get("api");

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

function startScreen(message?: string): void {
  stopViewer?.();
  app.replaceChildren();
  const err = h("div", { class: "rp-err" }, message);
  const root = h("div", { class: "rp-start" }, h("h1", {}, "Pewter Ghost replay"), h("p", {}, "Watch back a recorded session: the level as it was built, the suggestions shown, and where the pointer went."), err);

  if (apiBase) {
    const pw = h("input", { type: "password", placeholder: "Lab password", autocomplete: "current-password" });
    pw.value = getPw();
    const list = h("div", { class: "rp-list" });
    const go = h("button", { class: "primary" }, "Show sessions");
    const load = async () => {
      err.textContent = "";
      list.replaceChildren();
      setPw(pw.value);
      try {
        const sessions = await listSessions(apiBase, pw.value);
        if (!sessions.length) list.append(h("p", {}, "No recorded sessions yet."));
        for (const s of sessions) list.append(sessionButton(s));
      } catch (e) {
        err.textContent = e instanceof AuthError ? "That password was not accepted." : e instanceof Error ? e.message : String(e);
      }
    };
    go.addEventListener("click", load);
    pw.addEventListener("keydown", (e) => e.key === "Enter" && load());
    root.append(h("div", { class: "rp-card" }, h("strong", {}, "From the server"), h("div", { class: "rp-row" }, pw, go), list));
  }

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
  root.append(h("div", { class: "rp-card" }, h("strong", {}, "From a file"), h("div", { class: "rp-row" }, drop)));
  app.append(root);
}

function sessionButton(s: SessionListing): HTMLElement {
  const size = typeof s.bytes === "number" ? h("span", { class: "pill" }, `${Math.max(1, Math.round(s.bytes / 1024))} KB`) : null;
  const b = h("button", {}, h("span", {}, s.sessionId), size);
  b.addEventListener("click", () => void openRemote(s.sessionId, 0));
  return b;
}

async function openRemote(sessionId: string, t: number): Promise<void> {
  if (!apiBase) return startScreen("No server given (add ?api=<proxy url> to the address).");
  app.replaceChildren(h("div", { class: "rp-start" }, h("p", {}, `Loading ${sessionId}…`)));
  try {
    const text = await fetchSessionLog(apiBase, sessionId, getPw());
    openText(text, { name: sessionId, sessionId, t });
  } catch (e) {
    startScreen(e instanceof AuthError ? "Enter the lab password to open this session." : e instanceof Error ? e.message : String(e));
  }
}

function openText(text: string, src: { name: string; sessionId?: string; t?: number }): void {
  const replay = Replay.fromJsonl(text);
  if (replay.events.length === 0) return startScreen(`${src.name}: no events could be read from that file.`);
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
  if (initial && apiBase && getPw()) void openRemote(initial.sessionId, initial.t);
  else startScreen(initial && apiBase ? "Enter the lab password to open this session." : undefined);
}
boot();
// Pasting another link into the same tab only changes the hash: open that one.
window.addEventListener("hashchange", boot);
