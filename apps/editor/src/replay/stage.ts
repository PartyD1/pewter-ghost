/**
 * Canvas2D drawing of one replay frame: the level, the ghost, the pointer and
 * its trail. A light stand-in for the editor's Phaser renderer (flat colours,
 * no sprites), at the editor's 1280x720 canvas size so recorded pixel
 * positions land exactly where the participant had them.
 */
import { TILE, TILE_PX, type EntityKind } from "../contracts";
import type { ReplayCamera, ReplayFrame } from "../research/replay/replay";

export const STAGE_W = 1280;
export const STAGE_H = 720;
/** The editor's opening zoom, used until the log gives a camera. */
const FALLBACK_CAMERA: ReplayCamera = { x: 0, y: 0, w: 35, h: 20, zoom: 2.25 };

const TILE_COLOR: Record<number, string> = {
  [TILE.BLOCK]: "#9aa1ad",
  [TILE.GRASS_HALF]: "#6bbf59",
  [TILE.DIRT]: "#8b5e3c",
  [TILE.GRASS]: "#8b5e3c",
  [TILE.QUESTION]: "#f0b429",
};

const ENTITY_COLOR: Record<EntityKind, string> = {
  coin: "#ffd43b",
  fruit: "#ff6b6b",
  slime: "#51cf66",
  ultraslime: "#9775fa",
  flag: "#ffffff",
  sign: "#c08457",
  checkpoint: "#22b8cf",
};

export interface DrawOptions {
  /** Draw a tile grid (default true). */
  grid?: boolean;
  /**
   * Outline what changed since the session began: blue for the person's cells,
   * purple for Ghost's. Needs the starting cells (Replay.baseCells()); without
   * them every authored cell is outlined.
   */
  authorship?: boolean;
  base?: readonly number[] | null;
}

