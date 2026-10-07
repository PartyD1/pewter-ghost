import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { Editor } from "../support/editor";

const g = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y, tile: "grass" }));
const scenes: Record<string, { strokes: [number, number][][]; adds: [number, number][]; removes: [number, number][] }> = {
  gap: { strokes: [[26, 27, 28, 29, 30, 31].map((x) => [x, 15])], adds: [[15, 15], [16, 15], [17, 15], [20, 15], [21, 15], [22, 15]], removes: [] },
  ledge: { strokes: [[16, 17, 18, 19, 20, 21, 22].map((x) => [x, 8])], adds: [[16, 10], [17, 10], [18, 10]], removes: [[16, 8], [17, 8], [18, 8]] },
};
for (const [name, sc] of Object.entries(scenes)) {
  test("patrol " + name, async ({ page }) => {
    const ed = await Editor.open(page, {
      proxy: {
        condition: "llm",
        fill: (b) => {
          if (b.request.mode !== "patrol") return null;
          const o = b.request.origin;
          const mv = (p: [number, number][]) => p.map(([x, y]) => [x - o.x, y - o.y] as [number, number]);
          return { response: { answer: { act: true, kind: "fix", adds: g(mv(sc.adds)), removes: mv(sc.removes).map(([x, y]) => ({ x, y })), entities: [], confidence: 0.8, label: "fix " + name }, latencyMs: 300, model: "m", promptVersion: "p", requestHash: "" } };
        },
      },
    });
    await ed.pick("grass");
    for (const s of sc.strokes) await ed.drag(s);
    await page.waitForTimeout(7000);
    const calls = ed.proxy!.fills.filter((c) => c.body.request.mode === "patrol");
    writeFileSync(`/tmp/claude-0/-home-user-pewter-platfomer/a4742603-f271-536f-ac31-6454ea7e2f31/scratchpad/patrol-${name}.json`, JSON.stringify(calls, null, 1));
    console.log(name, calls.length, JSON.stringify((await ed.events()).filter((e) => e.type === "patrol" || e.type === "ghost.show" || (e.type === "fill.call" && e.mode === "patrol"))));
    console.log(JSON.stringify(await ed.ghost()));
    if (calls[0]) console.log(JSON.stringify({ o: calls[0].body.request.origin, b: calls[0].body.request.blockedAt }), "\n" + calls[0].body.request.grid);
  });
}
