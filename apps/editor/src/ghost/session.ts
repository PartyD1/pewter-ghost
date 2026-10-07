/**
 * The ghost session: one SuggestionManager wired to the editor.
 *
 *   manager.onShow   → GhostLayer.show, caption, Extend camera nudge, log ghost.show
 *   manager.onPartial→ GhostLayer.setRemaining
 *   manager.onAcceptApply → LevelModel.applySuggestion (ONE undo step, author GHOST),
 *                      then the agent's route for 2 s
 *   manager.onEnd    → GhostLayer.end, log ghost.end, session history
 *   keys / drawing   → input.ts
 *   status strip     → ui/StatusStrip.ts
 *
 * Fill orchestration (window → filler → verifier) is not here: whoever runs
 * fills calls `session.offer(verified)` and, for the dev overlay and the level
 * guess, `session.reportFill(info)`. Ctrl+Space calls `opts.onRequest` so that
 * code can fire a "requested" fill.
 */
import Phaser from "phaser";
import { type GhostOutcome, type Point, type ShownBecause, type Suggestion, type VerifiedSuggestion } from "../contracts";
import type { EditorApi } from "../editor/api";
import type { EditorScene } from "../editor/EditorScene";
import type { GhostConfig } from "../suggest/config";
import type { Clock } from "../suggest/fakeClock";
import { ghostCells, type GhostCell } from "../suggest/geometry";
import {
  SuggestionManager,
  type ManagerListeners,
  type OfferOptions,
  type OfferResult,
} from "../suggest/SuggestionManager";
import type { Timer } from "../suggest/timers";
import { isDialogOpen } from "../ui/Dialog";
import { StatusStrip } from "../ui/StatusStrip";
import { canvasCaption, sanitizeGuess, type StripView } from "./caption";
import { DevOverlay, devEnabled, type DevFillInfo } from "./devOverlay";
import { leadingBox } from "./extend";
import { GhostLayer, type GhostLayerState } from "./GhostLayer";
import { GhostHistory } from "./history";
import { bindGhostInput } from "./input";
import { ROUTE_KEY } from "./keys";
import { StageOverlay } from "./overlay";
import { PathOverlay } from "./path";
import { RouteStore } from "./routes";

/** How long R shows the route in Play (ms). */
export const PLAY_ROUTE_MS = 3000;

export interface GhostSessionOptions {
  /** Manager clock (default performance.now, the PlacementEvent time base). */
  clock?: Clock;
  timer?: Timer;
  /** Default: the editor's live config. */
  config?: GhostConfig | (() => GhostConfig);
  /** Dev overlay (default: ?dev=1). */
  dev?: boolean;
  /** Is the ghost part of this session? Default: config.filler !== "none". When false the strip is empty. */
  enabled?: () => boolean;
  /** Ctrl+Space: fire a fill with mode "requested". */
  onRequest?: () => void;
  /** Play-mode route for the section at the knight's tile, when no accepted ghost has one. */
  routeProvider?: (at: Point) => Point[] | null | undefined;
  /** Extra listeners (e.g. the fill orchestrator wants onDrop / onStateChange). */
  listeners?: ManagerListeners;
  /** Write ghost.show / ghost.end through api.log (default true). */
  log?: boolean;
  /** Expose window.__pewter.ghost (default true). */
  expose?: boolean;
}

/** What window.__pewter.ghost offers e2e tests. */
export interface GhostTestHandle {
  session: GhostSession;
  manager: SuggestionManager;
  /** Show a (verified) suggestion now, bypassing timing; returns what the manager did. */
  show(s: VerifiedSuggestion): OfferResult;
  current(): GhostCurrent | null;
  accept(): boolean;
  dismiss(): boolean;
  request(): string;
  layer(): GhostLayerState;
  strip(): { main: string; guess: string | null } | null;
  route(): readonly Point[];
  history(): ReturnType<GhostHistory["summary"]>;
}

export interface GhostCurrent {
  suggestion: VerifiedSuggestion;
  shownBecause: ShownBecause | null;
  remaining: GhostCell[];
  state: string;
}

