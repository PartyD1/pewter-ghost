import { knightLimits } from "@jump-tables";
import { describe, expect, it } from "vitest";
import type { MeasuredNumbers } from "../../../apps/editor/src/contracts";
import { INTENT_PRESETS } from "../../../apps/editor/src/fill/intent";
import { composeChunk, type ComposeKind } from "./compose";
import { levelGuessFor, mainTheme, styleFor, themesFromText, THEME_NAMES } from "./theme";

const knight = knightLimits("NORMAL");
const bare: MeasuredNumbers = { density: 0.1, gapHist: [0, 0, 0, 0, 0], verticality: 0, rewardSpacing: 0, pressure: 0 };

/** Share of non-flat pieces of each kind over many seeds. */
function mix(style: ReturnType<typeof styleFor>): Record<string, number> {
  const n: Record<string, number> = {};
  let total = 0;
  for (let seed = 0; seed < 300; seed++)
    for (const p of composeChunk({ w: 32, h: 20, ground: 15, seed, style }).pieces) {
      if (p.kind === "flat") continue;
      n[p.kind] = (n[p.kind] ?? 0) + 1;
      total++;
    }
  for (const k of Object.keys(n)) n[k] /= total;
  return n;
}
const share = (m: Record<string, number>, ...kinds: ComposeKind[]) => kinds.reduce((a, k) => a + (m[k] ?? 0), 0);

describe("themesFromText", () => {
  it("each goal preset lands on its own theme", () => {
    const want: Record<string, string> = { mario: "mario", maze: "maze", coins: "coins", enemies: "enemies", parkour: "parkour" };
    for (const p of INTENT_PRESETS) expect(mainTheme(themesFromText(p.text)), p.id).toBe(want[p.id]);
  });

  it("reads free text by keyword, and nothing from text with no keywords", () => {
    expect(mainTheme(themesFromText("lots of treasure to collect"))).toBe("coins");
    expect(mainTheme(themesFromText("A really HARD speedrun"))).toBe("parkour");
    expect(mainTheme(themesFromText("something easy for my kid"))).toBe("gentle");
    expect(themesFromText("a level about my cat")).toEqual({});
    expect(themesFromText("")).toEqual({});
    expect(themesFromText(undefined)).toEqual({});
  });

  it("a negated mention does not count; 'a few' does", () => {
    expect(themesFromText("no enemies please").enemies).toBeUndefined();
    expect(themesFromText("without any coins").coins).toBeUndefined();
    expect(themesFromText("with few enemies").enemies).toBeUndefined();
    expect(themesFromText("a few slimes").enemies).toBe(1);
  });

  it("keeps every theme that matches, for blending", () => {
    const h = themesFromText("a coin maze");
    expect(h.coins).toBe(1);
    expect(h.maze).toBe(1);
  });
});

