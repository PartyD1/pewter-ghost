/**
 * The replay harness itself (no browser): every recorded fixture is a valid
 * ProxyFillResponse whose answers pass the editor's own strict parser (loaded
 * from the dev server: the app's modules need Vite's JSON and alias handling),
 * and rebasing keeps level cells fixed whatever window the live request uses.
 */
import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import type { FillRequest, Recording } from "../../../apps/editor/src/contracts";
import { FIXTURE_DIR, fixtureFromRecording, loadFixture, recentCells, replayResponse, requestHasPlaced } from "../support/proxyMock";

const names = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));

test("there are recorded fixtures", () => {
  expect(names.length).toBeGreaterThanOrEqual(5);
});

test("every fixture answer passes the editor's strict parser", async ({ page }) => {
  await page.goto("./src/contracts.ts");
  const answers = names.map((n) => loadFixture(n).response.answer);
  const parsed = await page.evaluate(async (answers) => {
    const { parseModelAnswer } = await import("/src/fill/prompt.ts" as string);
    return answers.map((a: unknown) => parseModelAnswer(a));
  }, answers);
  parsed.forEach((p, i) => {
    expect(p, `${names[i]} parses`).not.toBeNull();
    expect(p).toEqual(answers[i]);
  });
});

for (const name of names) {
  test(`fixture ${name} is a valid recorded answer`, () => {
    const f = loadFixture(name);
    expect(typeof f.note).toBe("string");
    expect(Number.isInteger(f.recordedOrigin.x) && Number.isInteger(f.recordedOrigin.y)).toBe(true);
    const r = f.response;
    expect(typeof r.latencyMs).toBe("number");
    expect(typeof r.model).toBe("string");
    expect(typeof r.promptVersion).toBe("string");
    expect(r.answer).not.toBeNull();
    // Window-relative coordinates inside the 24 x 12 window it was recorded in.
    for (const c of [...r.answer!.adds, ...r.answer!.removes, ...r.answer!.entities]) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(24);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThan(12);
    }
  });
}

test("replay rebases answers onto the live window and drops the recorded hash", () => {
  const f = loadFixture("patrol-lower-ledge-fix");
  const level = (a: { x: number; y: number }, o: { x: number; y: number }) => ({ x: a.x + o.x, y: a.y + o.y });
  const recorded = f.response.answer!;
  for (const origin of [f.recordedOrigin, { x: 0, y: 8 }, { x: 7, y: 5 }]) {
    const out = replayResponse(f, { origin });
    expect(out.requestHash).toBeUndefined();
    expect(out.answer!.adds.map((a) => level(a, origin))).toEqual(recorded.adds.map((a) => level(a, f.recordedOrigin)));
    expect(out.answer!.removes.map((a) => level(a, origin))).toEqual(recorded.removes.map((a) => level(a, f.recordedOrigin)));
    expect(out.answer!.label).toBe(recorded.label);
  }
  // The fixture on disk is untouched.
  expect(loadFixture("patrol-lower-ledge-fix").response.answer).toEqual(recorded);
});

test("a proxy recording becomes a fixture", () => {
  const f = loadFixture("finish-staircase");
  const request = { origin: { x: 2, y: 6 }, recent: [] } as unknown as FillRequest;
  const rec: Recording = {
    t: "2026-10-07T12:00:00.000Z",
    sessionId: "s",
    requestHash: "abc",
    request,
    answer: f.response.answer,
    latencyMs: 2100,
    model: "gemini-3.7-flash",
    promptVersion: "fill.v1-f9d1aef8",
  };
  const made = fixtureFromRecording(rec, "from a recording");
  expect(made.recordedOrigin).toEqual({ x: 2, y: 6 });
  expect(made.response).toEqual({ answer: f.response.answer, latencyMs: 2100, model: "gemini-3.7-flash", promptVersion: "fill.v1-f9d1aef8", requestHash: "abc" });
});

test("recent placements are read back in level coordinates", () => {
  const req = {
    origin: { x: 2, y: 6 },
    recent: [
      { dt: 0, x: 12, y: 6, tile: "grass", tool: "paint" },
      { dt: 300, x: 11, y: 7, tile: "grass", tool: "paint" },
      { dt: 300, x: 10, y: 8, tile: "grass", tool: "paint" },
      { dt: 300, x: 3, y: 3, tile: "empty", tool: "erase" },
    ],
  } as Pick<FillRequest, "origin" | "recent">;
  expect(recentCells(req)).toEqual([
    { x: 14, y: 12 },
    { x: 13, y: 13 },
    { x: 12, y: 14 },
  ]);
  expect(requestHasPlaced(req, [[12, 14], [13, 13], [14, 12]])).toBe(true);
  expect(requestHasPlaced(req, [[12, 14], [15, 11]])).toBe(false);
});