export class GhostSession {
  readonly manager: SuggestionManager;
  readonly layer: GhostLayer;
  readonly paths: PathOverlay;
  readonly routes = new RouteStore();
  readonly history = new GhostHistory();
  readonly strip: StatusStrip;
  readonly dev: DevOverlay | null;
  private readonly overlay: StageOverlay;
  private readonly cfg: () => GhostConfig;
  private readonly enabled: () => boolean;
  private readonly clock: () => number;
  private ordinal = 0;
  private guess: string | null = null;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly api: EditorApi,
    private readonly opts: GhostSessionOptions = {},
  ) {
    const c = opts.config ?? api.config;
    this.cfg = typeof c === "function" ? c : () => c;
    this.enabled = opts.enabled ?? (() => this.cfg().filler !== "none");
    const clock = opts.clock;
    this.clock = clock ? () => clock.now() : () => performance.now();

    const scene = api.scene;
    this.overlay = new StageOverlay(
      api.stage,
      api.camera,
      () => api.game.canvas ?? null,
      () => ({ w: api.game.scale.width, h: api.game.scale.height }),
    );
    this.layer = new GhostLayer({
      scene,
      camera: api.camera,
      overlay: this.overlay,
      onArrow: (b) => api.camera.nudgeTo(b.x0, b.y0, { w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }),
    });
    this.paths = new PathOverlay(scene);
    this.strip = new StatusStrip(api.statusSlot);
    this.dev = (opts.dev ?? devEnabled()) ? new DevOverlay(api.stage) : null;

    const extra = opts.listeners ?? {};
    this.manager = new SuggestionManager({
      clock: opts.clock,
      timer: opts.timer,
      config: this.cfg,
      listeners: {
        onShow: (s, because, t) => {
          this.onShow(s, because, t);
          extra.onShow?.(s, because, t);
        },
        onEnd: (s, outcome, dwell, accepted, t) => {
          this.onEnd(s, outcome, dwell, accepted, t);
          extra.onEnd?.(s, outcome, dwell, accepted, t);
        },
        onAcceptApply: (s, info) => {
          this.apply(s, info.remaining);
          extra.onAcceptApply?.(s, info);
        },
        onPartial: (s, cell, n, total) => {
          this.layer.setRemaining(this.manager.remainingCells);
          this.refresh();
          extra.onPartial?.(s, cell, n, total);
        },
        onDrop: (s, reason, t) => {
          this.devEvent(`dropped "${s.label}": ${reason}`);
          extra.onDrop?.(s, reason, t);
        },
        onStateChange: (state, prev) => {
          this.refresh();
          extra.onStateChange?.(state, prev);
        },
        onThresholdChange: (ch) => {
          this.devEvent(`showNowAbove ${ch.from.toFixed(2)} → ${ch.to.toFixed(2)} (${ch.reason})`);
          extra.onThresholdChange?.(ch);
        },
      },
    });

    this.cleanups.push(
      bindGhostInput({
        model: api.model,
        manager: this.manager,
        isPlaying: () => api.isPlaying(),
        isStrokeActive: () => api.isStrokeActive(),
        dialogOpen: isDialogOpen,
        accept: () => this.accept(),
        dismiss: () => this.dismiss(),
        request: () => this.request(),
        route: () => this.showPlayRoute(),
        onLoad: () => {
          this.layer.end("dismissed");
          this.paths.hide();
          this.routes.clear();
          this.refresh();
        },
        clock: this.clock,
      }),
      api.on("play:start", () => {
        this.layer.setSuspended(true);
        this.paths.hide();
        this.refresh();
      }),
      api.on("play:end", () => {
        this.paths.hide();
        this.layer.setSuspended(false);
        this.refresh();
      }),
      api.on("undo", () => {
        // Forget routes of ghosts that are no longer in the level.
        this.routes.retain((id) => api.model.cellsFromSuggestion(id).length > 0);
      }),
    );

    const onFrame = () => this.frame();
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, onFrame);
    this.cleanups.push(() => scene.events.off(Phaser.Scenes.Events.POST_UPDATE, onFrame));

    api.setHistoryProvider(() => this.history.summary());
    this.cleanups.push(() => api.setHistoryProvider(null));

    if (opts.expose !== false) this.expose();
    this.refresh();
  }

  // ------------------------------------------------------------- public API

  /** Offer a verified suggestion to the manager (the fill orchestrator's entry point). */
  offer(s: VerifiedSuggestion, o?: OfferOptions): OfferResult {
    if (this.disposed) return { status: "dropped", reason: "reset" };
    if (s.levelGuess) this.setLevelGuess(s.levelGuess);
    const r = this.manager.offer(s, o);
    if (r.status !== "shown") this.devEvent(r.status === "held" ? `held "${s.label}" (${r.when})` : `dropped "${s.label}": ${r.reason}`);
    return r;
  }

  /** Report a fill result for the dev overlay and the level guess (call for every answer, shown or not). */
  reportFill(info: DevFillInfo & { levelGuess?: string }): void {
    if (info.levelGuess) this.setLevelGuess(info.levelGuess);
    this.dev?.recordFill(info);
  }

  /** What Ghost thinks the level is (sanitised; filler/condition words are dropped). */
  setLevelGuess(g: string | undefined | null): void {
    const clean = sanitizeGuess(g);
    if (clean && clean !== this.guess) {
      this.guess = clean;
      this.refresh();
    }
  }

  get levelGuess(): string | null {
    return this.guess;
  }

  accept(): boolean {
    if (this.api.isPlaying()) return false;
    return this.manager.accept();
  }

  dismiss(): boolean {
    return this.manager.dismiss();
  }

  /** Ctrl+Space. */
  request(): string {
    if (this.api.isPlaying()) return "playing";
    const r = this.manager.requestNow();
    if (r === "pending") this.opts.onRequest?.();
    this.devEvent(`Ctrl+Space: ${r}`);
    this.refresh();
    return r;
  }

  /** Test/dev hook: show a verified suggestion now, whatever the timing rules say. */
  debugShow(s: VerifiedSuggestion): OfferResult {
    const m = this.manager;
    const pre = !m.shown && !m.waiting;
    if (pre) m.requestNow();
    const r = this.offer(s, { requestedAt: this.clock() });
    if (r.status === "held" && m.requestNow() === "shown" && m.shown?.id === s.id) {
      return { status: "shown", because: m.shownBecause ?? "requested" };
    }
    if (r.status === "dropped" && pre && m.requestPending) m.dismiss(); // clear the request we made
    return r;
  }

  current(): GhostCurrent | null {
    const s = this.manager.shown;
    if (!s) return null;
    return { suggestion: s, shownBecause: this.manager.shownBecause, remaining: this.manager.remainingCells, state: this.manager.state };
  }

  /** Play mode (R): the checked route for the section the knight is in. */
  showPlayRoute(): boolean {
    if (this.paths.visible) {
      this.paths.hide();
      return false;
    }
    const at = this.knightTile();
    const stored = at ? this.routes.forColumn(at.x) : null;
    const path = stored?.path ?? (at ? this.opts.routeProvider?.(at) : null) ?? null;
    if (path && this.paths.show(path, PLAY_ROUTE_MS)) return true;
    this.api.notify("No checked route for this section yet.", { ms: 2000 });
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.manager.reset();
    this.disposed = true;
    for (const c of this.cleanups.splice(0)) {
      try {
        c();
      } catch (err) {
        console.error("ghost cleanup failed", err);
      }
    }
    this.layer.destroy();
    this.paths.destroy();
    this.strip.destroy();
    this.dev?.destroy();
    this.overlay.destroy();
    const w = window.__pewter as (Window["__pewter"] & { ghost?: GhostTestHandle }) | undefined;
    if (w?.ghost?.session === this) delete w.ghost;
  }

  // --------------------------------------------------------------- internals

  private frame(): void {
    if (this.disposed) return;
    if (!this.api.isPlaying()) this.manager.tick();
    this.layer.update();
    this.paths.update();
    this.refresh();
  }

  private onShow(s: VerifiedSuggestion, because: ShownBecause, t: number): void {
    this.ordinal = this.history.recordShow(s);
    if (s.levelGuess) this.setLevelGuess(s.levelGuess);
    this.layer.show(s, canvasCaption(s, this.ordinal));
    if (this.api.isPlaying()) this.layer.setSuspended(true);
    else if (s.kind === "extend") {
      // Extend anchors at the frontier: bring its first third into view (never jumps, waits for strokes).
      const b = leadingBox(s);
      this.api.camera.nudgeTo(b.x0, b.y0, { w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 });
    }
    if (this.opts.log !== false)
      this.api.log({
        type: "ghost.show",
        t,
        suggestionId: s.id,
        kind: s.kind,
        confidence: s.confidence,
        shownBecause: because,
        cells: ghostCells(s).length,
        label: s.label,
      });
    this.devEvent(`shown "${s.label}" (${because})`);
    this.refresh();
  }

  private onEnd(s: VerifiedSuggestion, outcome: GhostOutcome, dwellMs: number, acceptedCells: number | undefined, t: number): void {
    this.layer.end(outcome === "accepted" ? "accepted" : "dismissed");
    this.history.recordEnd(s, outcome, acceptedCells, t);
    if (this.opts.log !== false) {
      const ev = { type: "ghost.end" as const, t, suggestionId: s.id, outcome, dwellMs: Math.round(dwellMs) } as {
        type: "ghost.end";
        t: number;
        suggestionId: string;
        outcome: GhostOutcome;
        dwellMs: number;
        acceptedCells?: number;
      };
      if (acceptedCells !== undefined) ev.acceptedCells = acceptedCells;
      this.api.log(ev);
    }
    this.devEvent(`ended "${s.label}": ${outcome}${acceptedCells !== undefined ? ` (${acceptedCells} cells)` : ""}`);
    this.refresh();
  }

  /** Tab: apply what the person has not already painted, as ONE undoable command. */
  private apply(s: VerifiedSuggestion, remaining: readonly GhostCell[]): void {
    const adds: Suggestion["adds"] = [];
    const removes: Suggestion["removes"] = [];
    const entities: Suggestion["entities"] = [];
    for (const c of remaining) {
      if (c.type === "add") adds.push({ x: c.x, y: c.y, tile: c.tile as Suggestion["adds"][number]["tile"] });
      else if (c.type === "remove") removes.push({ x: c.x, y: c.y });
      else entities.push({ kind: c.kind, x: c.x, y: c.y });
    }
    if (adds.length + removes.length + entities.length > 0) {
      try {
        this.api.model.applySuggestion({ id: s.id, adds, removes, entities });
      } catch (err) {
        console.error("ghost: could not apply the suggestion", err);
        this.api.notify("That suggestion could not be applied.", { kind: "error", ms: 3000 });
        return;
      }
    }
    this.routes.add(s.id, s.path);
    if (s.path && s.path.length >= 2) this.paths.show(s.path);
  }

  private knightTile(): Point | null {
    const sc = this.api.scene as Partial<EditorScene>;
    const k = sc.play?.knightSprite;
    if (!k) return null;
    return { x: Math.floor(k.x / 16), y: Math.floor(k.y / 16) };
  }

  private stripView(): StripView {
    if (!this.enabled()) return { mode: "off" };
    const guess = this.guess;
    if (this.api.isPlaying()) return { mode: "playing", guess, routeKey: this.routes.size > 0 || this.opts.routeProvider ? ROUTE_KEY : undefined };
    const s = this.manager.shown;
    if (s) {
      const total = ghostCells(s).length;
      return { mode: "showing", ghost: s, ordinal: this.ordinal, remaining: this.manager.remainingCells.length, total, guess };
    }
    if (this.manager.requestPending) return { mode: "asking", guess };
    return { mode: "quiet", guess };
  }

  private refresh(): void {
    if (this.disposed) return;
    this.strip.render(this.stripView());
    this.dev?.update({
      managerState: this.manager.state,
      showNowAbove: this.manager.showNowAbove,
      streak: this.manager.streak,
      locked: this.manager.locked,
    });
  }

  private devEvent(text: string): void {
    this.dev?.update({ lastEvent: text });
  }

  private expose(): void {
    const w = window.__pewter as (Window["__pewter"] & { ghost?: GhostTestHandle }) | undefined;
    if (!w) return;
    const self = this;
    w.ghost = {
      session: self,
      manager: self.manager,
      show: (s) => self.debugShow(s),
      current: () => self.current(),
      accept: () => self.accept(),
      dismiss: () => self.dismiss(),
      request: () => self.request(),
      layer: () => self.layer.state(),
      strip: () => {
        const t = self.strip.text;
        return t ? { main: t.main, guess: t.guess } : null;
      },
      route: () => self.paths.route,
      history: () => self.history.summary(),
    };
  }
}

/** Start the ghost on a ready editor. */
export function startGhost(api: EditorApi, opts?: GhostSessionOptions): GhostSession {
  return new GhostSession(api, opts);
}
