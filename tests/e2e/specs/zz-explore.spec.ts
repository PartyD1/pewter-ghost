import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { Editor } from "../support/editor";

const scenes: Record<string, [number, number][][]> = {
  gap: [[26, 27, 28, 29, 30, 31].map((x) => [x, 15])],
  wall: [[6, 7, 8, 9, 10, 11, 12, 13, 14].map((y) => [14, y]), [15, 16, 17, 18, 19, 20].map((x) => [x, 15])],
};
for (const [name, strokes] of Object.entries(scenes)) {
  test("patrol " + name, async ({ page }) => {
    const ed = await Editor.open(page, { proxy: { condition: "llm" } });
    await ed.pick("grass");
    for (const s of strokes) await ed.drag(s);
    await page.waitForTimeout(6000);
    const calls = ed.proxy!.fills.filter((c) => c.body.request.mode === "patrol");
    writeFileSync(`/tmp/claude-0/-home-user-pewter-platfomer/a4742603-f271-536f-ac31-6454ea7e2f31/scratchpad/patrol-${name}.json`, JSON.stringify(calls, null, 1));
    console.log(name, calls.length, JSON.stringify((await ed.events()).filter((e) => e.type === "patrol" || (e.type === "fill.call" && e.mode === "patrol"))));
    if (calls[0]) console.log(JSON.stringify({ o: calls[0].body.request.origin, b: calls[0].body.request.blockedAt }), "\n" + calls[0].body.request.grid);
  });
}
