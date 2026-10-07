import { it } from "vitest";
import { AgentClient } from "@physsim";
import { FIXTURES } from "./__fixtures__/states";
import { buildFillRequest } from "./window";
import { measureRequestWindow } from "./brief";
import { AlgoFiller } from "./AlgoFiller";
import { verifyOnce } from "../verify";
it("explore", async () => {
  const agent = new AgentClient({ worker: null });
  for (const mk of FIXTURES) {
    const f = mk();
    const req = buildFillRequest(f.model, f.stream, { now: f.now, mode: f.mode, lastGhosts: f.lastGhosts, measure: measureRequestWindow, blockedAt: f.blockedAt });
    const af = new AlgoFiller({ config: { kinds: { finish: true, extend: true, fix: true }, pauseMs: 800 } });
    const s = await af.fill(req);
    console.log(f.name, af.lastProposal?.source, af.lastProposal?.answer.label, af.lastProposal?.answer.confidence, af.lastProposal?.valid, af.lastProposal?.ms.toFixed(1));
    console.log(req.grid);
    if (s) { const v = await verifyOnce(f.model, s, { agent, validate: { lastGhosts: f.lastGhosts } }); console.log(JSON.stringify(v).slice(0, 300)); console.log(JSON.stringify(s.adds.slice(0,6)), JSON.stringify(s.entities)); }
  }
  agent.dispose();
});
