import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentClient } from "@physsim";
import { answerJson } from "../../apps/editor/src/fill/prompt";
import { packLevel } from "./cases";
import { HELP, main, type CliDeps } from "./cli";
import { toJsonl } from "./fixtures/seed";
import { UpstreamCaller } from "./live";
import { levelFor } from "./cases";
import { snapshotToSave } from "../../apps/editor/src/level/save";
import { FakeUpstream, nextToFrontier, quickCases, scriptedSession } from "./__fixtures__/fakes";
import type { RunResult } from "./types";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());

/** A temp project root with a small seed file. */
async function project() {
  const root = mkdtempSync(path.join(os.tmpdir(), "eval-cli-"));
  const cases = await quickCases(["stairs-up-2wide", "gap-run-3", "erasing"]);
  mkdirSync(path.join(root, "eval/data"), { recursive: true });
  writeFileSync(path.join(root, "eval/data/seed.jsonl"), toJsonl(cases));
  return { root, cases };
}

/** Deps with a fake upstream that always answers "one block next to the frontier" (parsed from the user text). */
function deps(root: string, o: Partial<CliDeps> = {}) {
  const lines: string[] = [];
  const models: string[] = [];
  const d: CliDeps = {
    root,
    env: {},
    log: (s) => lines.push(s),
    agent,
    now: () => new Date("2026-10-07T12:00:00Z"),
    makeCaller: (cfg) => {
      models.push(cfg.model);
      return new UpstreamCaller(
        new FakeUpstream(cfg.model, (p) => {
          const m = /frontier[^\n]*?\((\d+),\s*(\d+)\)/i.exec(p.user) ?? /frontier[^\n]*?x\s*=?\s*(\d+)[^\n]*?y\s*=?\s*(\d+)/i.exec(p.user);
          const x = m ? Number(m[1]) + 1 : 1;
          const y = m ? Number(m[2]) : 1;
          return answerJson({ ...nextToFrontier({ frontier: { x: x - 1, y, idleMs: 0 }, size: { w: 99, h: 99 } } as never), adds: [{ x, y, tile: "block" }] });
        }),
      );
    },
    ...o,
  };
  return { d, lines, models };
}

