import { describe, expect, it } from "vitest";
import { knightLimits } from "@jump-tables";
import { buildComputedContext, describeComputedContext } from "./context";
import { renderUserMessage } from "./prompt";
import { buildFillRequest } from "./window";
import { FIXTURES } from "./__fixtures__/states";

describe("computed context", () => {
  it("includes context block in the user prompt when present", () => {
    const f = FIXTURES[1]();
    const req = buildFillRequest(f.model, f.stream, { now: f.now, knight: knightLimits() });
    const block = describeComputedContext(req);
    if (block) req.computedContext = block;
    const user = renderUserMessage(req);
    if (block) expect(user).toContain("Computed context");
  });

  it("buildComputedContext is deterministic", () => {
    const f = FIXTURES[1]();
    const req = buildFillRequest(f.model, f.stream, { now: f.now, knight: knightLimits() });
    expect(buildComputedContext(req)).toEqual(buildComputedContext(req));
  });
});
