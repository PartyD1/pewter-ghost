/**
 * Dev-only overlay (?dev=1): the last model answer, its confidence, latency,
 * the verification stage it reached, and what the manager did with it. Never
 * shown to participants (it names the filler).
 */
import type { FillMode, FillerName, SuggestionKind, VerdictStage } from "../contracts";
import { injectGhostStyles } from "./styles";

/** One fill as the dev overlay sees it. All fields optional: report what you have. */
export interface DevFillInfo {
  t?: number;
  filler?: FillerName | "none";
  mode?: FillMode;
  /** The model acted (true), declined (false) or the call failed (null). */
  act?: boolean | null;
  kind?: SuggestionKind;
  label?: string;
  confidence?: number;
  latencyMs?: number;
  /** "ok" when it passed verification. */
  verdictStage?: VerdictStage | "ok";
  reason?: string;
  attempts?: number;
  cells?: number;
  error?: string;
}

export interface DevState {
  fill: DevFillInfo | null;
  managerState: string;
  showNowAbove: number;
  streak: number;
  locked: boolean;
  /** Last thing the manager did, e.g. "shown (pause)" or "dropped: cooldown". */
  lastEvent: string | null;
  fills: number;
}

const pct = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(2));

/** Text lines of the overlay. Pure. */
export function devLines(s: DevState): string[] {
  const f = s.fill;
  const lines = [`ghost dev · fills ${s.fills} · manager ${s.managerState}${s.locked ? " (locked)" : ""}`];
  lines.push(`showNowAbove ${s.showNowAbove.toFixed(2)} · dismiss streak ${s.streak}`);
  if (!f) {
    lines.push("last answer: none yet");
  } else {
    const what =
      f.error !== undefined
        ? `error: ${f.error}`
        : f.act === false
          ? "declined (act: false)"
          : `${f.kind ?? "?"} "${f.label ?? ""}"${f.cells !== undefined ? ` · ${f.cells} cells` : ""}`;
    lines.push(`last answer: ${what}`);
    lines.push(
      `filler ${f.filler ?? "?"} · mode ${f.mode ?? "?"} · confidence ${pct(f.confidence)} · latency ${f.latencyMs === undefined ? "—" : `${Math.round(f.latencyMs)} ms`}${f.attempts && f.attempts > 1 ? ` · ${f.attempts} attempts` : ""}`,
    );
    lines.push(`verdict: ${f.verdictStage ?? "—"}${f.reason ? ` · ${f.reason}` : ""}`);
  }
  if (s.lastEvent) lines.push(`last: ${s.lastEvent}`);
  return lines;
}

/** Is the dev overlay asked for in this URL? */
export function devEnabled(search: string = typeof location !== "undefined" ? location.search : ""): boolean {
  const v = new URLSearchParams(search).get("dev");
  return v === "1" || v === "true";
}

export class DevOverlay {
  private readonly el: HTMLDivElement;
  private state: DevState = { fill: null, managerState: "idle", showNowAbove: 0, streak: 0, locked: false, lastEvent: null, fills: 0 };

  constructor(parent: HTMLElement) {
    injectGhostStyles();
    this.el = document.createElement("div");
    this.el.className = "pg-ghost-dev";
    this.el.id = "pg-ghost-dev";
    parent.appendChild(this.el);
    this.render();
  }

  recordFill(info: DevFillInfo): void {
    this.state = { ...this.state, fill: { ...info }, fills: this.state.fills + 1 };
    this.render();
  }

  update(patch: Partial<Omit<DevState, "fill" | "fills">>): void {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) if ((this.state as unknown as Record<string, unknown>)[k] !== v) changed = true;
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.render();
  }

  get text(): string {
    return this.el.textContent ?? "";
  }

  destroy(): void {
    this.el.remove();
  }

  private render(): void {
    this.el.textContent = devLines(this.state).join("\n");
  }
}