describe("styleFor", () => {
  it("with nothing drawn and no goal: a bit of everything, some coins, an occasional enemy", () => {
    const s = styleFor({ measured: bare, knight });
    expect(s.enemyP).toBeGreaterThan(0);
    expect(s.coinP).toBeGreaterThan(0.4);
    expect(Object.values(s.weights).every((w) => w > 0)).toBe(true);
    expect(s.name).toBe("measured");
  });

  it("a full screen drawn without enemies or coins: the generator stops adding them", () => {
    const s = styleFor({ measured: bare, knight, evidence: 1 });
    expect(s.enemyP).toBe(0);
    expect(s.weights.enemy_run).toBeLessThan(styleFor({ measured: bare, knight }).weights.enemy_run! * 0.3);
    expect(s.coinP).toBeLessThanOrEqual(0.25);
  });

  it("enemies and coins in the drawing bring more of them", () => {
    const s = styleFor({ measured: { ...bare, pressure: 0.5, rewardSpacing: 3 }, knight, evidence: 1 });
    expect(s.enemyP).toBeGreaterThan(0.2);
    expect(s.coinP).toBeGreaterThanOrEqual(0.7);
  });

  it("the goal bends the mix of pieces", () => {
    const neutral = mix(styleFor({ measured: bare, knight }));
    const parkour = mix(styleFor({ measured: bare, knight, themes: { parkour: 3 } }));
    const coins = mix(styleFor({ measured: bare, knight, themes: { coins: 3 } }));
    const enemies = mix(styleFor({ measured: bare, knight, themes: { enemies: 3 } }));
    const mario = mix(styleFor({ measured: bare, knight, themes: { mario: 3 } }));
    expect(share(parkour, "gap_run", "stones", "pit", "platform_over_pit")).toBeGreaterThan(share(neutral, "gap_run", "stones", "pit", "platform_over_pit") + 0.15);
    expect(share(parkour, "enemy_run")).toBe(0);
    expect(share(coins, "coin_row", "coin_jump")).toBeGreaterThan(share(neutral, "coin_row", "coin_jump") + 0.15);
    // A slime run needs a long flat, so it is a smaller share of pieces: three times the neutral mix.
    expect(share(enemies, "enemy_run")).toBeGreaterThan(share(neutral, "enemy_run") * 3);
    expect(share(mario, "brick_row", "pillars")).toBeGreaterThan(share(neutral, "brick_row", "pillars") * 1.6);
  });

  it("a goal beats a drawing that has not shown the thing yet", () => {
    const s = styleFor({ measured: bare, knight, evidence: 1, themes: { enemies: 2 } });
    expect(s.enemyP).toBeGreaterThanOrEqual(0.3);
    const p = styleFor({ measured: { ...bare, pressure: 0.6 }, knight, evidence: 1, themes: { parkour: 2 } });
    expect(p.enemyP).toBe(0);
  });

  it("harder drawings and later sections raise the target intensity; themes shift it", () => {
    const easy = styleFor({ measured: { ...bare, difficulty: 0.1 }, knight }).intensity;
    const hard = styleFor({ measured: { ...bare, difficulty: 0.9 }, knight }).intensity;
    const late = styleFor({ measured: { ...bare, difficulty: 0.1 }, knight, progress: 1 }).intensity;
    expect(hard).toBeGreaterThan(easy + 0.2);
    expect(late).toBeGreaterThan(easy);
    expect(styleFor({ measured: bare, knight, themes: { parkour: 1 } }).intensity).toBeGreaterThan(styleFor({ measured: bare, knight, themes: { gentle: 1 } }).intensity + 0.3);
  });

  it("every theme gives sections the knight can cross", async () => {
    const { checkRules } = await import("@physsim");
    for (const name of THEME_NAMES) {
      const style = styleFor({ measured: bare, knight, themes: { [name]: 2 } });
      let ok = 0;
      for (let seed = 0; seed < 100; seed++) {
        const c = composeChunk({ w: 24, h: 20, ground: 15, seed, style });
        if (checkRules({ w: c.w, h: c.h, solid: c.grid }, { x: 0, y: c.ground - 1 }, { x0: c.w - 1, x1: c.w - 1 }).ok) ok++;
      }
      expect(ok, name).toBeGreaterThanOrEqual(95);
    }
  });
});

describe("levelGuessFor", () => {
  it("names the stated goal first", () => {
    expect(levelGuessFor({ measured: bare, themes: { parkour: 2 } })).toBe("parkour");
    expect(levelGuessFor({ measured: bare, themes: { coins: 1, maze: 3 } })).toBe("maze");
  });

  it("otherwise reads the drawing, and says nothing when there is little to go on", () => {
    expect(levelGuessFor({ measured: bare, evidence: 0.1 })).toBeNull();
    expect(levelGuessFor({ measured: { ...bare, pressure: 0.5 }, evidence: 1 })).toBe("enemy run");
    expect(levelGuessFor({ measured: { ...bare, rewardSpacing: 3 }, evidence: 1 })).toBe("coin run");
    expect(levelGuessFor({ measured: { ...bare, verticality: 0.5 }, evidence: 1 })).toBe("climb");
    expect(levelGuessFor({ measured: { ...bare, gapHist: [0, 2, 0, 0, 0] }, evidence: 1 })).toBe("gap jumping");
    expect(levelGuessFor({ measured: bare, evidence: 1 })).toBe("gentle platformer");
  });
});
