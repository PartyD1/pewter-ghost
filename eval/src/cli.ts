/**
 * Offline suite CLI (G-20, G-25, G-27, G-28, G-29, G-38).
 *
 *   npx tsx eval/src/cli.ts <command> [options]      (or: npm run eval -- <command>)
 *
 * Run `npx tsx eval/src/cli.ts help` for the commands. Live model calls need
 * VITE_LLM_API_KEY; the key is never printed (only "set" / "not set").
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AgentClient } from "@physsim";
import type { FillRequest, LevelSnapshot } from "../../apps/editor/src/contracts";
import { parseSave } from "../../apps/editor/src/level/save";
import type { AgentLike } from "../../apps/editor/src/verify/playability";
import { ArgError, bool, configFromFlags, list, num, parseArgs, parseWindow, str, type FlagValue } from "./args";
import { canRebuild, filterCases, loadCases, requestFor } from "./cases";
import { calibrate, calibrationMarkdown } from "./calibration";
import { renderDashboard } from "./dashboard";
import { exportJsonl, pairsFromLogs, pairsFromRun, type ExportFormat } from "./export";
import { buildSeedCases, toJsonl } from "./fixtures/seed";
import { CachedCaller, CallCache, geminiCaller, hasApiKey, loadDotEnv, type LiveEnv, type ModelCaller } from "./live";
import { acceptanceByRequest, loadSessions } from "./logs";
import { chooseCell, DEFAULT_TARGETS, judgeCell, matrixConfigs, matrixMarkdown, type MatrixCell, type MatrixTargets } from "./matrix";
import { computeMetrics, type SurveyAnswer } from "./metrics";
import { compareReport, headline, runReport } from "./report";
import { DEFAULT_RUN_CONFIG, runSuite } from "./run";
import type { EvalCase, RunConfig, RunResult } from "./types";

export const HELP = `Pewter Ghost offline suite

  npx tsx eval/src/cli.ts <command> [options]

Commands
  seed        write eval/data/seed.jsonl from the fixture levels (real window builder + brief)
  run         replay requests through one configuration and score them -> eval/reports/<name>.md
  compare     two configurations (or two saved runs) on the same requests -> delta report
  calibrate   G-27: stated vs logprob vs twoSample confidence against acceptance / first-try
  matrix      G-28: models x window sizes (with and without the summary line)
  dashboard   G-29: static HTML from session logs and saved levels -> eval/dashboard/index.html
  export      G-38: (request, accepted answer) pairs as JSONL for fine-tuning
  help        this text

Requests (run, compare, calibrate, matrix)
  --data <file|dir>      JSONL of eval cases or proxy recordings (repeatable; default eval/data)
  --recordings-too       also read proxy/.data/recordings
  --family f --tag t --mode auto|requested|patrol --match s --limit n

Configuration (run, calibrate, matrix; prefix with a- / b- for compare)
  --model id|recorded    model for the live runner, or the answers stored with each case
  --window 24x12         window size (rebuilds seed cases; recordings are skipped)
  --summary on|off       one-line summary of the level outside the window
  --examples             reference examples in the brief (G-31)
  --no-brief             compact user message (no brief, measures or summary)
  --system <file>        replace the system prompt (A/B a draft)
  --confidence stated|logprob|twoSample   --samples 1|2   --temperature 0.2
  --thinking 0|<n>|default   --send-back always|budget|never   --agent-cap 300   --budget 900
  --name <run name>      default: derived from the settings
  --concurrency 4  --refresh (ignore the call cache)  --strict (exit 1 if variety fails)

compare: compare <runA> <runB> (saved runs in eval/runs), or --a-... / --b-... settings
matrix:  --models m1,m2 --windows 16x10,24x12,32x14 --summary-modes both|on|off
         --target-play 0.6 --target-coords 0.8 --target-schema 0.95 --target-p50 1000
dashboard: --logs <dir> --recordings <dir> --levels <dir> (subfolders = groups) --survey <json> --out <html>
export:  --logs <dir> --recordings <dir> [--run <name>] --format gemini|openai|raw --system full|none --include-partial --out <file>
`;

export interface CliDeps {
  /** Project root (pewter-ghost/). */
  root: string;
  env: LiveEnv;
  log: (line: string) => void;
  /** Model caller for a config (default: live Gemini behind the disk cache). */
  makeCaller?: (cfg: RunConfig, o: { refresh: boolean; cacheErrors: boolean }) => ModelCaller | undefined;
  /** Agent (default: an in-process AgentClient). */
  agent?: AgentLike & { dispose?: () => void };
  now?: () => Date;
}