describe("cli", () => {
  it("prints help and rejects unknown commands and bad flags", async () => {
    const { d, lines } = deps("/nonexistent");
    expect(await main(["help"], d)).toBe(0);
    expect(lines[0]).toBe(HELP);
    expect(await main(["frobnicate"], d)).toBe(2);
    expect(await main(["run", "--model"], d)).toBe(2);
    expect(lines.join("\n")).toMatch(/needs a value/);
  });

  it("refuses live runs without a key and never prints one", async () => {
    const { root } = await project();
    const { d, lines } = deps(root, { makeCaller: undefined, env: {} });
    expect(await main(["run"], d)).toBe(2);
    expect(lines.join("\n")).toMatch(/VITE_LLM_API_KEY/);
  });

  it("run writes a report and a saved run", async () => {
    const { root } = await project();
    const { d, lines, models } = deps(root);
    expect(await main(["run", "--name", "t1", "--model", "gemini-fake"], d)).toBe(0);
    expect(models).toEqual(["gemini-fake"]);
    const md = readFileSync(path.join(root, "eval/reports/t1.md"), "utf8");
    expect(md).toContain("# Suite run: t1");
    expect(md).toContain("| Schema ok | 100.0% |");
    const run = JSON.parse(readFileSync(path.join(root, "eval/runs/t1.json"), "utf8")) as RunResult;
    expect(run.cases).toHaveLength(3);
    expect(lines.some((l) => l.includes("Playability first try"))).toBe(true);
    // filters
    expect(await main(["run", "--name", "t2", "--family", "gaps"], d)).toBe(0);
    expect((JSON.parse(readFileSync(path.join(root, "eval/runs/t2.json"), "utf8")) as RunResult).cases).toHaveLength(1);
    expect(await main(["run", "--family", "nothing"], d)).toBe(2);
  });

  it("compare runs two configs, or two saved runs", async () => {
    const { root } = await project();
    const { d, models } = deps(root);
    expect(await main(["compare", "--a-model", "m-small", "--b-model", "m-big", "--b-window", "16x10", "--report", "cmp"], d)).toBe(0);
    expect(models).toEqual(["m-small", "m-big"]);
    const md = readFileSync(path.join(root, "eval/reports/cmp.md"), "utf8");
    expect(md).toContain("| measure | A | B | delta | |");
    expect(md).toContain("window 16x10");
    expect(await main(["compare", "m-small", "m-big-16x10"], d)).toBe(0);
    expect(existsSync(path.join(root, "eval/reports/compare-m-small-vs-m-big-16x10.md"))).toBe(true);
    expect(await main(["compare", "nope", "m-small"], d)).toBe(2);
  });

  it("calibrate and matrix write their reports", async () => {
    const { root } = await project();
    const { d, models } = deps(root);
    expect(await main(["calibrate", "--model", "m"], d)).toBe(0);
    const cal = readFileSync(path.join(root, "eval/reports/calibration-m-twoSample-t0.7.md"), "utf8");
    expect(cal).toContain("# Confidence calibration (G-27)");
    expect(await main(["matrix", "--models", "m1,m2", "--windows", "16x10,24x12", "--summary-modes", "on", "--name", "x"], d)).toBe(0);
    expect(models.slice(1)).toEqual(["m1", "m1", "m2", "m2"]);
    const mx = readFileSync(path.join(root, "eval/reports/matrix-x.md"), "utf8");
    expect(mx).toContain("| m1 | 16x10 | on |");
    expect(mx).toContain("**Choice:**");
  });

  it("dashboard and export read logs, recordings and saved levels", async () => {
    const { root, cases } = await project();
    const { events, recordings } = scriptedSession(cases);
    mkdirSync(path.join(root, "proxy/.data/logs"), { recursive: true });
    mkdirSync(path.join(root, "proxy/.data/recordings"), { recursive: true });
    writeFileSync(path.join(root, "proxy/.data/logs/s1.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    writeFileSync(path.join(root, "proxy/.data/recordings/s1.jsonl"), recordings.map((e) => JSON.stringify(e)).join("\n"));
    mkdirSync(path.join(root, "levels/saved/ghost"), { recursive: true });
    for (const c of cases) writeFileSync(path.join(root, "levels/saved/ghost", `${c.id}.json`), JSON.stringify(snapshotToSave(levelFor(c), { savedAt: null })));
    writeFileSync(path.join(root, "survey.json"), JSON.stringify([{ sessionId: "s1", idea: false }]));
    const { d, lines } = deps(root);
    expect(await main(["dashboard", "--levels", "levels/saved", "--survey", "survey.json"], d)).toBe(0);
    const html = readFileSync(path.join(root, "eval/dashboard/index.html"), "utf8");
    expect(html).toContain("1 session(s), 3 ghost(s) shown, generated 2026-10-07T12:00:00.000Z");
    expect(html).toContain("Expressive range: ghost (3 levels)");
    expect(existsSync(path.join(root, "eval/dashboard/index.json"))).toBe(true);
    expect(lines.at(-1)).toMatch(/1 session\(s\), 3 ghost\(s\), 3 level\(s\)/);

    expect(await main(["export", "--format", "openai", "--system", "none", "--include-partial"], d)).toBe(0);
    const out = readFileSync(path.join(root, "eval/data/export/finetune-openai.jsonl"), "utf8").trim().split("\n");
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]).messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(await main(["export", "--format", "csv"], d)).toBe(2);

    // Suite answers can be exported from a saved run.
    expect(await main(["run", "--name", "r"], d)).toBe(0);
    expect(await main(["export", "--run", "r", "--format", "raw", "--out", "x.jsonl"], d)).toBe(0);
    const raw = readFileSync(path.join(root, "x.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(raw.some((p) => p.source === "accepted")).toBe(true);
  });

  it("seed --out writes a seed file", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "eval-seed-"));
    const { d } = deps(root);
    expect(await main(["seed", "--out", "s.jsonl"], d)).toBe(0);
    const n = readFileSync(path.join(root, "s.jsonl"), "utf8").trim().split("\n").length;
    expect(n).toBeGreaterThanOrEqual(40);
  }, 60_000);

  it("packLevel round-trips through the save format", async () => {
    const [c] = await quickCases(["pillar-hop"]);
    expect(packLevel(levelFor(c))).toEqual(c.level);
  });
});
