/**
 * The editor's real art for the replay viewer: the Brackeys strip, the Kenney
 * sheet and the default map's backdrop, loaded from the same files the editor
 * loads (public/phaserAssets) and combined by the same code (tileComposite.ts),
 * so the replay looks like the editor, not a sketch of it.
 *
 * If any file fails to load the viewer keeps drawing with flat colours
 * (stage.ts); nothing here throws into the page.
 */
import { FRAME_COUNT, TILE_PX } from "../editor/constants";
import { paintComposite, paintGhost, type MapTileset } from "../editor/tileComposite";

export interface Backdrop {
  w: number;
  h: number;
  /** Tiled gids, row-major. */
  data: number[];
  tilesets: MapTileset[];
}

export interface Sprites {
  /** The 16 composite frames side by side (frame index == TileId for terrain). */
  composite: HTMLCanvasElement;
  /** The same frames in light grey, for ghost suggestions. */
  ghost: HTMLCanvasElement;
  /** The Brackeys strip (the backdrop's frames index into it). */
  brackeys: HTMLImageElement;
  /** pewterPlatformerTilesetBackgroundExtras.png (2 frames). */
  extras: HTMLImageElement;
  backdrop: Backdrop | null;
}

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });

function strip(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = FRAME_COUNT * TILE_PX;
  c.height = TILE_PX;
  return c;
}

/** Where the editor's art is served from, relative to the page (the replay page lives one folder down). */
export const ASSET_BASE = "../phaserAssets/";

let pending: Promise<Sprites> | null = null;
let loaded: Sprites | null = null;

/** Load once; later calls share the result. Rejects if an image is missing (the caller falls back to flat colours). */
export function loadSprites(base: string = ASSET_BASE): Promise<Sprites> {
  pending ??= (async () => {
    const at = (name: string) => new URL(base + name, document.baseURI).href;
    const [brackeys, kenney, extras] = await Promise.all([
      loadImage(at("pewterPlatformerTilesetExtended.png")),
      loadImage(at("tilemap_packed.png")),
      loadImage(at("pewterPlatformerTilesetBackgroundExtras.png")),
    ]);
    const composite = strip();
    paintComposite(composite.getContext("2d")!, brackeys, kenney);
    const ghost = strip();
    paintGhost(ghost.getContext("2d", { willReadFrequently: true })!, composite);
    let backdrop: Backdrop | null = null;
    try {
      const map = (await (await fetch(at("pewterPlatformerDefaultMap.json"))).json()) as {
        tilesets: MapTileset[];
        layers: { name: string; width: number; height: number; data: number[] }[];
      };
      const bg = map.layers.find((l) => l.name === "Background_Layer");
      if (bg) backdrop = { w: bg.width, h: bg.height, data: bg.data, tilesets: map.tilesets };
    } catch {
      /* no backdrop: the sky is a flat colour */
    }
    loaded = { composite, ghost, brackeys, extras, backdrop };
    return loaded;
  })();
  pending.catch(() => {
    pending = null; // a later call may try again (a flaky network)
  });
  return pending;
}

/** The sprites if they have finished loading, else null. */
export const spritesNow = (): Sprites | null => loaded;
