import { describe, expect, it } from "vitest";
import { AUTHOR, LEVEL_W, TILE } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { checkSnapshot } from "../level/snapshot";
import { starterSnapshot } from "./newLevel";

describe("starterSnapshot (the old Pewter Platformer default map)", () => {
  it("is a valid level: full grass row 15 and dirt rows 16-19, ground under the start, a flag near the end", () => {
    const s = starterSnapshot();
    expect(checkSnapshot(s).ok).toBe(true);
    const m = LevelModel.fromSnapshot(s);
    for (let x = 0; x < LEVEL_W; x++) {
      expect(m.tileAt(x, 15)).toBe(TILE.GRASS);
      for (let y = 16; y < 20; y++) expect(m.tileAt(x, y)).toBe(TILE.DIRT);
      for (let y = 0; y < 15; y++) expect(m.tileAt(x, y)).toBe(TILE.EMPTY);
    }
    expect(m.isSolid(m.start.x, m.start.y + 1)).toBe(true);
    expect(m.isSolid(m.start.x, m.start.y)).toBe(false);
    const flag = m.entities.find((e) => e.kind === "flag")!;
    expect(flag).toBeDefined();
    expect(flag.x).toBe(LEVEL_W - 4);
    expect(m.isSolid(flag.x, flag.y + 1)).toBe(true);
    expect(m.entities).toHaveLength(1);
  });

  it("the map's tiles are the person's; the template flag belongs to nobody", () => {
    const m = LevelModel.fromSnapshot(starterSnapshot());
    const by = m.authoredBy();
    expect(by.cells.person).toBe(LEVEL_W * 5);
    expect(by.cells.ghost).toBe(0);
    expect(m.authorAt(0, 15)).toBe(AUTHOR.PERSON);
    expect(m.entityAuthor(m.entities[0].id)).toBe(AUTHOR.NONE);
  });
});