const ensureDir = (f: string) => mkdirSync(path.dirname(f), { recursive: true });

function write(file: string, text: string): void {
  ensureDir(file);
  writeFileSync(file, text);
}

class Ctx {
  readonly flags: Record<string, FlagValue>;
  readonly positionals: string[];
  private agentInst?: AgentLike & { dispose?: () => void };
  private ownAgent = false;

  constructor(
    readonly deps: CliDeps,
    parsed: { flags: Record<string, FlagValue>; positionals: string[] },
  ) {
    this.flags = parsed.flags;
    this.positionals = parsed.positionals;
  }

  p(...parts: string[]): string {
    return path.resolve(this.deps.root, ...parts);
  }
  abs(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(this.deps.root, p);
  }

  get agent(): AgentLike {
    if (!this.agentInst) {
      this.agentInst = this.deps.agent ?? new AgentClient({ worker: null });
      this.ownAgent = !this.deps.agent;
    }
    return this.agentInst;
  }

  dispose(): void {
    if (this.ownAgent) this.agentInst?.dispose?.();
  }

  systemText = (file: string): { text: string; version: string } => {
    const f = this.abs(file);
    if (!existsSync(f)) throw new ArgError(`--system: ${file} not found`);
    const text = readFileSync(f, "utf8");
    return { text, version: `custom-${createHash("sha256").update(text).digest("hex").slice(0, 8)}` };
  };

  config(prefix = "", base: RunConfig = DEFAULT_RUN_CONFIG): RunConfig {
    return configFromFlags(this.flags, base, prefix, this.systemText);
  }

  cases(): EvalCase[] {
    const inputs = list(this.flags, "data").map((d) => this.abs(d));
    if (!inputs.length) inputs.push(this.p("eval/data"));
    if (bool(this.flags, "recordings-too")) inputs.push(this.p("proxy/.data/recordings"));
    const rep = loadCases(inputs);
    if (rep.badLines.length) this.deps.log(`warning: ${rep.badLines.length} unreadable line(s) in ${[...new Set(rep.badLines.map((b) => b.file))].join(", ")}`);
    const mode = str(this.flags, "mode");
    if (mode !== undefined && !["auto", "requested", "patrol"].includes(mode)) throw new ArgError("--mode: auto, requested or patrol");
    const cases = filterCases(rep.cases, {
      family: str(this.flags, "family"),
      tag: str(this.flags, "tag"),
      mode: mode as EvalCase["request"]["mode"] | undefined,
      match: str(this.flags, "match"),
      limit: num(this.flags, "limit", { int: true, min: 0 }),
    });
    if (!cases.length) throw new ArgError(`no cases found in ${inputs.join(", ")} (run "seed" first?)`);
    return cases;
  }

  caller(cfg: RunConfig): ModelCaller | undefined {
    if (cfg.model === "recorded") return undefined;
    const o = { refresh: bool(this.flags, "refresh"), cacheErrors: bool(this.flags, "cache-errors") };
    if (this.deps.makeCaller) return this.deps.makeCaller(cfg, o);
    if (!hasApiKey(this.deps.env)) throw new ArgError(`model key not set: export VITE_LLM_API_KEY to call ${cfg.model}, or use --model recorded`);
    return new CachedCaller(geminiCaller({ model: cfg.model, thinkingBudget: cfg.thinkingBudget }, this.deps.env), new CallCache(this.p("eval/.cache/calls")), o);
  }

