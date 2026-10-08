/**
 * Driving the real editor from Playwright (G-07 harness).
 *
 * Everything goes through the page the way a person would (mouse on the
 * canvas, keys, toolbar buttons); window.__pewter is read for assertions and
 * for tile <-> screen coordinates only.
 */
import { expect, type Page } from "@playwright/test";
import type { LogEvent, Point } from "../../../apps/editor/src/contracts";
import { PROXY_URL, ProxyMock, type ProxyMockOptions } from "./proxyMock";

/** Tile ids (contracts TILE). */
export const T = { EMPTY: 0, BLOCK: 1, GRASS_HALF: 4, DIRT: 5, GRASS: 6, QUESTION: 7 } as const;
/** Author ids (contracts AUTHOR). */
export const A = { NONE: 0, PERSON: 1, GHOST: 2 } as const;

export type FillCallEvent = Extract<LogEvent, { type: "fill.call" }>;

export interface GhostCurrentLite {
  id: string;
  kind: string;
  label: string;
  confidence: number;
  shownBecause: string | null;
  remaining: number;
  adds: { x: number; y: number; tile: number }[];
  removes: Point[];
  filler: string;
  attempts: number;
  mode: string;
}

export interface OpenOptions {
  /** Extra URL params (fresh=1 is always set unless fresh: false). */
  params?: Record<string, string>;
  fresh?: boolean;
  /** Install the proxy mock with these options (null: no session token, no proxy). */
  proxy?: ProxyMockOptions | null;
  /** Keep the fill loop running (default true). */
  loop?: boolean;
  /** Clear localStorage before boot (default true). */
  clearStorage?: boolean;
  /**
   * The level the test starts on. "default" (the default) is the editor's own
   * starter, the old Pewter Platformer map with a full ground floor.
   * "platforms" keeps only a 12-tile start platform and a 12-tile goal
   * platform (with the goal flag) and empties everything between, for specs
   * that need open air and pits: the starter these specs were written for.
   */
  starter?: "default" | "platforms";
}

/** Console errors and page errors that are not expected noise. */
export function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon/i.test(e));
}

export class Editor {
  readonly errors: string[] = [];

  constructor(
    readonly page: Page,
    readonly proxy: ProxyMock | null,
  ) {
    page.on("console", (m) => {
      if (m.type() === "error") this.errors.push(m.text());
    });
    page.on("pageerror", (e) => this.errors.push(String(e)));
  }

  /** Boot the editor and wait until the session, fill loop and ghost are ready. */
  static async open(page: Page, o: OpenOptions = {}): Promise<Editor> {
    const proxy = o.proxy === null ? null : new ProxyMock(page, o.proxy ?? {});
    const ed = new Editor(page, proxy);
    if (proxy) await proxy.install();
    if (o.clearStorage !== false) {
      await page.addInitScript(() => {
        try {
          if (!sessionStorage.getItem("pg-e2e-booted")) {
            localStorage.clear();
            sessionStorage.setItem("pg-e2e-booted", "1");
          }
        } catch {
          /* storage may be blocked */
        }
      });
    }
    const params = new URLSearchParams();
    if (o.fresh !== false) params.set("fresh", "1");
    if (proxy) {
      params.set("proxy", PROXY_URL);
      params.set("token", "e2e-token");
    }
    for (const [k, v] of Object.entries(o.params ?? {})) params.set(k, v);
    await page.goto(`./?${params.toString()}`, { waitUntil: "load" });
    await ed.waitReady();
    if (o.starter === "platforms") await ed.useTwoPlatformStarter();
    if (o.loop === false) await page.evaluate(() => (window as any).__pewter.app.loop.setSuspended(true));
    return ed;
  }

