/**
 * Captions for the algorithm filler's ghosts, written the way the model
 * writes its labels (prompts/fill.v1.md: "a caption of 8 words or fewer",
 * e.g. "staircase, six more steps", "pit with a coin arc"), so the words on
 * screen do not give the study condition away. Fixed templates; no model.
 */
import type { ComposedPiece } from "@chunks";

/** The model's limit on a label. */
export const CAPTION_MAX_WORDS = 8;

const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const num = (n: number | string) => NUM[Number(n)] ?? String(n);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const clipWords = (s: string, n = CAPTION_MAX_WORDS) => words(s).slice(0, n).join(" ");
/** "a 3-wide gap" -> "3-wide gap". */
const bare = (phrase: string) => phrase.replace(/^(a|an)\s+/i, "");
const plural = (n: number | string, one: string, many = `${one}s`) => (Number(n) === 1 ? one : many);

/** Caption for an Extend: what the first one or two pieces are ("3-wide gap, then stairs up"). */
export function extendCaption(pieces: readonly Pick<ComposedPiece, "kind" | "phrase">[]): string {
  const parts = pieces.filter((p) => p.kind !== "flat").map((p) => bare(p.phrase));
  if (!parts.length) return "more floor";
  const two = parts.length > 1 ? `${parts[0]}, then ${parts[1]}` : parts[0];
  return words(two).length <= CAPTION_MAX_WORDS ? two : clipWords(parts[0]);
}

const FINISH_RULES: [RegExp, (...m: string[]) => string][] = [
  [/^finish the staircase: (\d+) more steps?\b/, (n) => `staircase, ${num(n)} more ${plural(n, "step")}`],
  [/^finish the coin arc: (\d+) more coins?\b/, (n) => `coin arc, ${num(n)} more ${plural(n, "coin")}`],
  [/^continue the coin line: (\d+) more\b/, (n) => `coin line, ${num(n)} more`],
  [/^close the pit: an? (\d+)-tile floor\b/, () => "floor across the pit"],
  [/^finish the platform: (\d+) more tiles?\b/, (n) => `platform, ${num(n)} more ${plural(n, "tile")}`],
  [/^finish the stepping stones: (\d+) more stones?\b/, (n) => `stepping stones, ${num(n)} more`],
  [/^finish the (\w[\w -]*?): (\d+) more (\w+)\b/, (what, n, unit) => `${what}, ${num(n)} more ${unit}`],
  [/^repeat the (\w+): (\d+) more\b/, (what, n) => `${num(n)} more ${plural(n, what)}`],
  [/^finish the (\w+) you are drawing and add (\d+) more\b/, (what, n) => `finish the ${what}, ${num(n)} more`],
  [/^finish the (\w+) you are drawing\b/, (what) => `finish the ${what}`],
];

/** Caption for a Finish from the local detectors' label. */
export function finishCaption(label: string): string {
  const l = label.trim();
  for (const [re, f] of FINISH_RULES) {
    const m = re.exec(l);
    if (m) return clipWords(f(...m.slice(1)));
  }
  return clipWords(l.replace(/^(finish|continue|repeat|close) the /, "").replace(/:/g, ","));
}