export function drawFrame(ctx: CanvasRenderingContext2D, f: ReplayFrame, opts: DrawOptions = {}): void {
  const cam = f.camera ?? FALLBACK_CAMERA;
  const s = TILE_PX * cam.zoom;
  const px = (x: number) => (x - cam.x) * s;
  const py = (y: number) => (y - cam.y) * s;

  ctx.save();
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  ctx.fillStyle = "#1b1f2a";
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);

  const L = f.level;
  if (!L) {
    ctx.fillStyle = "#8b93a7";
    ctx.font = "20px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("This log has no level snapshot, so there is nothing to draw.", STAGE_W / 2, STAGE_H / 2);
    ctx.restore();
    return;
  }

  // Sky over the level's area.
  ctx.fillStyle = "#cfe8ff";
  ctx.fillRect(px(0), py(0), L.w * s, L.h * s);

  const x0 = Math.max(0, Math.floor(cam.x));
  const x1 = Math.min(L.w - 1, Math.ceil(cam.x + STAGE_W / s));
  const y0 = Math.max(0, Math.floor(cam.y));
  const y1 = Math.min(L.h - 1, Math.ceil(cam.y + STAGE_H / s));

  if (opts.grid !== false && s >= 10) {
    ctx.strokeStyle = "rgba(60,80,110,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) {
      ctx.moveTo(Math.round(px(x)) + 0.5, py(y0));
      ctx.lineTo(Math.round(px(x)) + 0.5, py(y1 + 1));
    }
    for (let y = y0; y <= y1 + 1; y++) {
      ctx.moveTo(px(x0), Math.round(py(y)) + 0.5);
      ctx.lineTo(px(x1 + 1), Math.round(py(y)) + 0.5);
    }
    ctx.stroke();
  }

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * L.w + x;
      const tile = L.cells[i];
      if (!tile) {
        // Removed since the session began: a faint red outline where it used to be.
        if (opts.authorship !== false && opts.base && opts.base[i]) {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = "rgba(224,49,49,0.7)";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(px(x) + 1, py(y) + 1, s - 2, s - 2);
          ctx.restore();
        }
        continue;
      }
      ctx.fillStyle = TILE_COLOR[tile] ?? "#ff00ff";
      ctx.fillRect(px(x), py(y), s, s);
      if (tile === TILE.GRASS) {
        ctx.fillStyle = "#6bbf59";
        ctx.fillRect(px(x), py(y), s, s * 0.28);
      }
      if (tile === TILE.QUESTION) {
        ctx.fillStyle = "#7a5a00";
        ctx.font = `bold ${Math.round(s * 0.7)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("?", px(x) + s / 2, py(y) + s / 2);
      }
      if (opts.authorship !== false) {
        const a = L.authors[i];
        if (a && (!opts.base || opts.base[i] !== tile)) {
          ctx.strokeStyle = a === 2 ? "rgba(151,117,250,0.95)" : "rgba(34,139,230,0.8)";
          ctx.lineWidth = 2;
          ctx.strokeRect(px(x) + 1, py(y) + 1, s - 2, s - 2);
        }
      }
    }
  }

  for (const e of L.entities) drawEntity(ctx, e.kind, px(e.x), py(e.y), s);
  drawMarker(ctx, "start", px(L.start.x), py(L.start.y), s);
  if (L.goal) drawMarker(ctx, "goal", px(L.goal.x), py(L.goal.y), s);

  if (f.ghost) drawGhost(ctx, f.ghost, px, py, s);

  // Hovered tile (paint / erase tools only; it is what the editor highlights).
  if (f.pointer?.tile && f.pointer.inside && (f.tool?.mode === "paint" || f.tool?.mode === "erase")) {
    ctx.strokeStyle = f.tool.mode === "erase" ? "rgba(224,49,49,0.9)" : "rgba(255,255,255,0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(px(f.pointer.tile.x) + 1, py(f.pointer.tile.y) + 1, s - 2, s - 2);
  }

  drawTrail(ctx, f);
  if (f.pointer && f.pointer.inside) drawCursor(ctx, f.pointer.x, f.pointer.y, f.pointer.down);

  if (f.playing) {
    ctx.fillStyle = "rgba(20,24,33,0.45)";
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    badge(ctx, "PLAY MODE — the participant was playing their level", STAGE_W / 2, 40);
  }
  if (!f.focused) {
    ctx.fillStyle = "rgba(20,24,33,0.6)";
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    badge(ctx, "AWAY — window unfocused or tab hidden", STAGE_W / 2, STAGE_H / 2);
  }
  ctx.restore();
}

function drawEntity(ctx: CanvasRenderingContext2D, kind: EntityKind, x: number, y: number, s: number): void {
  ctx.fillStyle = ENTITY_COLOR[kind] ?? "#ff00ff";
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (kind === "slime" || kind === "ultraslime") {
    ctx.ellipse(x + s / 2, y + s * 0.65, s * 0.42, s * 0.3, 0, 0, Math.PI * 2);
  } else if (kind === "sign") {
    ctx.rect(x + s * 0.2, y + s * 0.2, s * 0.6, s * 0.45);
  } else if (kind === "flag" || kind === "checkpoint") {
    ctx.rect(x + s * 0.42, y + s * 0.1, s * 0.08, s * 0.85);
    ctx.rect(x + s * 0.5, y + s * 0.12, s * 0.35, s * 0.28);
  } else {
    ctx.arc(x + s / 2, y + s / 2, s * 0.3, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
}

function drawMarker(ctx: CanvasRenderingContext2D, kind: "start" | "goal", x: number, y: number, s: number): void {
  ctx.fillStyle = kind === "start" ? "#2f9e44" : "#e03131";
  ctx.fillRect(x + s * 0.44, y + s * 0.05, s * 0.08, s * 0.9);
  ctx.beginPath();
  ctx.moveTo(x + s * 0.52, y + s * 0.08);
  ctx.lineTo(x + s * 0.95, y + s * 0.25);
  ctx.lineTo(x + s * 0.52, y + s * 0.42);
  ctx.closePath();
  ctx.fill();
}

function drawGhost(ctx: CanvasRenderingContext2D, g: NonNullable<ReplayFrame["ghost"]>, px: (x: number) => number, py: (y: number) => number, s: number): void {
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2;
  for (const [x, y, tile] of g.adds) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.strokeStyle = "rgba(112,72,232,0.95)";
    ctx.fillRect(px(x), py(y), s, s);
    ctx.strokeRect(px(x) + 1, py(y) + 1, s - 2, s - 2);
    ctx.fillStyle = TILE_COLOR[tile] ?? "#999";
    ctx.globalAlpha = 0.45;
    ctx.fillRect(px(x) + 3, py(y) + 3, s - 6, s - 6);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = "rgba(224,49,49,0.95)";
  for (const [x, y] of g.removes) {
    ctx.strokeRect(px(x) + 1, py(y) + 1, s - 2, s - 2);
    ctx.beginPath();
    ctx.moveTo(px(x) + 4, py(y) + 4);
    ctx.lineTo(px(x) + s - 4, py(y) + s - 4);
    ctx.moveTo(px(x) + s - 4, py(y) + 4);
    ctx.lineTo(px(x) + 4, py(y) + s - 4);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.6;
  for (const [kind, x, y] of g.entities) drawEntity(ctx, kind, px(x), py(y), s);
  ctx.restore();

  // Caption above the first cell, like the editor's.
  const first = g.adds[0] ?? g.removes[0] ?? (g.entities[0] ? [g.entities[0][1], g.entities[0][2]] : null);
  if (first) badge(ctx, `${g.kind} · ${g.label}`, px(first[0]) + s / 2, py(first[1]) - 14, 14);
}

function drawTrail(ctx: CanvasRenderingContext2D, f: ReplayFrame): void {
  const tr = f.trail;
  if (tr.length < 2) return;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 1; i < tr.length; i++) {
    const age = (f.t - tr[i].t) / 1500;
    ctx.strokeStyle = `rgba(224,49,49,${Math.max(0, 0.8 * (1 - age))})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
    ctx.lineTo(tr[i].x, tr[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, down: boolean): void {
  ctx.save();
  if (down) {
    ctx.strokeStyle = "rgba(224,49,49,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "#111";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + 20);
  ctx.lineTo(x + 5, y + 15);
  ctx.lineTo(x + 9, y + 23);
  ctx.lineTo(x + 12, y + 21);
  ctx.lineTo(x + 8, y + 14);
  ctx.lineTo(x + 15, y + 14);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function badge(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, size = 18): void {
  ctx.save();
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 24;
  const h = size + 14;
  ctx.fillStyle = "rgba(20,24,33,0.88)";
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + 1);
  ctx.restore();
}