  /**
   * Replace the level with the two-platform starter: the editor's starter
   * with every column between the two 12-tile platforms emptied, all template
   * (author NONE), history cleared (model.load).
   */
  async useTwoPlatformStarter(platform = 12): Promise<void> {
    await this.page.evaluate((platform) => {
      const m = (window as any).__pewter.model;
      const s = m.snapshot();
      for (let y = 0; y < s.h; y++)
        for (let x = 0; x < s.w; x++) {
          const i = y * s.w + x;
          if (x >= platform && x < s.w - platform) s.cells[i] = 0;
          s.authors[i] = 0;
        }
      s.provenance = {};
      s.entities = s.entities.filter((e: { x: number }) => x0(e.x));
      for (const id of Object.keys(s.entityAuthors)) if (!s.entities.some((e: { id: string }) => e.id === id)) delete s.entityAuthors[id];
      m.load(s);
      function x0(x: number): boolean {
        return x < platform || x >= s.w - platform;
      }
    }, platform);
    await this.home();
  }

  async waitReady(): Promise<void> {
    await this.page.waitForFunction(() => {
      const w = (window as any).__pewter;
      return !!(w && w.api && w.app && w.ghost);
    }, null, { timeout: 30_000 });
    await this.page.evaluate(() => (window as any).__pewter.app.ready);
    await this.home();
  }

  // ------------------------------------------------------------------ level

  tileAt(x: number, y: number): Promise<number> {
    return this.page.evaluate(([x, y]) => (window as any).__pewter.model.tileAt(x, y), [x, y] as const);
  }

  authorAt(x: number, y: number): Promise<number> {
    return this.page.evaluate(([x, y]) => (window as any).__pewter.model.authorAt(x, y), [x, y] as const);
  }

  /** The level as JSON (exact comparison). */
  snapshotJson(): Promise<string> {
    return this.page.evaluate(() => JSON.stringify((window as any).__pewter.model.snapshot()));
  }

  undoDepth(): Promise<number> {
    return this.page.evaluate(() => (window as any).__pewter.model.undoDepth);
  }

  // ------------------------------------------------------------------ camera / pointer

  async home(): Promise<void> {
    await this.page.evaluate(() => {
      const w = (window as any).__pewter;
      w.scene.camera.home(w.model.start);
    });
    await this.settle();
  }

  /** Wait until the camera stops easing (home, Extend nudges). */
  async settle(): Promise<void> {
    let prev = "";
    for (let i = 0; i < 40; i++) {
      const v = await this.page.evaluate(() => {
        const api = (window as any).__pewter.api;
        const r = api.game.canvas.getBoundingClientRect();
        return JSON.stringify([api.camera.viewTiles(), r.top, r.left, r.width, r.height, api.game.scale.width, api.game.scale.height]);
      });
      if (v === prev) return;
      prev = v;
      await this.page.waitForTimeout(80);
    }
  }

  /** Page pixel at the centre of tile (x, y). */
  screenOf(x: number, y: number): Promise<Point> {
    return this.page.evaluate(
      ([x, y]) => {
        const api = (window as any).__pewter.api;
        const p = api.camera.tileToScreen(x + 0.5, y + 0.5);
        const r = api.game.canvas.getBoundingClientRect();
        return { x: r.left + (p.x * r.width) / api.game.scale.width, y: r.top + (p.y * r.height) / api.game.scale.height };
      },
      [x, y] as const,
    );
  }

  /** Click one tile (no camera settling: callers that need it call settle()). */
  async clickTile(x: number, y: number, opts: { button?: "left" | "right" } = {}): Promise<void> {
    const p = await this.screenOf(x, y);
    await this.page.mouse.move(p.x, p.y, { steps: 2 });
    await this.page.mouse.click(p.x, p.y, { button: opts.button ?? "left" });
  }

  /** One stroke through the given tiles. */
  async drag(cells: [number, number][]): Promise<void> {
    const ps: Point[] = [];
    for (const [x, y] of cells) ps.push(await this.screenOf(x, y));
    await this.page.mouse.move(ps[0].x, ps[0].y);
    await this.page.mouse.down();
    for (const p of ps.slice(1)) await this.page.mouse.move(p.x, p.y, { steps: 3 });
    await this.page.mouse.up();
  }

