import { describe, expect, it } from "vitest";
import { ENTITY_KINDS } from "../level/entities";
import { TILE_BY_NAME } from "../contracts";
import { activeItemId, brushLabel, GROUP_ORDER, itemForBrush, itemsInGroup, PALETTE_ITEMS } from "./paletteItems";

describe("palette items", () => {
  it("offers every terrain tile and every entity kind, plus start and eraser", () => {
    for (const [name, id] of Object.entries(TILE_BY_NAME)) {
      const item = PALETTE_ITEMS.find((i) => i.id === name);
      expect(item?.action).toEqual({ kind: "tile", tile: id });
      expect(item?.frame).toBe(id);
    }
    for (const k of ENTITY_KINDS) expect(PALETTE_ITEMS.some((i) => i.action !== "erase" && i.action.kind === "entity" && i.action.entity === k)).toBe(true);
    expect(PALETTE_ITEMS.find((i) => i.id === "eraser")?.action).toBe("erase");
    expect(PALETTE_ITEMS.find((i) => i.id === "start")?.action).toEqual({ kind: "start" });
  });

  it("ids are unique and every item is in a shown group", () => {
    expect(new Set(PALETTE_ITEMS.map((i) => i.id)).size).toBe(PALETTE_ITEMS.length);
    expect(GROUP_ORDER.flatMap((g) => itemsInGroup(g)).length).toBe(PALETTE_ITEMS.length);
  });

  it("maps brushes back to items for highlighting and labels", () => {
    expect(itemForBrush({ kind: "entity", entity: "sign", text: "hi" })?.id).toBe("sign");
    expect(brushLabel({ kind: "tile", tile: 6 })).toBe("grass");
    expect(activeItemId("erase", { kind: "tile", tile: 6 })).toBe("eraser");
    expect(activeItemId("paint", { kind: "entity", entity: "coin" })).toBe("coin");
    expect(activeItemId("select", { kind: "entity", entity: "coin" })).toBeUndefined();
  });
});
