import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FillRequest, ModelAnswer } from "../contracts";
import { bundleIsFresh } from "../../../../prompts/build";
import { FEWSHOTS } from "../../../../prompts/bundle";
import { fewShotFiles } from "../../../../prompts/fewshot/make";
import { SCENARIOS, scenarioRequest } from "../../../../prompts/fewshot/scenarios";
import { validateSuggestion } from "../verify/validate";
import { convertModelAnswer } from "./answer";
import { BRIEF_STATIC } from "./brief";
import { FIXTURES } from "./__fixtures__/states";
import {
  ANSWER_KEY_ORDER,
  answerJson,
  knightReachTable,
  parseModelAnswer,
  parseModelAnswerDetailed,
  PROMPT_VERSION,
  renderFillPrompt,
  renderUserMessage,
  responseSchema,
  SYSTEM_PROMPT,
} from "./prompt";
import { buildFillRequest, EMPTY_GLYPH, estimateTokens, gridRows, PATROL_GLYPH } from "./window";

const SNAP_DIR = "../../../../prompts/__snapshots__";
const PROMPTS_DIR = path.resolve(__dirname, "../../../../prompts");

/** System prompt budget (est. tokens). The plan's ~1,200 is the per-request part; the system part is cacheable. */
const SYSTEM_BUDGET = 7500;
/** Per-request user message budget for the fixture states (brief placeholder). */
const USER_BUDGET = 1000;

function fixtureRequest(make: (typeof FIXTURES)[number]): FillRequest {
  const f = make();
  return buildFillRequest(f.model, f.stream, {
    now: f.now,
    mode: f.mode,
    blockedAt: f.blockedAt,
    previousFailure: f.previousFailure,
    lastGhosts: f.lastGhosts,
  });
}

describe("generated sources", () => {
  it("prompts/bundle.ts is up to date with prompts/*", () => {
    expect(bundleIsFresh(), "run: npx tsx prompts/build.ts").toBe(true);
  });

  it("few-shot JSON files match their scenarios", () => {
    for (const f of fewShotFiles()) {
      const onDisk = readFileSync(path.join(PROMPTS_DIR, "fewshot", f.name), "utf8");
      expect(onDisk, `${f.name} is stale: run npx tsx prompts/fewshot/make.ts`).toBe(f.text);
    }
  });
});

describe("few-shot examples", () => {
  it("has six: two act:false, one fix with removals, one coin arc, one patrol", () => {
    expect(FEWSHOTS).toHaveLength(6);
    expect(FEWSHOTS.filter((s) => !s.answer.act)).toHaveLength(2);
    expect(FEWSHOTS.some((s) => s.answer.kind === "fix" && s.answer.removes.length > 0)).toBe(true);
    expect(FEWSHOTS.some((s) => s.answer.entities.filter((e) => e.kind === "coin").length >= 3)).toBe(true);
    expect(FEWSHOTS.some((s) => s.request.mode === "patrol" && s.request.blockedAt)).toBe(true);
  });

  it("every answer parses unchanged and lies inside its window", () => {
    for (const s of FEWSHOTS) {
      const parsed = parseModelAnswer(JSON.parse(answerJson(s.answer)));
      expect(parsed, s.id).toEqual(s.answer);
      const cells = [...s.answer.adds, ...s.answer.removes, ...s.answer.entities];
      for (const c of cells) {
        expect(c.x >= 0 && c.x < s.request.size.w && c.y >= 0 && c.y < s.request.size.h, `${s.id} (${c.x},${c.y})`).toBe(true);
      }
    }
  });

  it("adds and entities go on empty cells, removes on occupied ones", () => {
    for (const s of FEWSHOTS) {
      const rows = gridRows(s.request.grid);
      expect(rows).toHaveLength(s.request.size.h);
      const empty = (x: number, y: number) => rows[y][x] === EMPTY_GLYPH || rows[y][x] === PATROL_GLYPH;
      for (const c of [...s.answer.adds, ...s.answer.entities]) expect(empty(c.x, c.y), `${s.id} (${c.x},${c.y})`).toBe(true);
      for (const c of s.answer.removes) expect(empty(c.x, c.y), `${s.id} remove (${c.x},${c.y})`).toBe(false);
    }
  });

  it("acting answers pass the validator on their own level", () => {
    for (const make of SCENARIOS) {
      const s = make();
      if (!s.answer.act) continue;
      const req = scenarioRequest(s);
      const shot = FEWSHOTS.find((f) => f.id === s.id)!;
      const conv = convertModelAnswer(shot.answer, req, { filler: "llm", requestHash: "fewshot", latencyMs: 0 });
      expect(conv.dropped, s.id).toEqual([]);
      const sug = conv.suggestion!;
      const v = validateSuggestion(s.model, sug, { act: true, lastGhosts: s.lastGhosts, frontierX: s.stream.last?.x });
      expect(v.ok, `${s.id}: ${v.stage} ${v.reason ?? ""}`).toBe(true);
    }
  });
});