  /**
   * Click each tile on a fixed cadence (the n-th click lands `everyMs * n`
   * after the first). Screen points are computed up front, so the camera must
   * be still. Returns the Node clock time of each click.
   */
  async paintTimed(cells: [number, number][], everyMs: number): Promise<number[]> {
    await this.settle();
    const ps: Point[] = [];
    for (const [x, y] of cells) ps.push(await this.screenOf(x, y));
    await this.page.mouse.move(ps[0].x, ps[0].y);
    const t0 = Date.now();
    const at: number[] = [];
    for (let i = 0; i < ps.length; i++) {
      const wait = t0 + i * everyMs - Date.now();
      if (wait > 0) await this.page.waitForTimeout(wait);
      at.push(Date.now());
      await this.page.mouse.click(ps[i].x, ps[i].y);
    }
    return at;
  }

  /** Pick a palette item (switches to Paint). */
  async pick(item: "block" | "grass" | "grass_half" | "dirt" | "question" | "coin" | "fruit" | "slime" | "ultraslime" | string): Promise<void> {
    await this.page.click(`[data-item="${item}"]`);
  }

  mode(): Promise<string> {
    return this.page.evaluate(() => (window as any).__pewter.modes.mode);
  }

  // ------------------------------------------------------------------ log

  events(): Promise<LogEvent[]> {
    return this.page.evaluate(() => {
      const log = (window as any).__pewter.app.eventLog;
      return log ? log.events() : [];
    });
  }

  async fillCalls(): Promise<FillCallEvent[]> {
    return (await this.events()).filter((e): e is FillCallEvent => e.type === "fill.call");
  }

  // ------------------------------------------------------------------ ghost

  ghost(): Promise<GhostCurrentLite | null> {
    return this.page.evaluate(() => {
      const c = (window as any).__pewter.ghost.current();
      if (!c) return null;
      const s = c.suggestion;
      return {
        id: s.id,
        kind: s.kind,
        label: s.label,
        confidence: s.confidence,
        shownBecause: c.shownBecause,
        remaining: c.remaining.length,
        adds: s.adds,
        removes: s.removes,
        filler: s.filler,
        attempts: s.attempts,
        mode: s.mode,
      };
    });
  }

  /** Is a ghost actually drawn (layer visible with cells)? */
  layer(): Promise<{ visible: boolean; adds: number; removes: number; kind?: string; caption?: string }> {
    return this.page.evaluate(() => (window as any).__pewter.ghost.layer());
  }

  async waitForGhost(timeout = 10_000): Promise<GhostCurrentLite> {
    await this.page.waitForFunction(() => !!(window as any).__pewter.ghost.current(), null, { timeout });
    return (await this.ghost())!;
  }

  /** Show a hand-made verified suggestion through the ghost test handle (bypasses the loop). */
  showSuggestion(s: Record<string, unknown>): Promise<{ status: string }> {
    return this.page.evaluate((s) => (window as any).__pewter.ghost.show(s), s);
  }

  strip(): Promise<{ main: string; guess: string | null } | null> {
    return this.page.evaluate(() => (window as any).__pewter.ghost.strip());
  }

  /** Expect no console or page errors so far. */
  expectNoErrors(): void {
    expect(realErrors(this.errors), "console / page errors").toEqual([]);
  }
}

/** A hand-made VerifiedSuggestion (the brand the verifier sets), for UI-only specs. */
export function verifiedSuggestion(id: string, over: Record<string, unknown>): Record<string, unknown> {
  const adds = (over.adds as Point[] | undefined) ?? [];
  const removes = (over.removes as Point[] | undefined) ?? [];
  const first = adds[0] ?? removes[0] ?? { x: 0, y: 0 };
  return {
    id,
    kind: "finish",
    adds: [],
    removes: [],
    entities: [],
    confidence: 0.9,
    label: "staircase",
    anchor: { x: first.x, y: first.y },
    requestHash: `e2e-${id}`,
    filler: "stub",
    latencyMs: 0,
    mode: "auto",
    verified: true,
    __verified: true,
    attempts: 1,
    ...over,
  };
}
