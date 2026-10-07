import { describe, expect, it } from "vitest";
import { chooseCell, judgeCell, matrixConfigs, matrixMarkdown, DEFAULT_TARGETS, type MatrixCell } from "./matrix";
import { DEFAULT_RUN_CONFIG } from "./run";
import { summarize } from "./report";
import type { CaseResult, RunResult } from "./types";

function fakeRun(play: number, coords: number, p50: number): RunResult {
  const cases: CaseResult[] = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`, sessionId: "s", seq: i, mode: "auto", requestHash: `h${i}`, latencyMs: p50, schemaOk: true, act: true, cells: 1, dropped: 0,
    firstTryOk: i < play * 10, firstStage: i < play * 10 ? "ok" : "agent",
    coord: { items: 1, inWindow: 1, levelCoords: 0, free: 1, share: 1, groups: 1, anchoredGroups: 1, enemies: 0, groundedEnemies: 0, focusDistance: 1, local: true, accurate: i < coords * 10, issues: [] },
  }));
  const config = { ...DEFAULT_RUN_CONFIG };
  return { config, promptVersion: "p", startedAt: "", finishedAt: "", cases, summary: summarize(cases, config) };
}

describe("matrix (G-28)", () => {
  it("expands models x windows (by area) x summary", () => {
    const cfgs = matrixConfigs(DEFAULT_RUN_CONFIG, {
      models: ["small", "big"],
      windows: [{ cols: 32, rows: 14 }, { cols: 16, rows: 10 }],
      summaries: [true, false],
    });
    expect(cfgs.map((c) => c.name)).toEqual([
      "small-16x10-sum", "small-16x10-nosum", "small-32x14-sum", "small-32x14-nosum",
      "big-16x10-sum", "big-16x10-nosum", "big-32x14-sum", "big-32x14-nosum",
    ]);
  });

  it("chooses the smallest model and window meeting the targets", () => {
    const mk = (model: string, cols: number, run: RunResult): MatrixCell => ({ model, window: { cols, rows: 10 }, summary: true, run, ...judgeCell(run, DEFAULT_TARGETS) });
    const cells = [
      mk("small", 16, fakeRun(0.4, 0.9, 500)),
      mk("small", 24, fakeRun(0.7, 0.9, 1500)),
      mk("big", 16, fakeRun(0.8, 0.9, 800)),
    ];
    expect(cells.map((c) => [c.meetsQuality, c.meetsLatency])).toEqual([[false, true], [true, false], [true, true]]);
    expect(chooseCell(cells).cell?.model).toBe("big");
    expect(chooseCell(cells.slice(0, 2)).why).toMatch(/latency/);
    expect(chooseCell(cells.slice(0, 1)).why).toMatch(/quality/);
    const md = matrixMarkdown(cells, DEFAULT_TARGETS);
    expect(md).toContain("| big | 16x10 | on |");
    expect(md).toContain("**Choice:** `big`");
  });
});
