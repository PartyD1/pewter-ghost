import { test } from "@playwright/test";
import { Editor } from "../support/editor";

const g = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y, tile: "grass" }));
const cands: Record<string, any> = {
  wallledge: { kind: "finish", adds: g([[13,0],[13,1],[13,2],[13,3],[13,4],[13,5],[13,6],[13,7],[13,8],[14,3],[15,3],[16,3],[17,3]]) },
  box: { kind: "finish", adds: g([[13,0],[13,1],[13,2],[13,3],[13,4],[13,5],[13,6],[13,7],[13,8],[14,3],[15,3],[16,3],[17,3],[10,4],[11,4],[12,4]]) },
  lowceil: { kind: "finish", adds: g([[10,5],[11,5],[12,5],[13,5],[14,5],[15,5],[16,5],[17,5],[18,5],[19,5],[13,6],[14,6],[15,6],[16,6],[17,6],[18,6],[19,6]]) },
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
    console.log(name, JSON.stringify(await page.evaluate(() => { const l = (window as any).__pewter.app.loop.last; return l && l.verify && l.verify.verdicts.map((v: any) => ({ok: v.ok, stage: v.stage, path: v.path, section: v.section})); })));
  });
}