  async run(cases: EvalCase[], cfg: RunConfig): Promise<RunResult> {
    this.deps.log(`run ${cfg.name}: ${cases.length} case(s), model ${cfg.model}`);
    return runSuite(cases, cfg, {
      caller: this.caller(cfg),
      agent: this.agent,
      concurrency: num(this.flags, "concurrency", { int: true, min: 1, max: 32 }) ?? 4,
      log: this.deps.log,
      now: this.deps.now,
    });
  }

  saveRun(run: RunResult): string {
    const f = this.p("eval/runs", `${run.config.name}.json`);
    write(f, JSON.stringify(run, null, 1));
    return f;
  }

  loadRun(name: string): RunResult {
    const f = name.endsWith(".json") ? this.abs(name) : this.p("eval/runs", `${name}.json`);
    if (!existsSync(f)) throw new ArgError(`saved run ${name} not found (${f})`);
    return JSON.parse(readFileSync(f, "utf8")) as RunResult;
  }

  report(name: string, text: string): string {
    const f = this.p("eval/reports", `${name}.md`);
    write(f, text);
    return f;
  }
}

function printSummary(log: (s: string) => void, run: RunResult): void {
  for (const [k, v] of headline(run.summary)) log(`  ${k}: ${v}`);
}

async function cmdRun(c: Ctx): Promise<number> {
  const cfg = c.config();
  const run = await c.run(c.cases(), cfg);
  const runFile = c.saveRun(run);
  const reportName = str(c.flags, "report") ?? cfg.name;
  const rep = c.report(reportName, runReport(run, str(c.flags, "title") ?? `Suite run: ${cfg.name}`));
  printSummary(c.deps.log, run);
  c.deps.log(`report ${path.relative(c.deps.root, rep)}; run ${path.relative(c.deps.root, runFile)}`);
  if (bool(c.flags, "strict") && !run.summary.variety.pass) {
    c.deps.log("FAIL: a pattern tag appeared three times running in a session (G-25)");
    return 1;
  }
  return 0;
}

async function cmdCompare(c: Ctx): Promise<number> {
  let a: RunResult;
  let b: RunResult;
  if (c.positionals.length >= 2) {
    a = c.loadRun(c.positionals[0]);
    b = c.loadRun(c.positionals[1]);
  } else {
    const cases = c.cases();
    const ca = c.config("a-");
    const cb = c.config("b-");
    if (ca.name === cb.name) cb.name = `${cb.name}-B`;
    a = await c.run(cases, ca);
    c.saveRun(a);
    b = await c.run(cases, cb);
    c.saveRun(b);
  }
  const name = str(c.flags, "report") ?? `compare-${a.config.name}-vs-${b.config.name}`;
  const f = c.report(name, compareReport(a, b));
  c.deps.log(`report ${path.relative(c.deps.root, f)}`);
  return 0;
}

async function cmdCalibrate(c: Ctx): Promise<number> {
  const base: RunConfig = { ...DEFAULT_RUN_CONFIG, confidenceSource: "twoSample", samples: 2, temperature: 0.7 };
  const cfg = c.config("", base);
  if (str(c.flags, "name") === undefined) cfg.name = `calibration-${cfg.name}`;
  const run = await c.run(c.cases(), cfg);
  c.saveRun(run);
  const logs = list(c.flags, "logs").map((x) => c.abs(x));
  const recs = list(c.flags, "recordings").map((x) => c.abs(x));
  const labels = logs.length ? acceptanceByRequest(loadSessions(logs, recs.length ? recs : [c.p("proxy/.data/recordings")])) : undefined;
  const rep = calibrate(run.cases, { labels, minN: num(c.flags, "min-n", { int: true, min: 1 }) });
  const f = c.report(str(c.flags, "report") ?? cfg.name, calibrationMarkdown(rep, run));
  for (const s of rep.sources) c.deps.log(`  ${s.source}: n ${s.n}, AUC ${s.stats.auc.toFixed(2)}, high/low ${Number.isFinite(s.stats.bandRatio) ? s.stats.bandRatio.toFixed(2) : "n/a"}`);
  c.deps.log(`pick ${rep.pick ?? "none"}; report ${path.relative(c.deps.root, f)}`);
  return 0;
}

