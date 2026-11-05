import { describe, expect, it } from "vitest";
import { TILE, type TileId } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { SelectionController, rectFromCorners } from "./selection";

const GRASS = TILE.GRASS as TileId;
const DIRT = TILE.DIRT as TileId;

function setup() {
  const model = new LevelModel({ w: 30, h: 20 });
  model.paint([
    { x: 2, y: 5, tile: GRASS },
    { x: 3, y: 5, tile: GRASS },
    { x: 2, y: 6, tile: DIRT },
  ]);
  model.placeEntity("slime", 3, 4);
  return { model, sel: new SelectionController(model) };
}

const select = (sel: SelectionController, a: { x: number; y: number }, b: { x: number; y: number }) => {
  sel.press(a);
  sel.dragTo(b);
  return sel.release(b);
};

describe("SelectionController", () => {
  it("builds a box from two corners in any order", () => {
    expect(rectFromCorners({ x: 5, y: 7 }, { x: 2, y: 3 })).toEqual({ x: 2, y: 3, w: 4, h: 5 });
  });

  it("drags out a selection box, and a plain click selects one cell", () => {
    const { sel } = setup();
    expect(select(sel, { x: 1, y: 4 }, { x: 4, y: 6 })).toBe("selected");
    expect(sel.rect).toEqual({ x: 1, y: 4, w: 4, h: 3 });
    expect(select(sel, { x: 9, y: 9 }, { x: 9, y: 9 })).toBe("clicked");
    expect(sel.rect).toEqual({ x: 9, y: 9, w: 1, h: 1 });
  });

  it("deletes tiles and entities in the box as one undo step", () => {
    const { model, sel } = setup();
    select(sel, { x: 1, y: 4 }, { x: 4, y: 6 });
    sel.deleteSelection();
    expect(model.tileAt(2, 5)).toBe(0);
    expect(model.tileAt(2, 6)).toBe(0);
    expect(model.entitiesAt(3, 4)).toHaveLength(0);
    model.undo();
    expect(model.tileAt(2, 5)).toBe(GRASS);
    expect(model.tileAt(2, 6)).toBe(DIRT);
    expect(model.entitiesAt(3, 4)).toHaveLength(1);
  });

  it("moves a block by dragging inside it, keeping its shape, as one undo step", () => {
    const { model, sel } = setup();
    select(sel, { x: 1, y: 4 }, { x: 4, y: 6 });
    sel.press({ x: 2, y: 5 });
    sel.dragTo({ x: 12, y: 8 });
    expect(sel.previewRect()).toEqual({ x: 11, y: 7, w: 4, h: 3 });
    expect(sel.release({ x: 12, y: 8 })).toBe("moved");
    expect(model.tileAt(2, 5)).toBe(0);
    expect(model.tileAt(12, 8)).toBe(GRASS);
    expect(model.tileAt(13, 8)).toBe(GRASS);
    expect(model.tileAt(12, 9)).toBe(DIRT);
    expect(model.entitiesAt(13, 7)[0]?.kind).toBe("slime");
    expect(sel.rect).toEqual({ x: 11, y: 7, w: 4, h: 3 });
    model.undo();
    expect(model.tileAt(12, 8)).toBe(0);
    expect(model.tileAt(2, 5)).toBe(GRASS);
    expect(model.entitiesAt(3, 4)).toHaveLength(1);
  });

  it("copies instead of moving when asked, and empty cells never wipe what is underneath", () => {
    const { model, sel } = setup();
    model.paint([{ x: 11, y: 6, tile: DIRT }]); // lands under the (empty) top-left cell of the copied box
    select(sel, { x: 1, y: 4 }, { x: 4, y: 6 });
    sel.press({ x: 1, y: 4 });
    sel.dragTo({ x: 11, y: 6 });
    expect(sel.release({ x: 11, y: 6 }, true)).toBe("copied");
    expect(model.tileAt(2, 5)).toBe(GRASS); // original stays
    expect(model.tileAt(13, 7)).toBe(GRASS);
    expect(model.tileAt(11, 6)).toBe(DIRT); // transparent empty cell
  });

  it("keeps a moved block inside the level", () => {
    const { model, sel } = setup();
    select(sel, { x: 2, y: 5 }, { x: 3, y: 5 });
    sel.press({ x: 2, y: 5 });
    sel.dragTo({ x: -50, y: 99 });
    expect(sel.previewRect()).toEqual({ x: 0, y: 19, w: 2, h: 1 });
    sel.release({ x: -50, y: 99 });
    expect(model.tileAt(0, 19)).toBe(GRASS);
    expect(model.tileAt(1, 19)).toBe(GRASS);
  });

  it("copy then paste puts a second copy at the target and selects it", () => {
    const { model, sel } = setup();
    select(sel, { x: 1, y: 4 }, { x: 4, y: 6 });
    expect(sel.copy()).toBe(true);
    expect(sel.paste({ x: 20, y: 10 })).toBe(true);
    expect(model.tileAt(21, 11)).toBe(GRASS);
    expect(model.tileAt(2, 5)).toBe(GRASS);
    expect(sel.rect).toEqual({ x: 20, y: 10, w: 4, h: 3 });
    model.undo();
    expect(model.tileAt(21, 11)).toBe(0);
  });

  it("cut removes and keeps a copy; paste with nothing copied does nothing", () => {
    const { model, sel } = setup();
    expect(sel.paste({ x: 0, y: 0 })).toBe(false);
    select(sel, { x: 1, y: 4 }, { x: 4, y: 6 });
    sel.cut();
    expect(model.tileAt(2, 5)).toBe(0);
    sel.paste({ x: 1, y: 4 });
    expect(model.tileAt(2, 5)).toBe(GRASS);
  });

  it("never copies the goal flag, but a move carries it", () => {
    const { model, sel } = setup();
    model.placeEntity("flag", 3, 6);
    select(sel, { x: 1, y: 4 }, { x: 4, y: 6 });
    sel.copy();
    sel.paste({ x: 20, y: 10 });
    expect(model.entities.filter((e) => e.kind === "flag")).toHaveLength(1);
    expect(model.entities.find((e) => e.kind === "flag")).toMatchObject({ x: 3, y: 6 });
    sel.rect = { x: 1, y: 4, w: 4, h: 3 };
    sel.press({ x: 2, y: 5 });
    sel.dragTo({ x: 12, y: 5 });
    sel.release({ x: 12, y: 5 });
    expect(model.entities.filter((e) => e.kind === "flag")).toHaveLength(1);
    expect(model.entities.find((e) => e.kind === "flag")).toMatchObject({ x: 13, y: 6 });
  });

  it("cancel drops a gesture without editing", () => {
    const { model, sel } = setup();
    select(sel, { x: 1, y: 4 }, { x: 4, y: 6 });
    sel.press({ x: 2, y: 5 });
    sel.dragTo({ x: 12, y: 8 });
    sel.cancel();
    expect(sel.release({ x: 12, y: 8 })).toBe("none");
    expect(model.tileAt(2, 5)).toBe(GRASS);
  });
});
