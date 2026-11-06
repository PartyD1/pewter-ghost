import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FRAME, FRAME_COUNT, FRAME_SOURCES, KENNEY_PX, TILE_PX } from "./constants";
import { backdropSource, GHOST_GREY, paintComposite, paintGhost } from "./tileComposite";

/** A 2D context that records what is drawn and keeps a pixel buffer for the grey pass. */
function stubCtx(w: number, h: number, fill = [200, 100, 50, 255]) {
  const draws: { src: unknown; args: number[] }[] = [];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  const calls: string[] = [];
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: "",
    drawImage(src: unknown, ...args: number[]) {
      draws.push({ src, args });
    },
    fillRect: () => calls.push("fillRect"),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => calls.push("fill"),
    getImageData: (x: number, _y: number, cw: number, ch: number) => {
      const out = new Uint8ClampedArray(cw * ch * 4);
      for (let row = 0; row < ch; row++) for (let col = 0; col < cw; col++) out.set(data.subarray(((row * w) + x + col) * 4, ((row * w) + x + col) * 4 + 4), (row * cw + col) * 4);
      return { data: out, width: cw, height: ch };
    },
    putImageData: (img: { data: Uint8ClampedArray }, x: number) => {
      const cw = img.data.length / 4 / h;
      for (let row = 0; row < h; row++) for (let col = 0; col < cw; col++) data.set(img.data.subarray((row * cw + col) * 4, (row * cw + col) * 4 + 4), ((row * w) + x + col) * 4);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws, calls, data };
}

describe("paintComposite", () => {
  it("copies each frame from the right source rectangle to its own slot", () => {
    const brackeys = { name: "brackeys" };
    const kenney = { name: "kenney" };
    const { ctx, draws, calls } = stubCtx(FRAME_COUNT * TILE_PX, TILE_PX);
    paintComposite(ctx, brackeys as unknown as CanvasImageSource, kenney as unknown as CanvasImageSource);
    expect(ctx.imageSmoothingEnabled).toBe(false); // pixel art stays crisp

    const byDest = new Map(draws.map((d) => [d.args[4], d]));
    // Grass: Brackeys frame 5 -> slot 6 (frame index == TileId).
    expect(byDest.get(FRAME.GRASS * TILE_PX)).toMatchObject({ src: brackeys, args: [5 * TILE_PX, 0, TILE_PX, TILE_PX, FRAME.GRASS * TILE_PX, 0, TILE_PX, TILE_PX] });
    // Block: the Kenney brick at [6, 0], 18 px resampled to 16.
    expect(byDest.get(FRAME.BLOCK * TILE_PX)).toMatchObject({ src: kenney, args: [6 * KENNEY_PX, 0, KENNEY_PX, KENNEY_PX, FRAME.BLOCK * TILE_PX, 0, TILE_PX, TILE_PX] });
    // Every sprite-sourced frame is drawn once; the start pennant is drawn procedurally.
    const sprites = Object.values(FRAME_SOURCES).filter((s) => !("draw" in s)).length;
    expect(draws).toHaveLength(sprites);
    expect(calls).toContain("fill");
  });
});

describe("paintGhost", () => {
  it("turns every pixel grey inside the ghost range, brighter pixels lighter", () => {
    const w = FRAME_COUNT * TILE_PX;
    const { ctx, data } = stubCtx(w, TILE_PX, [0, 0, 0, 255]);
    // The "source" drawImage is a stub, so seed the buffer as if the composite had been drawn:
    data.set([255, 255, 255, 255], 0);
    data.set([0, 0, 0, 255], 4);
    paintGhost(ctx, {} as CanvasImageSource);
    expect([data[0], data[1], data[2]]).toEqual([GHOST_GREY.hi, GHOST_GREY.hi, GHOST_GREY.hi]);
    expect([data[4], data[5], data[6]]).toEqual([GHOST_GREY.lo, GHOST_GREY.lo, GHOST_GREY.lo]);
    expect(data[3]).toBe(255); // alpha is untouched
  });
});

describe("backdropSource", () => {
  const map = JSON.parse(readFileSync(new URL("../../assets/pewterPlatformerDefaultMap.json", import.meta.url), "utf8")) as {
    tilesets: { firstgid: number; name: string }[];
    layers: { name: string; data: number[] }[];
  };

  it("maps gids to the strip or the extras sheet by firstgid", () => {
    expect(backdropSource(1, map.tilesets)).toEqual({ sheet: "brackeys", index: 0 });
    expect(backdropSource(15, map.tilesets)).toEqual({ sheet: "brackeys", index: 14 });
    expect(backdropSource(16, map.tilesets)).toEqual({ sheet: "extras", index: 0 });
    expect(backdropSource(17, map.tilesets)).toEqual({ sheet: "extras", index: 1 });
    expect(backdropSource(0, map.tilesets)).toBeNull();
    expect(backdropSource(5, [{ firstgid: 1, name: "Something else" }])).toBeNull();
  });

  it("covers every gid the real backdrop layer uses, inside the sheets' frames", () => {
    const bg = map.layers.find((l) => l.name === "Background_Layer")!;
    const used = new Set(bg.data);
    expect(used.size).toBeGreaterThan(3);
    for (const gid of used) {
      const s = backdropSource(gid, map.tilesets);
      expect(s, `gid ${gid}`).not.toBeNull();
      expect(s!.index).toBeGreaterThanOrEqual(0);
      expect(s!.index).toBeLessThan(s!.sheet === "brackeys" ? 15 : 2); // 240 px strip = 15 frames, extras = 2
    }
  });
});
