/**
 * Roulette block: in Play a question block cycles coin -> heart -> slime and
 * pays out whatever it shows when the knight hits it from below, once per
 * attempt. Driven by a virtual clock (the game's own loop is stopped), so the
 * face at the moment of the hit is exact.
 */
import { expect, test, type Page } from "@playwright/test";
import { Editor } from "../support/editor";

type Face = "coin" | "fruit" | "slime";

interface HitResult {
  face: Face;
  bumps: Record<Face, number>;
  coins: number;
  health: number;
  enemies: number;
  /** The block still solid (the knight cannot jump through it). */
  solidAfter: boolean;
  /** A second hit on the same block paid nothing. */
  secondHitPaid: boolean;
}

/**
 * Put question blocks on row 11 at `xs`, start Play and, for each block in
 * turn, stand under it, wait until it shows `want`, then jump into it.
 */
async function hitBlocks(page: Page, xs: number[], want: Face[], startHealth = 3): Promise<{ hits: HitResult[]; end: unknown }> {
  return page.evaluate(
    ({ xs, want, startHealth }) => {
      const { model, scene, game } = (window as any).__pewter;
      for (const x of xs) model.paintTile(x, 11, 7);
      game.loop.stop();
      scene.startPlay();
      const play = scene.play;
      const k = play.knightSprite;
      let t = performance.now();
      const step = (n: number, jump = false) => {
        for (let i = 0; i < n; i++) {
          play.controller.wasd.W.isDown = jump;
          t += 1000 / 60;
          game.loop.step(t);
        }
      };
      step(10);
      play.health = startHealth;
      const hits: unknown[] = [];
      xs.forEach((x, i) => {
        k.body.reset(x * 16 + 8, 14 * 16 + 8);
        step(3);
        const face = () => play.blockFaces.find((f: { x: number }) => f.x === x).showing;
        for (let n = 0; n < 400 && face() !== want[i]; n++) step(1);
        const before = { ...play.bumps };
        step(14, true);
        const shown = (["coin", "fruit", "slime"] as const).find((f) => play.bumps[f] > before[f]);
        step(40);
        const solidAfter = k.body.top >= 12 * 16 - 1;
        const total = () => play.bumps.coin + play.bumps.fruit + play.bumps.slime;
        const n0 = total();
        step(14, true);
        step(40);
        hits.push({
          face: shown,
          bumps: play.bumps,
          coins: play.stats.coins,
          health: play.stats.health,
          enemies: play.enemies.length,
          solidAfter,
          secondHitPaid: total() > n0,
        });
      });
      const end = scene.stopPlay();
      return { hits, end };
    },
    { xs, want, startHealth },
  ) as Promise<{ hits: HitResult[]; end: unknown }>;
}

test("a question block pays out the face it shows when hit from below, once", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  const { hits, end } = await hitBlocks(page, [4, 10, 16], ["coin", "fruit", "slime"]);

  expect(hits[0]).toMatchObject({ face: "coin", coins: 1, health: 3, enemies: 0, solidAfter: true, secondHitPaid: false });
  expect(hits[1]).toMatchObject({ face: "fruit", coins: 1, health: 4, enemies: 0, solidAfter: true, secondHitPaid: false });
  // The slime hops out of the top of the block.
  expect(hits[2]).toMatchObject({ face: "slime", enemies: 1, solidAfter: true, secondHitPaid: false });
  expect(end).toMatchObject({ bumps: { coin: 1, fruit: 1, slime: 1 } });

  const events = await ed.events();
  expect(events.filter((e: { type: string }) => e.type === "play.end").at(-1)).toMatchObject({ bumps: { coin: 1, fruit: 1, slime: 1 } });
  ed.expectNoErrors();
});

test("a slime with nowhere to go bites instead", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  await page.evaluate(() => (window as any).__pewter.model.paintTile(6, 10, 1)); // cover the top
  const { hits } = await hitBlocks(page, [6], ["slime"], 4);
  expect(hits[0]).toMatchObject({ face: "slime", enemies: 0, health: 3 });
  ed.expectNoErrors();
});

test("blocks pay out again after the knight respawns", async ({ page }) => {
  const ed = await Editor.open(page, { proxy: null, params: { filler: "none" } });
  const r = await page.evaluate(() => {
    const { model, scene, game } = (window as any).__pewter;
    model.paintTile(4, 11, 7);
    game.loop.stop();
    scene.startPlay();
    const play = scene.play;
    const k = play.knightSprite;
    let t = performance.now();
    const step = (n: number, jump = false) => {
      for (let i = 0; i < n; i++) {
        play.controller.wasd.W.isDown = jump;
        t += 1000 / 60;
        game.loop.step(t);
      }
    };
    const hit = () => {
      k.body.reset(4 * 16 + 8, 14 * 16 + 8);
      step(3);
      step(14, true);
      step(40);
    };
    step(10);
    hit();
    const first = play.bumps.coin + play.bumps.fruit + play.bumps.slime;
    play.health = 0; // die; respawn after the death pause
    step(90);
    hit();
    const second = play.bumps.coin + play.bumps.fruit + play.bumps.slime;
    scene.stopPlay();
    return { first, second, deaths: play.stats.deaths };
  });
  expect(r).toEqual({ first: 1, second: 2, deaths: 1 });
  ed.expectNoErrors();
});
