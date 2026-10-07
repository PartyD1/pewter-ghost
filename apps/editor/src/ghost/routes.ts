/**
 * Routes the playtest agent found (Suggestion.path), kept per accepted
 * suggestion so Play mode can show the route for the current section (G-19).
 * Pure.
 */
import type { Point } from "../contracts";

export interface StoredRoute {
  id: string;
  path: Point[];
  x0: number;
  x1: number;
}

/** Drop repeated points and interior points of straight runs (keeps the shape). */
export function simplifyRoute(path: readonly Point[]): Point[] {
  const pts: Point[] = [];
  for (const p of path) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = pts[pts.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    pts.push({ x: p.x, y: p.y });
  }
  if (pts.length <= 2) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const sameDir = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0;
    if (cross === 0 && sameDir) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export class RouteStore {
  private routes: StoredRoute[] = [];

  constructor(private readonly max = 50) {}

  /** Remember a route (replaces one with the same id). Paths with < 2 points are ignored. */
  add(id: string, path: readonly Point[] | undefined): StoredRoute | null {
    if (!path) return null;
    const p = simplifyRoute(path);
    if (p.length < 2) return null;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const q of p) {
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
    }
    this.remove(id);
    const r: StoredRoute = { id, path: p, x0, x1 };
    this.routes.push(r);
    if (this.routes.length > this.max) this.routes.shift();
    return r;
  }

  remove(id: string): void {
    this.routes = this.routes.filter((r) => r.id !== id);
  }

  /** Keep only routes whose id passes the filter (e.g. still in the level after undo). */
  retain(keep: (id: string) => boolean): void {
    this.routes = this.routes.filter((r) => keep(r.id));
  }

  clear(): void {
    this.routes = [];
  }

  get size(): number {
    return this.routes.length;
  }

  all(): readonly StoredRoute[] {
    return this.routes;
  }

  /**
   * The route for the section around column x: a route covering x (the most
   * recent when several do), otherwise the nearest one within `reach` tiles
   * ahead or behind.
   */
  forColumn(x: number, reach = 12): StoredRoute | null {
    let best: StoredRoute | null = null;
    let bestD = Infinity;
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i];
      const d = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
      if (d < bestD) {
        best = r;
        bestD = d;
      }
    }
    return best && bestD <= reach ? best : null;
  }
}
