/**
 * Command-line parsing for eval/src/cli.ts (pure, tested).
 *
 *   <command> [positionals] [--flag value | --flag=value | --bool | --no-bool]
 * Repeated flags collect into arrays. A value-taking flag followed by another
 * flag (or nothing) is an error; boolean flags never take a value.
 */
import { DEFAULT_RUN_CONFIG } from "./run";
import type { ConfidenceSource, RunConfig } from "./types";

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, FlagValue>;
}

/** Flags that never take a value. */
export const BOOLEAN_FLAGS = new Set([
  "examples",
  "brief",
  "refresh",
  "strict",
  "include-partial",
  "recordings-too",
  "help",
  "cache-errors",
]);

const isFlag = (s: string) => s.startsWith("--") && s.length > 2;

export function parseArgs(argv: readonly string[], booleans: ReadonlySet<string> = BOOLEAN_FLAGS): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: {} };
  const set = (k: string, v: string | boolean) => {
    const prev = out.flags[k];
    if (prev === undefined || typeof v === "boolean") out.flags[k] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else if (typeof prev === "string") out.flags[k] = [prev, v];
    else out.flags[k] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!isFlag(a)) {
      if (out.command === undefined) out.command = a;
      else out.positionals.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const k = body.slice(0, eq);
      const v = body.slice(eq + 1);
      if (booleans.has(k)) {
        if (!["true", "false", "1", "0", "on", "off"].includes(v)) throw new ArgError(`--${k} is a switch (true/false), got "${v}"`);
        set(k, v === "true" || v === "1" || v === "on");
      } else set(k, v);
      continue;
    }
    if (body.startsWith("no-") && booleans.has(body.slice(3))) {
      set(body.slice(3), false);
      continue;
    }
    if (booleans.has(body)) {
      set(body, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || isFlag(next)) throw new ArgError(`--${body} needs a value`);
    set(body, next);
    i++;
  }
  return out;
}

/** Last string value of a flag (arrays: the last one). */
export function str(flags: Record<string, FlagValue>, k: string): string | undefined {
  const v = flags[k];
  if (v === undefined || typeof v === "boolean") return undefined;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/** All string values of a flag, comma-separated values split. */
export function list(flags: Record<string, FlagValue>, k: string): string[] {
  const v = flags[k];
  if (v === undefined || typeof v === "boolean") return [];
  return (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
}

export function bool(flags: Record<string, FlagValue>, k: string, dflt = false): boolean {
  const v = flags[k];
  if (v === undefined) return dflt;
  if (typeof v === "boolean") return v;
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  if (["true", "1", "on", "yes"].includes(s)) return true;
  if (["false", "0", "off", "no"].includes(s)) return false;
  throw new ArgError(`--${k}: expected on/off, got "${s}"`);
}

export function num(flags: Record<string, FlagValue>, k: string, o: { min?: number; max?: number; int?: boolean } = {}): number | undefined {
  const s = str(flags, k);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || (o.int && !Number.isInteger(n))) throw new ArgError(`--${k}: expected ${o.int ? "an integer" : "a number"}, got "${s}"`);
  if (o.min !== undefined && n < o.min) throw new ArgError(`--${k}: must be >= ${o.min}`);
  if (o.max !== undefined && n > o.max) throw new ArgError(`--${k}: must be <= ${o.max}`);
  return n;
}

/** "24x12" -> { cols: 24, rows: 12 }. */
export function parseWindow(s: string): { cols: number; rows: number } {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s.trim());
  if (!m) throw new ArgError(`window "${s}" is not COLSxROWS (e.g. 24x12)`);
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols < 8 || rows < 6 || cols > 200 || rows > 20) throw new ArgError(`window ${cols}x${rows} is out of range (8..200 x 6..20)`);
  return { cols, rows };
}

const SOURCES: ConfidenceSource[] = ["stated", "logprob", "twoSample"];
const SEND_BACK = ["always", "budget", "never"] as const;

/**
 * A RunConfig from flags (optionally prefixed, e.g. "a-" / "b-" for compare).
 * `systemText` reads a --system file (injected so parsing stays pure).
 */
