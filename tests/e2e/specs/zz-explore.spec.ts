import { test } from "@playwright/test";
import { Editor } from "../support/editor";

const g = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y, tile: "grass" }));
const cands: Record<string, any> = {
  finish: { kind: "finish", adds: g([[13, 5], [14, 4], [15, 3], [16, 3], [17, 3], [18, 3], [19, 3]]) },
  highfar: { kind: "finish", adds: g([[19, 0], [20, 0], [21, 0], [22, 0], [23, 0]]) },
  farflat: { kind: "finish", adds: g([[23, 6]]) },
  flat10: { kind: "finish", adds: g([[23, 6], [22, 6]]) },
};
for (const [name, c] of Object.entries(cands)) {
  test("explore " + name, async ({ page }) => {
    const ed = await Editor.open(page, {
      proxy: {
        condition: "llm",
        fill: () => ({ response: { answer: { act: true, removes: [], entities: [], confidence: 0.9, label: name, ...c }, latencyMs: 1, model: "m", promptVersion: "p", requestHash: "" } }),
      },
    });
    await ed.pick("grass");
    for (const [x, y] of [[12, 14], [13, 13], [14, 12]] as [number, number][]) {
      await ed.clickTile(x, y);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(2000);
    const ev = (await ed.events()).filter((e) => e.type === "fill.call" || e.type === "ghost.show");
    console.log(name, JSON.stringify(ev.slice(-4)), JSON.stringify(await ed.ghost()));
  });
}
