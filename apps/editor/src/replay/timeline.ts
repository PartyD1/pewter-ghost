/**
 * Premiere-style timeline for the replay viewer: a ruler, one row per track,
 * segments and markers, and a playhead you can click or drag. Pure DOM, no
 * framework. Clicking a segment (without dragging) jumps to its start.
 */
import { TRACK_ORDER, type Marker, type Segment, type TrackId, type Tracks } from "../research/replay/tracks";

export const TRACK_LABEL: Record<TrackId, string> = {
  suggestions: "Suggestions",
  api: "API calls",
  edits: "Edits",
  input: "Input",
  play: "Play mode",
  away: "Away",
};

export interface TimelineOptions {
  /** The person dragged the playhead or clicked the timeline. */
  onSeek(t: number): void;
  /** A segment or marker was clicked. */
  onPick?(item: { segment?: Segment; marker?: Marker }): void;
}

const MIN_PPS = 0.002; // px per ms
const MAX_PPS = 2;

export class Timeline {
  readonly root: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly inner: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly rows = new Map<TrackId, HTMLElement>();
  private readonly labels = new Map<TrackId, HTMLElement>();
  private pps = 0.05;
  private t = 0;
  private selected: string | null = null;
  private dragging = false;
  private downX = 0;
  private moved = false;