export function configFromFlags(
  flags: Record<string, FlagValue>,
  base: RunConfig = DEFAULT_RUN_CONFIG,
  prefix = "",
  systemText?: (file: string) => { text: string; version: string },
): RunConfig {
  const k = (n: string) => prefix + n;
  const has = (n: string) => flags[k(n)] !== undefined;
  const cfg: RunConfig = { ...base };
  const model = str(flags, k("model"));
  if (model !== undefined) {
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new ArgError(`--${k("model")}: invalid model id "${model}"`);
    cfg.model = model;
  }
  const w = str(flags, k("window"));
  if (w !== undefined) cfg.window = w === "recorded" ? undefined : parseWindow(w);
  if (has("summary")) {
    const s = str(flags, k("summary"));
    cfg.summary = s === "recorded" ? undefined : bool(flags, k("summary"));
  }
  if (has("examples")) cfg.examples = bool(flags, k("examples"));
  if (has("brief")) cfg.compactUser = !bool(flags, k("brief"));
  const conf = str(flags, k("confidence"));
  if (conf !== undefined) {
    if (!SOURCES.includes(conf as ConfidenceSource)) throw new ArgError(`--${k("confidence")}: one of ${SOURCES.join(", ")}`);
    cfg.confidenceSource = conf as ConfidenceSource;
  }
  const samples = num(flags, k("samples"), { int: true, min: 1, max: 2 });
  if (samples !== undefined) cfg.samples = samples as 1 | 2;
  if (cfg.confidenceSource === "twoSample") cfg.samples = 2;
  const t = num(flags, k("temperature"), { min: 0, max: 2 });
  if (t !== undefined) cfg.temperature = t;
  const thinking = str(flags, k("thinking"));
  if (thinking !== undefined) {
    if (thinking === "default" || thinking === "none") cfg.thinkingBudget = null;
    else {
      const n = Number(thinking);
      if (!Number.isInteger(n) || n < -1) throw new ArgError(`--${k("thinking")}: an integer budget or "default"`);
      cfg.thinkingBudget = n;
    }
  }
  const sb = str(flags, k("send-back"));
  if (sb !== undefined) {
    if (!(SEND_BACK as readonly string[]).includes(sb)) throw new ArgError(`--${k("send-back")}: one of ${SEND_BACK.join(", ")}`);
    cfg.sendBack = sb as RunConfig["sendBack"];
  }
  const cap = num(flags, k("agent-cap"), { int: true, min: 10, max: 60_000 });
  if (cap !== undefined) cfg.agentCapMs = cap;
  const budget = num(flags, k("budget"), { int: true, min: 1 });
  if (budget !== undefined) cfg.callTimeoutMs = budget;
  const sys = str(flags, k("system"));
  if (sys !== undefined) {
    if (!systemText) throw new ArgError(`--${k("system")} is not supported here`);
    cfg.systemOverride = systemText(sys);
  }
  const name = str(flags, k("name"));
  cfg.name = name ?? autoName(cfg);
  if (!/^[A-Za-z0-9._-]+$/.test(cfg.name)) throw new ArgError(`--${k("name")}: use letters, digits, dot, dash or underscore`);
  return cfg;
}

/** A readable default run name from the settings that differ from the defaults. */
export function autoName(cfg: RunConfig): string {
  const parts = [cfg.model];
  if (cfg.window) parts.push(`${cfg.window.cols}x${cfg.window.rows}`);
  if (cfg.summary === false) parts.push("nosum");
  if (cfg.examples) parts.push("ex");
  if (cfg.compactUser) parts.push("nobrief");
  if (cfg.confidenceSource !== "stated") parts.push(cfg.confidenceSource);
  if (cfg.samples === 2 && cfg.confidenceSource !== "twoSample") parts.push("s2");
  if (cfg.temperature !== DEFAULT_RUN_CONFIG.temperature) parts.push(`t${cfg.temperature}`);
  if (cfg.thinkingBudget !== DEFAULT_RUN_CONFIG.thinkingBudget) parts.push(`think${cfg.thinkingBudget ?? "default"}`);
  if (cfg.systemOverride) parts.push(cfg.systemOverride.version);
  return parts.join("-").replace(/[^A-Za-z0-9._-]/g, "_");
}