async function cmdMatrix(c: Ctx): Promise<number> {
  const base = c.config();
  const models = list(c.flags, "models");
  const windows = (list(c.flags, "windows").length ? list(c.flags, "windows") : ["16x10", "24x12", "32x14"]).map(parseWindow);
  const sm = str(c.flags, "summary-modes") ?? "both";
  if (!["both", "on", "off"].includes(sm)) throw new ArgError("--summary-modes: both, on or off");
  const summaries = sm === "both" ? [true, false] : [sm === "on"];
  const targets: MatrixTargets = {
    playFirstTry: num(c.flags, "target-play", { min: 0, max: 1 }) ?? DEFAULT_TARGETS.playFirstTry,
    coordAccuracy: num(c.flags, "target-coords", { min: 0, max: 1 }) ?? DEFAULT_TARGETS.coordAccuracy,
    schemaOk: num(c.flags, "target-schema", { min: 0, max: 1 }) ?? DEFAULT_TARGETS.schemaOk,
    latencyP50Ms: num(c.flags, "target-p50", { min: 1 }) ?? DEFAULT_TARGETS.latencyP50Ms,
  };
  const cases = c.cases().filter(canRebuild);
  if (!cases.length) throw new ArgError("matrix needs cases with a full level (the seed set); recordings cannot be re-windowed");
  const cells: MatrixCell[] = [];
  for (const cfg of matrixConfigs(base, { models: models.length ? models : [base.model], windows, summaries })) {
    const run = await c.run(cases, cfg);
    c.saveRun(run);
    cells.push({ model: cfg.model, window: cfg.window!, summary: cfg.summary!, run, ...judgeCell(run, targets) });
  }
  const name = str(c.flags, "report") ?? `matrix-${str(c.flags, "name") ?? "default"}`;
  const f = c.report(name, matrixMarkdown(cells, targets));
  const { cell, why } = chooseCell(cells);
  c.deps.log(`choice: ${cell ? `${cell.model} ${cell.window.cols}x${cell.window.rows} summary ${cell.summary ? "on" : "off"}` : "none"} (${why}); report ${path.relative(c.deps.root, f)}`);
  return 0;
}

/** Saved levels: a directory of save files, or of subdirectories (one group each). */
export function loadLevelGroups(dir: string): { group: string; levels: { name: string; level: LevelSnapshot }[] }[] {
  if (!existsSync(dir)) return [];
  const read = (d: string) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .flatMap((f) => {
        const r = parseSave(readFileSync(path.join(d, f), "utf8"));
        return r.ok ? [{ name: f.replace(/\.json$/, ""), level: r.snapshot }] : [];
      });
  const subs = readdirSync(dir).filter((f) => statSync(path.join(dir, f)).isDirectory()).sort();
  const groups = subs.map((s) => ({ group: s, levels: read(path.join(dir, s)) })).filter((g) => g.levels.length);
  const top = read(dir);
  if (top.length) groups.unshift({ group: path.basename(dir), levels: top });
  return groups;
}

