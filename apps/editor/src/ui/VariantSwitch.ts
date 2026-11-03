/**
 * Dev variant switch: which filler draws the ghost and which timing policy
 * decides when it appears, switched live from the panel (Chrome.ts
 * #pg-variant-group). It names the filler, so participants never see it: it
 * shows with ?dev=1 or ?variants=1, or in a dev build opened by hand (no
 * launcher ?token=, not an automated browser). Each switch is logged as a
 * `variant` event (PewterApp.setVariant).
 */
import type { TimingPolicyName } from "../contracts";
import type { ActiveFiller } from "../fill/Filler";
import type { GhostConfig } from "../suggest/config";
import { h } from "./dom";

export type FillerChoice = GhostConfig["filler"];

export const FILLER_LABELS: Record<FillerChoice, string> = {
  llm: "LLM",
  algo: "Algo",
  markov: "Markov",
  stub: "Stub",
  none: "None",
};

export const TIMING_LABELS: Record<TimingPolicyName, string> = {
  llm: "LLM decides",
  cdhf: "CDHF",
  jev: "Jev",
  always: "Always",
};

export const TIMING_HINTS: Record<TimingPolicyName, string> = {
  llm: "The filler's own act and confidence decide when a ghost shows",
  cdhf: "An acceptance predictor gates calls and shows (Mozannar et al. 2023)",
  jev: "A small model is asked every few seconds whether to suggest",
  always: "Every verified ghost shows at once",
};

/** Is the variant switch shown for this page? */
export function variantsEnabled(search: string, o: { devBuild: boolean; automated: boolean }): boolean {
  const p = new URLSearchParams(search);
  const flag = (k: string) => p.get(k) === "1" || p.get(k) === "true";
  if (flag("dev") || flag("variants")) return true;
  return o.devBuild && !o.automated && !p.has("token");
}

export interface VariantState {
  filler: ActiveFiller;
  timing: TimingPolicyName;
  fillers: readonly FillerChoice[];
  timings: readonly TimingPolicyName[];
  /** Why a timing policy cannot run here (shown as its tooltip; the button is disabled). */
  unavailable?: Partial<Record<TimingPolicyName, string>>;
}

export interface VariantSwitchOptions {
  onFiller: (f: FillerChoice) => void;
  onTiming: (t: TimingPolicyName) => void;
}

/** The two radio rows inside the panel group. */
export class VariantSwitch {
  private readonly fillerRow: HTMLElement;
  private readonly timingRow: HTMLElement;

  constructor(
    private readonly group: HTMLElement,
    private readonly o: VariantSwitchOptions,
  ) {
    this.fillerRow = group.querySelector<HTMLElement>('[data-variant="filler"]')!;
    this.timingRow = group.querySelector<HTMLElement>('[data-variant="timing"]')!;
  }

  show(on: boolean): void {
    this.group.hidden = !on;
  }

  update(s: VariantState): void {
    this.fillerRow.replaceChildren(
      ...s.fillers.map((f) => this.button(FILLER_LABELS[f], f, f === s.filler, "filler", () => this.o.onFiller(f))),
    );
    this.timingRow.replaceChildren(
      ...s.timings.map((t) => {
        const why = s.unavailable?.[t];
        const b = this.button(TIMING_LABELS[t], t, t === s.timing, "timing", () => this.o.onTiming(t));
        b.title = why ? `${TIMING_HINTS[t]} (${why})` : TIMING_HINTS[t];
        b.disabled = why !== undefined && t !== s.timing;
        return b;
      }),
    );
  }

  private button(text: string, value: string, on: boolean, kind: "filler" | "timing", onclick: () => void): HTMLButtonElement {
    return h("button", {
      class: on ? "pt-tab active" : "pt-tab",
      type: "button",
      role: "radio",
      "aria-checked": String(on),
      [`data-${kind}`]: value,
      text,
      onclick,
    });
  }
}
