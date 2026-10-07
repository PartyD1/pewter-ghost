import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentClient, type AgentQuery, type AgentResult } from "@physsim";
import { TILE, type FillRequest, type Suggestion } from "../contracts";
import { isVerified } from "../suggest/verified";
import { fillRequest, GROUND, groundRows, H, modelFrom, rect, sugg, W } from "./__fixtures__/levels";
import { contentFrontier, Patrol, patrolRequest, proposeRepair, verifyPatrolFix, type PatrolReport, type TimerApi } from "./patrol";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());
const config = { patrolIdleMs: 3000, patrolCapMs: 1000, agentCapMs: 300, sendBackIfUnderMs: 500 };

/** 14-wide pit at 20..33: the knight clears 11. */
const pitLevel = () => modelFrom(groundRows([[0, 19], [34, W - 1]]));
/** Flat ground with a 7-tall, 2-wide wall at 20..21: the knight climbs 6. */
const wallLevel = () => modelFrom(groundRows([[0, W - 1]], W, H, (x, y) => (x >= 20 && x <= 21 && y >= 1 && y < GROUND ? "#" : undefined)));

function manualTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  const api: TimerApi = {
    set(fn, ms) {
      const id = next++;
      pending.push({ fn, ms, id });
      return id;
    },
    clear(h) {
      const i = pending.findIndex((p) => p.id === h);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return {
    api,
    pending,
    fire() {
      const p = pending.shift();
      p?.fn();
      return p;
    },
  };
}

describe("Patrol", () => {
  it("finds the blocking gap and reports where and why", async () => {
    const level = pitLevel();
    const log = vi.fn();
    const onBlocked = vi.fn();
    const p = new Patrol({ level, agent, config, log, onBlocked, frontier: () => W - 1 });
    const r = await p.runNow();
    expect(r.beatable).toBe(false);
    expect(r.blocked!.blockedAt.x).toBeGreaterThanOrEqual(17);
    expect(r.blocked!.blockedAt.x).toBeLessThanOrEqual(19);
    expect(r.blocked!.reason).toBeTruthy();
    expect(r.goalX).toBe(W - 1);
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: "patrol", beatable: false, blockedAt: r.blocked!.blockedAt }));
  });

  it("the fallback repair makes the blocking gap beatable with <= 3 tiles", async () => {
    const level = pitLevel();
    const p = new Patrol({ level, agent, config });
    const r = await p.runNow();
    expect(r.beatable).toBe(false);
    const fix = await proposeRepair(level, r.blocked!.blockedAt, { agent, config });
    expect(fix).not.toBeNull();
    expect(fix!).toMatchObject({ kind: "fix", mode: "patrol", filler: "algo", verified: false });
    expect(fix!.adds.length + fix!.removes.length).toBeLessThanOrEqual(3);
    expect(fix!.label).toMatch(/gap 14 · knight clears 11/);
    level.applySuggestion(fix!);
    const again = await p.runNow();
    expect(again.beatable).toBe(true);
    expect(again.path!.length).toBeGreaterThan(0);
  });

  it("repairs a wall that is too tall to climb", async () => {
    const level = wallLevel();
    const p = new Patrol({ level, agent, config });
    const r = await p.runNow();
    expect(r.beatable).toBe(false);
    const fix = await proposeRepair(level, r.blocked!.blockedAt, { agent, config });
    expect(fix).not.toBeNull();
    expect(fix!.adds.length + fix!.removes.length).toBeLessThanOrEqual(3);
    level.applySuggestion(fix!);
    expect((await p.runNow()).beatable).toBe(true);
  });

  it("reports a beatable level, sets a checkpoint and patrols incrementally from it", async () => {
    const level = modelFrom(groundRows([[0, 30]]));
    const reports: PatrolReport[] = [];
    const queries: AgentQuery[] = [];
    const spy = { patrol: (q: AgentQuery, o?: { signal?: AbortSignal }) => (queries.push(q), agent.patrol(q, o)) };
    const p = new Patrol({ level, agent: spy, config, onReport: (r) => reports.push(r) });
    const r1 = await p.runNow();
    expect(r1).toMatchObject({ beatable: true, incremental: false, goalX: 30 });
    const cp = p.checkpoint!;
    expect(cp.x).toBe(30);
    // Same revision: cached, no new agent run.
    expect((await p.runNow()).cached).toBe(true);
    expect(queries).toHaveLength(1);

    p.start();
    level.paint(rect(31, 40, GROUND, H - 1, TILE.GRASS)); // right of the checkpoint
    expect(p.checkpoint).toEqual(cp);
    const r2 = await p.runNow();
    expect(r2).toMatchObject({ beatable: true, incremental: true, goalX: 40 });
    expect(queries.at(-1)!.from).toEqual(cp);

    level.paint([{ x: 5, y: 3, tile: TILE.BLOCK }]); // left of it
    expect(p.checkpoint).toBeNull();
    p.stop();
  });

  it("an over-cap run the rules call fine is inconclusive, not blocked", async () => {
    const level = modelFrom(groundRows([[0, 30]]));
    const onBlocked = vi.fn();
    const slow = {
      async patrol(_q: AgentQuery): Promise<AgentResult> {
        return { found: false, path: [], nodes: 1, ms: 1000, timedOut: true, exhausted: false, rules: { ok: true, path: [], unreachable: [], ms: 1 } };
      },
    };
    const p = new Patrol({ level, agent: slow, config, onBlocked });
    const r = await p.runNow();
    expect(r.beatable).toBeNull();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("runs after patrolIdleMs of no edits; edits restart the countdown", async () => {
    const level = pitLevel();
    const t = manualTimers();
    const onReport = vi.fn();
    const p = new Patrol({ level, agent, config, timers: t.api, onReport });
    p.start();
    expect(t.pending).toHaveLength(1);
    expect(t.pending[0].ms).toBe(3000);
    level.paint([{ x: 40, y: 3, tile: TILE.BLOCK }]);
    expect(t.pending).toHaveLength(1); // re-armed, not stacked
    t.fire();
    await vi.waitFor(() => expect(onReport).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(onReport.mock.calls[0][0].beatable).toBe(false);
    p.stop();
    expect(t.pending).toHaveLength(0);
  });

  it("uses the content frontier when none is given", () => {
    expect(contentFrontier(pitLevel().snapshot())).toBe(W - 1);
    expect(contentFrontier(modelFrom(groundRows([[0, 12]])).snapshot())).toBe(12);
  });
});

describe("patrolRequest", () => {
  it("sets mode, the window-relative blocking point and the reason", () => {
    const base = fillRequest({ origin: { x: 10, y: 0 } });
    const r = patrolRequest(base, { blockedAt: { x: 19, y: 7 }, reason: "gap 14", from: { x: 1, y: 7 }, goalX: 47 });
    expect(r).toMatchObject({ mode: "patrol", blockedAt: { x: 9, y: 7 }, previousFailure: { reason: "gap 14", stage: "agent" } });
  });
});

describe("verifyPatrolFix", () => {
  it("falls back to the local repair when the model's fix fails twice", async () => {
    const level = pitLevel();
    const r = await new Patrol({ level, agent, config }).runNow();
    const blocked = r.blocked!;
    const useless = (id: string) => sugg({ id, kind: "fix", mode: "patrol", adds: rect(21, 21, H - 1, H - 1), latencyMs: 100 });
    const requests: FillRequest[] = [];
    const filler = { fill: vi.fn(async (q: FillRequest) => (requests.push(q), useless("second"))) };
    const out = await verifyPatrolFix(level, patrolRequest(fillRequest(), blocked), useless("first"), filler, blocked, { agent, config });
    expect(filler.fill).toHaveBeenCalledOnce();
    expect(requests[0].mode).toBe("patrol");
    expect(out.attempts).toBe(2);
    expect(out.usedFallback).toBe(true);
    expect(isVerified(out.verified)).toBe(true);
    expect(out.verified).toMatchObject({ kind: "fix", filler: "algo", mode: "patrol" });
    // Accepting it makes the level beatable to the frontier.
    level.applySuggestion(out.verified as Suggestion);
    expect((await new Patrol({ level, agent, config }).runNow()).beatable).toBe(true);
  });

  it("keeps the model's fix when it works", async () => {
    const level = pitLevel();
    const r = await new Patrol({ level, agent, config }).runNow();
    const fix = sugg({ id: "model-fix", kind: "fix", mode: "patrol", adds: rect(26, 28, GROUND - 1, GROUND - 1) });
    const out = await verifyPatrolFix(level, fillRequest(), fix, { fill: vi.fn() }, r.blocked!, { agent, config });
    expect(out.usedFallback).toBe(false);
    expect(out.verified).toMatchObject({ id: "model-fix" });
  });
});
