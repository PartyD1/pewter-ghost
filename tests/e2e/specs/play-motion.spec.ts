/**
 * Play-mode motion on fast screens. Arcade steps at a fixed 60 Hz while the
 * camera and the drawing run at the screen's rate; the knight must still move
 * steadily on screen, with physics unchanged.
 *
 * The game's own loop is stopped and stepped by a virtual clock, so a headless
 * browser (whose real frame rate is 60) can act as a 120 or 144 Hz screen.
 */
import { expect, test, type Page } from "@playwright/test";
import { Editor } from "../support/editor";

interface RunResult {
  /** Knight's drawn screen x, one per frame, once at top speed and the camera is scrolling. */
  screenX: number[];
  /** The knight's real (physics) x when the run ended. */
  endX: number;
  /** Largest gap between the sprite's real x and its body, checked between frames. */
  maxBodyDrift: number;
}

/** Hold right for `seconds` of virtual time at `hz`. */
async function runRight(page: Page, hz: number, seconds: number, jitterMs = 0): Promise<RunResult> {
  return page.evaluate(
    ({ hz, seconds, jitterMs }) => {
      const { game, scene } = (window as any).__pewter;
      game.loop.stop();
      scene.startPlay();
      const play = scene.play;
      const k = play.knightSprite;
      const cam = scene.cameras.main;
      const screenX: number[] = [];
      // Fires inside camera.preRender, after the follow and its snapping, so this is what gets drawn.
      const record = () => {
        // Top run speed is 217.6 px/s (playerPhysics.ts).
        if (Math.abs(k.body.velocity.x) < 210 || cam.scrollX <= 0) return;
        const origin = cam.width * cam.originX;
        screenX.push(Math.round(cam.zoomX * (k.x - cam.scrollX - origin) + origin));
      };
      cam.on("followupdate", record);
      let seed = 12345;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      let t = performance.now();
      let maxBodyDrift = 0;
      let bodyGap: number | null = null;
      const frames = Math.round(hz * seconds);
      for (let i = 0; i < frames; i++) {
        play.controller.wasd.D.isDown = true;
        t += 1000 / hz + (rnd() - 0.5) * 2 * jitterMs;
        game.loop.step(t);
        // Arcade sets the body's position on its first update, so measure from there.
        bodyGap ??= k.x - k.body.x;
        maxBodyDrift = Math.max(maxBodyDrift, Math.abs(k.x - k.body.x - bodyGap));
      }
      const endX = k.x;
      cam.off("followupdate", record);
      scene.stopPlay();
      return { screenX, endX, maxBodyDrift };
    },
    { hz, seconds, jitterMs },
  );
}

function steps(xs: number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]!);
}

for (const [hz, jitterMs] of [
  [120, 0],
  [120, 0.5],
  [144, 0.5],
] as const) {
  test(`the knight never jumps back on screen at ${hz} Hz (timing noise ${jitterMs} ms)`, async ({ page }) => {
    await Editor.open(page, { proxy: null });
    const run = await runRight(page, hz, 4, jitterMs);
    expect(run.screenX.length).toBeGreaterThan(hz);
    const moves = steps(run.screenX);
    // One pixel is rounding; more is a visible judder.
    expect(Math.min(...moves)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...moves)).toBeLessThanOrEqual(6);
  });
}

test("smoothing is drawing only: physics covers the same ground at any screen rate", async ({ page }) => {
  await Editor.open(page, { proxy: null });
  const at60 = await runRight(page, 60, 3);
  const at120 = await runRight(page, 120, 3);
  // Within two 60 Hz steps at top speed (the controller still reads input per frame).
  expect(Math.abs(at60.endX - at120.endX)).toBeLessThan(9);
  // Between frames the sprite holds its true position, never the drawn one.
  expect(at120.maxBodyDrift).toBeLessThan(0.001);
});

test("a walking enemy is drawn moving on every frame at 120 Hz, not every other frame", async ({ page }) => {
  await Editor.open(page, { proxy: null });
  const r = await page.evaluate(() => {
    const { game, scene, model } = (window as any).__pewter;
    const s = model.snapshot();
    // On the starter's floor, near the start so nothing else interferes.
    const floorY = (() => {
      for (let y = 0; y < s.h; y++) if (s.cells[y * s.w + 30]) return y;
      return s.h - 1;
    })();
    s.entities.push({ id: "e2e-slime", kind: "slime", x: 30, y: floorY - 1, patrol: [24, 36] });
    model.load(s);
    game.loop.stop();
    scene.startPlay();
    const enemy = scene.play.enemies.find((e: { entityId: string }) => e.entityId === "e2e-slime");
    const cam = scene.cameras.main;
    const drawn: number[] = [];
    const record = () => drawn.push(enemy.x);
    cam.on("followupdate", record);
    let t = performance.now();
    for (let i = 0; i < 480; i++) {
      t += 1000 / 120;
      game.loop.step(t);
    }
    cam.off("followupdate", record);
    const endedAlive = enemy.alive;
    scene.stopPlay();
    return { drawn, endedAlive };
  });
  expect(r.endedAlive).toBe(true);
  const moves = steps(r.drawn).map(Math.abs);
  const moving = moves.filter((m) => m > 0.001).length;
  // It has to be walking at all, or this proves nothing.
  expect(Math.max(...moves)).toBeGreaterThan(0.05);
  // Unsmoothed, only half the frames move (the physics steps).
  expect(moving / moves.length).toBeGreaterThan(0.8);
});

test("respawning jumps straight to the spawn, with no slide across the level", async ({ page }) => {
  await Editor.open(page, { proxy: null });
  const r = await page.evaluate(() => {
    const { game, scene } = (window as any).__pewter;
    game.loop.stop();
    scene.startPlay();
    const play = scene.play;
    const k = play.knightSprite;
    const cam = scene.cameras.main;
    let drawn = 0;
    const record = () => (drawn = k.x);
    cam.on("followupdate", record);
    let t = performance.now();
    const frame = () => {
      t += 1000 / 120;
      game.loop.step(t);
    };
    for (let i = 0; i < 240; i++) {
      play.controller.wasd.D.isDown = true;
      frame();
    }
    const before = k.x;
    play.respawn();
    frame();
    const out = { before, drawn, real: k.x };
    cam.off("followupdate", record);
    scene.stopPlay();
    return out;
  });
  expect(r.before - r.real).toBeGreaterThan(100);
  expect(Math.abs(r.drawn - r.real)).toBeLessThan(2);
});