describe("renderFillPrompt", () => {
  it("fills every template variable and carries the brief and examples", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\{\{[A-Z_0-9]+\}\}/);
    expect(SYSTEM_PROMPT).toContain(BRIEF_STATIC.slice(0, 200));
    expect(SYSTEM_PROMPT).toContain("### Example 6:");
    expect(SYSTEM_PROMPT).toContain(knightReachTable());
    expect(SYSTEM_PROMPT).toContain("clears gaps of 11 at the same height");
  });

  it("versions the prompt by its content", () => {
    expect(PROMPT_VERSION).toMatch(/^fill\.v1-[0-9a-f]{8}$/);
    const r = renderFillPrompt(fixtureRequest(FIXTURES[0]));
    expect(r.promptVersion).toBe(PROMPT_VERSION);
    expect(r.responseSchema).toBe(responseSchema);
  });

  it("stays inside the token budgets", () => {
    expect(estimateTokens(SYSTEM_PROMPT)).toBeLessThanOrEqual(SYSTEM_BUDGET);
    for (const make of FIXTURES) {
      const r = renderFillPrompt(fixtureRequest(make));
      expect(estimateTokens(r.user), make.name).toBeLessThanOrEqual(USER_BUDGET);
    }
  });

  it("is deterministic", () => {
    const a = renderFillPrompt(fixtureRequest(FIXTURES[1]));
    const b = renderFillPrompt(fixtureRequest(FIXTURES[1]));
    expect(a).toEqual(b);
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))("renders the %s request (golden)", async (_n, make) => {
    const req = fixtureRequest(make);
    const r = renderFillPrompt(req);
    await expect(r.user + "\n").toMatchFileSnapshot(`${SNAP_DIR}/user-${make().name}.txt`);
  });

  it("renders the system prompt (golden)", async () => {
    await expect(SYSTEM_PROMPT + "\n").toMatchFileSnapshot(`${SNAP_DIR}/system.txt`);
  });

  it("states patrol, blockedAt and the previous failure with the origin to subtract", () => {
    const req = fixtureRequest(FIXTURES[3]);
    const user = renderUserMessage(req);
    expect(user).toContain("mode: patrol");
    expect(user).toContain(`blockedAt: (${req.blockedAt!.x},${req.blockedAt!.y})`);
    expect(user).toContain(`subtract the window origin (${req.origin.x},${req.origin.y})`);
    expect(user).toContain(req.previousFailure!.reason);
  });

  it("compact form omits measured numbers, brief and summary", () => {
    const req = fixtureRequest(FIXTURES[1]);
    const full = renderUserMessage(req);
    const compact = renderUserMessage(req, { compact: true });
    expect(full).toContain("measured, THIS WINDOW only");
    expect(full).toContain("Design notes for this request");
    expect(compact).not.toContain("measured, THIS WINDOW only");
    expect(compact).not.toContain("Design notes");
    expect(compact).not.toContain("rest of the level");
  });
});

describe("responseSchema", () => {
  const ALLOWED = new Set([
    "type",
    "format",
    "description",
    "nullable",
    "enum",
    "maxItems",
    "minItems",
    "properties",
    "required",
    "propertyOrdering",
    "items",
    "minimum",
    "maximum",
  ]);
  const walk = (node: Record<string, unknown>, at: string) => {
    for (const k of Object.keys(node)) expect(ALLOWED.has(k), `${at}.${k}`).toBe(true);
    if (node.properties)
      for (const [k, v] of Object.entries(node.properties as Record<string, Record<string, unknown>>)) walk(v, `${at}.${k}`);
    if (node.items) walk(node.items as Record<string, unknown>, `${at}[]`);
  };

  it("uses only the Gemini responseSchema subset", () => {
    walk(responseSchema, "$");
  });

  it("orders keys as the few-shots do and requires the contract fields", () => {
    expect(responseSchema.propertyOrdering).toEqual([...ANSWER_KEY_ORDER]);
    expect(responseSchema.required).toEqual(["act", "kind", "label", "adds", "removes", "entities", "confidence"]);
    const props = responseSchema.properties as Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[] }> } }>;
    expect(props.kind.enum).toEqual(["finish", "extend", "fix"]);
    expect(props.adds.items!.properties.tile.enum).toEqual(["grass", "dirt", "block", "grass_half", "question"]);
    expect(props.entities.items!.properties.kind.enum).toEqual(["coin", "fruit", "slime", "ultraslime", "flag", "sign"]);
  });
});

