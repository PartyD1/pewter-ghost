import { describe, expect, it } from "vitest";
import { AUTHOR, LEVEL_W, TILE } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { checkSnapshot } from "../level/snapshot";
import { starterSnapshot } from "./newLevel";

describe("starterSnapshot", () => {
  it("is a valid level with ground under the start and a flag on the goal platform", () => {
    const s = starterSnapshot();
    expect(checkSnapshot(s).ok).toBe(true);
    const m = LevelModel.fromSnapshot(s);
    expect(m.isSolid(m.start.x, m.start.y + 1)).toBe(true);
    expect(m.isSolid(m.start.x, m.start.y)).toBe(false);
    const flag = m.entities.find((e) => e.kind === "flag")!;
    expect(flag).toBeDefined();
    expect(flag.x).toBe(LEVEL_W - 4);
    expect(m.isSolid(flag.x, flag.y + 1)).toBe(true);
    expect(m.tileAt(LEVEL_W / 2, m.start.y + 1)).toBe(TILE.EMPTY);
  });

  it("template cells belong to nobody", () => {
    const m = LevelModel.fromSnapshot(starterSnapshot());
    const by = m.authoredBy();
    expect(by.cells.person).toBe(0);
    expect(by.cells.ghost).toBe(0);
    expect(m.authorAt(0, m.start.y + 1)).toBe(AUTHOR.NONE);
    expect(m.entityAuthor(m.entities[0].id)).toBe(AUTHOR.NONE);
  });
});