  constructor(
    host: HTMLElement,
    private readonly tracks: Tracks,
    private readonly opts: TimelineOptions,
  ) {
    this.root = el("div", "tl");
    const labels = el("div", "tl-labels");
    labels.appendChild(el("div", "tl-label tl-ruler-label", "time"));
    this.scroller = el("div", "tl-scroll");
    this.inner = el("div", "tl-inner");
    const ruler = el("div", "tl-ruler");
    this.inner.appendChild(ruler);
    for (const id of TRACK_ORDER) {
      const label = el("div", "tl-label", TRACK_LABEL[id]);
      labels.appendChild(label);
      this.labels.set(id, label);
      const row = el("div", `tl-row tl-${id}`);
      row.dataset.track = id;
      this.rows.set(id, row);
      this.inner.appendChild(row);
    }
    this.playhead = el("div", "tl-playhead");
    this.inner.appendChild(this.playhead);
    this.scroller.appendChild(this.inner);
    this.root.append(labels, this.scroller);
    host.appendChild(this.root);

    this.inner.addEventListener("pointerdown", (e) => this.down(e));
    this.inner.addEventListener("pointermove", (e) => this.move(e));
    this.inner.addEventListener("pointerup", (e) => this.up(e));
    this.inner.addEventListener("pointercancel", () => (this.dragging = false));
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX);
      },
      { passive: false },
    );
    this.fit();
  }

  // ------------------------------------------------------------------ public

  setPlayhead(t: number, follow = false): void {
    this.t = t;
    this.playhead.style.transform = `translateX(${t * this.pps}px)`;
    if (follow) {
      const x = t * this.pps;
      const v0 = this.scroller.scrollLeft;
      const w = this.scroller.clientWidth;
      if (x < v0 || x > v0 + w - 40) this.scroller.scrollLeft = Math.max(0, x - w * 0.25);
    }
  }

  /** Show the whole session across the visible width. */
  fit(): void {
    const w = Math.max(200, this.scroller.clientWidth || 800);
    this.setZoom(w / Math.max(1000, this.tracks.duration));
  }

  zoomBy(factor: number): void {
    this.zoomAt(factor, this.scroller.getBoundingClientRect().left + this.scroller.clientWidth / 2);
  }

  /** Keep `t` in view (after a jump). */
  reveal(t: number): void {
    const x = t * this.pps;
    const v0 = this.scroller.scrollLeft;
    const w = this.scroller.clientWidth;
    if (x < v0 + 20 || x > v0 + w - 20) this.scroller.scrollLeft = Math.max(0, x - w / 2);
  }

  select(id: string | null): void {
    this.selected = id;
    this.inner.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
    if (id) this.inner.querySelector(`[data-id="${id}"]`)?.classList.add("sel");
  }

  setTrackHidden(id: TrackId, hidden: boolean): void {
    this.rows.get(id)?.classList.toggle("hide", hidden);
    this.labels.get(id)?.classList.toggle("hide", hidden);
  }

  // ----------------------------------------------------------------- drawing

  private setZoom(pps: number, anchorMs?: number, anchorX?: number): void {
    this.pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps));
    const width = Math.ceil(this.tracks.duration * this.pps) + 24;
    this.inner.style.width = `${width}px`;
    this.render();
    this.setPlayhead(this.t);
    if (anchorMs !== undefined && anchorX !== undefined) this.scroller.scrollLeft = Math.max(0, anchorMs * this.pps - anchorX);
  }

  private zoomAt(factor: number, clientX: number): void {
    const rect = this.scroller.getBoundingClientRect();
    const x = clientX - rect.left;
    const ms = (this.scroller.scrollLeft + x) / this.pps;
    this.setZoom(this.pps * factor, ms, x);
  }

  private render(): void {
    const ruler = this.inner.querySelector(".tl-ruler") as HTMLElement;
    ruler.replaceChildren(...this.ticks());
    for (const [, row] of this.rows) row.replaceChildren();
    for (const s of this.tracks.segments) {
      const row = this.rows.get(s.track);
      if (!row) continue;
      const n = el("div", `tl-seg k-${s.kind}`);
      n.dataset.id = s.id;
      n.style.left = `${s.start * this.pps}px`;
      n.style.width = `${Math.max(4, (s.end - s.start) * this.pps)}px`;
      n.title = `${s.label}\n${fmt(s.start)} – ${fmt(s.end)}`;
      if ((s.end - s.start) * this.pps > 60) n.textContent = s.label;
      if (s.id === this.selected) n.classList.add("sel");
      row.appendChild(n);
    }
    for (const m of this.tracks.markers) {
      const row = this.rows.get(m.track);
      if (!row) continue;
      const n = el("div", `tl-mark k-${m.kind}`);
      n.dataset.id = m.id;
      n.style.left = `${m.t * this.pps}px`;
      n.title = `${m.label}\n${fmt(m.t)}`;
      if (m.id === this.selected) n.classList.add("sel");
      row.appendChild(n);
    }
  }

  private ticks(): HTMLElement[] {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const stepS = steps.find((s) => s * 1000 * this.pps >= 80) ?? 600;
    const out: HTMLElement[] = [];
    for (let s = 0; s * 1000 <= this.tracks.duration + 1; s += stepS) {
      const n = el("div", "tl-tick", fmt(s * 1000));
      n.style.left = `${s * 1000 * this.pps}px`;
      out.push(n);
    }
    return out;
  }

  // ------------------------------------------------------------------- input

  private timeAt(e: PointerEvent): number {
    const rect = this.inner.getBoundingClientRect();
    return Math.max(0, Math.min(this.tracks.duration, (e.clientX - rect.left) / this.pps));
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.dragging = true;
    this.moved = false;
    this.downX = e.clientX;
    this.inner.setPointerCapture(e.pointerId);
    this.opts.onSeek(this.timeAt(e));
  }

  private move(e: PointerEvent): void {
    if (!this.dragging) return;
    if (Math.abs(e.clientX - this.downX) > 4) this.moved = true;
    this.opts.onSeek(this.timeAt(e));
  }

  private up(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.moved) return;
    // A click, not a drag: snap to the item under the pointer.
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!target) return;
    const id = target.dataset.id!;
    const segment = this.tracks.segments.find((s) => s.id === id);
    const marker = this.tracks.markers.find((m) => m.id === id);
    const at = segment?.start ?? marker?.t;
    if (at === undefined) return;
    this.select(id);
    this.opts.onSeek(at);
    this.opts.onPick?.({ segment, marker });
  }
}

export function fmt(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