describe("parseModelAnswer", () => {
  const good: ModelAnswer = {
    act: true,
    kind: "finish",
    adds: [{ x: 3, y: 4, tile: "grass" }],
    removes: [],
    entities: [{ kind: "coin", x: 3, y: 2 }],
    confidence: 0.7,
    label: "one more step",
    levelGuess: "parkour",
  };

  it("accepts a good answer, as an object or as (fenced) JSON text", () => {
    expect(parseModelAnswer(good)).toEqual(good);
    expect(parseModelAnswer(JSON.stringify(good))).toEqual(good);
    expect(parseModelAnswer("```json\n" + JSON.stringify(good) + "\n```")).toEqual(good);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an array", [good]],
    ["non-JSON text", "Sure! Here is a staircase."],
    ["truncated JSON", JSON.stringify(good).slice(0, 40)],
    ["act missing", { ...good, act: undefined }],
    ["act as a string", { ...good, act: "true" }],
  ])("rejects garbage: %s", (_name, raw) => {
    expect(parseModelAnswer(raw)).toBeNull();
  });

  it("rejects out-of-enum tiles, entity kinds and suggestion kinds", () => {
    expect(parseModelAnswer({ ...good, adds: [{ x: 1, y: 1, tile: "lava" }] })).toBeNull();
    expect(parseModelAnswer({ ...good, entities: [{ kind: "goomba", x: 1, y: 1 }] })).toBeNull();
    expect(parseModelAnswer({ ...good, kind: "replace" })).toBeNull();
    expect(parseModelAnswerDetailed({ ...good, adds: [{ x: 1, y: 1, tile: "lava" }] }).error).toMatch(/adds\.0\.tile/);
  });

  it("normalises case and separators of enum values", () => {
    const a = parseModelAnswer({
      ...good,
      kind: "Finish",
      adds: [{ x: 1, y: 1, tile: "Grass-Half" }],
      entities: [{ kind: "UltraSlime", x: 1, y: 0 }],
    });
    expect(a?.kind).toBe("finish");
    expect(a?.adds[0].tile).toBe("grass_half");
    expect(a?.entities[0].kind).toBe("ultraslime");
  });

  it("requires kind, label and confidence when act is true; arrays default to []", () => {
    for (const k of ["kind", "label", "confidence"] as const) {
      const raw: Record<string, unknown> = { ...good };
      delete raw[k];
      expect(parseModelAnswer(raw), k).toBeNull();
    }
    const a = parseModelAnswer({ act: true, kind: "extend", label: "x", confidence: 0.4, adds: [{ x: 0, y: 0, tile: "dirt" }] });
    expect(a).toEqual({ act: true, kind: "extend", label: "x", confidence: 0.4, adds: [{ x: 0, y: 0, tile: "dirt" }], removes: [], entities: [] });
  });

  it("normalises act:false to an empty answer with confidence 0", () => {
    expect(parseModelAnswer({ act: false })).toEqual({ act: false, kind: "extend", adds: [], removes: [], entities: [], confidence: 0, label: "" });
    const a = parseModelAnswer({ act: false, kind: "fix", label: " wait ", adds: [{ x: 1, y: 1, tile: "lava" }], confidence: 7, levelGuess: "maze" });
    expect(a).toEqual({ act: false, kind: "fix", adds: [], removes: [], entities: [], confidence: 0, label: "wait", levelGuess: "maze" });
  });

  it("clamps confidence within tolerance and rejects other scales", () => {
    expect(parseModelAnswer({ ...good, confidence: 1.03 })?.confidence).toBe(1);
    expect(parseModelAnswer({ ...good, confidence: -0.02 })?.confidence).toBe(0);
    expect(parseModelAnswer({ ...good, confidence: 0 })?.confidence).toBe(0);
    expect(parseModelAnswer({ ...good, confidence: 85 })).toBeNull();
    expect(parseModelAnswer({ ...good, confidence: -1 })).toBeNull();
    expect(parseModelAnswer({ ...good, confidence: "0.8" })).toBeNull();
    expect(parseModelAnswer({ ...good, confidence: Number.NaN })).toBeNull();
  });

  it("requires integer coordinates in range", () => {
    expect(parseModelAnswer({ ...good, adds: [{ x: 3.0, y: 4, tile: "grass" }] })).not.toBeNull();
    expect(parseModelAnswer({ ...good, adds: [{ x: 3.5, y: 4, tile: "grass" }] })).toBeNull();
    expect(parseModelAnswer({ ...good, adds: [{ x: "3", y: 4, tile: "grass" }] })).toBeNull();
    expect(parseModelAnswer({ ...good, removes: [{ x: 5000, y: 0 }] })).toBeNull();
    // Negative / outside-window cells pass parsing; fill/answer.ts drops them later.
    expect(parseModelAnswer({ ...good, adds: [{ x: -1, y: 4, tile: "grass" }] })).not.toBeNull();
  });

  it("rejects absurdly large answers", () => {
    const adds = Array.from({ length: 201 }, (_, i) => ({ x: i % 24, y: Math.floor(i / 24), tile: "grass" }));
    expect(parseModelAnswer({ ...good, adds })).toBeNull();
  });

  it("ignores unknown keys and drops a non-string levelGuess", () => {
    const a = parseModelAnswer({ ...good, reasoning: "because", levelGuess: 3 });
    expect(a).not.toBeNull();
    expect(a).not.toHaveProperty("reasoning");
    expect(a).not.toHaveProperty("levelGuess");
    expect(parseModelAnswer({ ...good, levelGuess: "  " + "x".repeat(100) })?.levelGuess).toHaveLength(60);
  });

  it("answerJson emits keys in schema order", () => {
    expect(Object.keys(JSON.parse(answerJson(good)))).toEqual([...ANSWER_KEY_ORDER]);
  });
});