async function cmdDashboard(c: Ctx): Promise<number> {
  const logs = list(c.flags, "logs").map((x) => c.abs(x));
  const recs = list(c.flags, "recordings").map((x) => c.abs(x));
  const sessions = loadSessions(logs.length ? logs : [c.p("proxy/.data/logs")], recs.length ? recs : [c.p("proxy/.data/recordings")]);
  const levelsDir = str(c.flags, "levels");
  const groups = levelsDir ? loadLevelGroups(c.abs(levelsDir)) : [];
  const surveyFile = str(c.flags, "survey");
  const survey = surveyFile ? (JSON.parse(readFileSync(c.abs(surveyFile), "utf8")) as SurveyAnswer[]) : undefined;
  const m = computeMetrics(sessions, groups, { survey });
  const out = c.abs(str(c.flags, "out") ?? "eval/dashboard/index.html");
  write(out, renderDashboard(m, { generatedAt: (c.deps.now ?? (() => new Date()))().toISOString() }));
  write(out.replace(/\.html$/, "") + ".json", JSON.stringify(m, null, 1));
  c.deps.log(`${sessions.length} session(s), ${m.ghosts} ghost(s), ${groups.reduce((a, g) => a + g.levels.length, 0)} level(s); dashboard ${path.relative(c.deps.root, out)}`);
  return 0;
}

async function cmdExport(c: Ctx): Promise<number> {
  const format = (str(c.flags, "format") ?? "gemini") as ExportFormat;
  if (!["gemini", "openai", "raw"].includes(format)) throw new ArgError("--format: gemini, openai or raw");
  const system = (str(c.flags, "system") ?? "full") as "full" | "none";
  if (!["full", "none"].includes(system)) throw new ArgError("--system: full or none");
  const logs = list(c.flags, "logs").map((x) => c.abs(x));
  const recs = list(c.flags, "recordings").map((x) => c.abs(x));
  const sessions = loadSessions(logs.length ? logs : [c.p("proxy/.data/logs")], recs.length ? recs : [c.p("proxy/.data/recordings")]);
  const pairs = pairsFromLogs(sessions, { includePartial: bool(c.flags, "include-partial") });
  const runName = str(c.flags, "run");
  if (runName) {
    const run = c.loadRun(runName);
    const requests = new Map<string, FillRequest>();
    for (const k of c.cases()) {
      const r = requestFor(k, run.config);
      if (r) requests.set(k.id, r);
    }
    pairs.push(...pairsFromRun(run, requests));
  }
  const out = c.abs(str(c.flags, "out") ?? `eval/data/export/finetune-${format}.jsonl`);
  const text = exportJsonl(pairs, { format, system });
  write(out, text);
  c.deps.log(`${text ? text.trimEnd().split("\n").length : 0} pair(s) -> ${path.relative(c.deps.root, out)}`);
  return 0;
}

async function cmdSeed(c: Ctx): Promise<number> {
  const cases = await buildSeedCases();
  const out = c.abs(str(c.flags, "out") ?? "eval/data/seed.jsonl");
  write(out, toJsonl(cases));
  const fam = new Map<string, number>();
  for (const k of cases) fam.set(k.family ?? "?", (fam.get(k.family ?? "?") ?? 0) + 1);
  c.deps.log(`${cases.length} seed case(s) -> ${path.relative(c.deps.root, out)} (${[...fam].map(([f, n]) => `${f} ${n}`).join(", ")})`);
  return 0;
}

/** Entry point: returns the exit code. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    deps.log(`error: ${(e as Error).message}`);
    return 2;
  }
  const cmd = parsed.command ?? "help";
  if (cmd === "help" || parsed.flags.help === true) {
    deps.log(HELP);
    return 0;
  }
  const commands: Record<string, (c: Ctx) => Promise<number>> = {
    run: cmdRun,
    compare: cmdCompare,
    calibrate: cmdCalibrate,
    matrix: cmdMatrix,
    dashboard: cmdDashboard,
    export: cmdExport,
    seed: cmdSeed,
  };
  const fn = commands[cmd];
  if (!fn) {
    deps.log(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  }
  const ctx = new Ctx(deps, parsed);
  try {
    return await fn(ctx);
  } catch (e) {
    if (e instanceof ArgError) {
      deps.log(`error: ${e.message}`);
      return 2;
    }
    throw e;
  } finally {
    ctx.dispose();
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  loadDotEnv(root);
  main(process.argv.slice(2), { root, env: process.env, log: (s) => console.log(s) })
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`eval failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
