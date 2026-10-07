import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentClient } from "@physsim";
import type { FillRequest, Suggestion } from "../contracts";
import { isVerified } from "../suggest/verified";
import { fillRequest, GROUND, groundRows, H, modelFrom, rect, sugg } from "./__fixtures__/levels";
import { verifyWithSendBack } from "./pipeline";

const agent = new AgentClient({ worker: null });
afterAll(() => agent.dispose());
const config = { agentCapMs: 300, sendBackIfUnderMs: 500 };

const level = () => modelFrom(groundRows([[0, 19]]));
/** Lands 13 tiles away: fails (measure: the knight clears 11). */
const bad = (latencyMs = 100) => sugg({ id: "bad", adds: rect(33, 40, GROUND, H - 1), latencyMs });
/** Lands 4 tiles away: passes. */
const good = (latencyMs = 100) => sugg({ id: "good", adds: rect(24, 31, GROUND, H - 1), latencyMs });

function fakeFiller(answers: (Suggestion | null | Error)[]) {
  const requests: FillRequest[] = [];
  const fill = vi.fn(async (r: FillRequest) => {
    requests.push(r);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a ?? null;
  });
  return { fill, requests };
}

describe("verifyWithSendBack", () => {
  it("verifies a good first answer without calling the filler again", async () => {
    const f = fakeFiller([]);
    const out = await verifyWithSendBack(level(), fillRequest(), good(), f, { agent, config });
    expect(f.fill).not.toHaveBeenCalled();
    expect(out.attempts).toBe(1);
    expect(out.sendBack).toBe(false);
    expect(isVerified(out.verified)).toBe(true);
    expect(out.verified).toMatchObject({ id: "good", verified: true, attempts: 1 });
    expect(out.verified!.path!.length).toBeGreaterThan(0);
    expect(out.verdicts).toHaveLength(1);
    expect(out.verdicts[0]).toMatchObject({ ok: true, stage: "agent", attempt: 1, source: "model" });
  });

  it("first answer bad and fast: sends it back with the reason, second answer good", async () => {
    const f = fakeFiller([good(200)]);
    const onVerdict = vi.fn();
    const out = await verifyWithSendBack(level(), fillRequest(), bad(), f, { agent, config, onVerdict });
    expect(f.fill).toHaveBeenCalledTimes(1);
    const sent = f.requests[0];
    expect(sent.previousFailure?.stage).toBe("measure");
    expect(sent.previousFailure?.reason).toMatch(/gap at x=20 is 13 wide; the knight clears 11/);
    expect(out.sendBack).toBe(true);
    expect(out.attempts).toBe(2);
    expect(out.verified).toMatchObject({ id: "good", attempts: 2, verified: true });
    expect(isVerified(out.verified)).toBe(true);
    expect(out.verdicts.map((v) => [v.attempt, v.ok])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(onVerdict).toHaveBeenCalledTimes(2);
  });

  it("slow first answer: no send-back, dropped", async () => {
    const f = fakeFiller([good()]);
    const out = await verifyWithSendBack(level(), fillRequest(), bad(800), f, { agent, config });
    expect(f.fill).not.toHaveBeenCalled();
    expect(out.verified).toBeNull();
    expect(out.sendBack).toBe(false);
    expect(out.verdicts).toHaveLength(1);
  });

  it("both answers bad: dropped with two verdicts", async () => {
    const f = fakeFiller([bad()]);
    const out = await verifyWithSendBack(level(), fillRequest(), bad(), f, { agent, config });
    expect(out.verified).toBeNull();
    expect(out.attempts).toBe(2);
    expect(out.verdicts).toHaveLength(2);
  });

  it("a filler error on send-back drops the suggestion and records the error", async () => {
    const f = fakeFiller([new Error("proxy 502")]);
    const out = await verifyWithSendBack(level(), fillRequest(), bad(), f, { agent, config });
    expect(out.verified).toBeNull();
    expect(out.error).toBe("proxy 502");
    expect(out.attempts).toBe(1);
  });

  it("uses the fallback when the model's answers fail, and verifies it", async () => {
    const f = fakeFiller([bad()]);
    const fallback = vi.fn(() => sugg({ id: "fb", filler: "algo", adds: rect(24, 31, GROUND, H - 1) }));
    const out = await verifyWithSendBack(level(), fillRequest(), bad(), f, { agent, config, fallback });
    expect(fallback).toHaveBeenCalledOnce();
    expect(out.usedFallback).toBe(true);
    expect(out.verified).toMatchObject({ id: "fb", filler: "algo" });
    expect(out.verdicts.at(-1)).toMatchObject({ attempt: 3, source: "fallback", ok: true });
  });

  it("an unplayable fallback is not shown either", async () => {
    const out = await verifyWithSendBack(level(), fillRequest(), null, fakeFiller([]), {
      agent,
      config,
      fallback: () => bad(),
    });
    expect(out.verified).toBeNull();
    expect(out.usedFallback).toBe(true);
  });

  it("never verifies an empty answer", async () => {
    const out = await verifyWithSendBack(level(), fillRequest(), sugg({}), fakeFiller([]), {
      agent,
      config: { ...config, sendBackIfUnderMs: 0 },
      validate: { act: false },
    });
    expect(out.verified).toBeNull();
  });

  it("rejects with AbortError when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      verifyWithSendBack(level(), fillRequest(), good(), fakeFiller([]), { agent, config, signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an abort during the send-back call propagates", async () => {
    const ac = new AbortController();
    const filler = {
      fill: vi.fn(async () => {
        ac.abort();
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }),
    };
    await expect(
      verifyWithSendBack(level(), fillRequest(), bad(), filler, { agent, config, signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
