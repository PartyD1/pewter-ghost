import { describe, expect, it } from "vitest";
import { LevelModel } from "../level/LevelModel";
import { parseSave, serializeSave } from "../level/save";
import { decodeShareCode, encodeShareCode } from "../level/share";
import {
  apexTiles,
  DEFAULT_PLAY_SETTINGS,
  enemyTuning,
  isDefaultSettings,
  normalisePlaySettings,
  normaliseSetting,
  playGravity,
  PlaySettingsStore,
  scaledJumpVelocity,
  settingsForSave,
  toBodyVx,
  toControllerVx,
} from "./playSettings";

describe("play settings", () => {
  it("defaults to the designed game", () => {
    expect(normalisePlaySettings(undefined)).toEqual(DEFAULT_PLAY_SETTINGS);
    expect(isDefaultSettings({})).toBe(true);
    expect(settingsForSave({})).toBeUndefined();
  });

  it("clamps, snaps and rejects garbage", () => {
    expect(normaliseSetting("gravityScale", 9)).toBe(1.5);
    expect(normaliseSetting("gravityScale", 0.01)).toBe(0.5);
    expect(normaliseSetting("speedScale", 1.234)).toBe(1.25);
    expect(normaliseSetting("enemyAggression", Number.NaN)).toBe(1);
    expect(normaliseSetting("jumpScale", "2" as unknown)).toBe(1);
  });

  it("saves only what differs from the default", () => {
    expect(settingsForSave({ gravityScale: 1, speedScale: 1.2 })).toEqual({ speedScale: 1.2 });
  });

  it("store notifies on change and ignores no-ops", () => {
    const s = new PlaySettingsStore();
    let n = 0;
    s.subscribe(() => n++);
    expect(s.set({ gravityScale: 1 })).toBe(false);
    expect(s.set({ gravityScale: 1.2 })).toBe(true);
    expect(s.get().gravityScale).toBe(1.2);
    s.replace({ enemyAggression: 0 });
    expect(s.get()).toEqual({ ...DEFAULT_PLAY_SETTINGS, enemyAggression: 0 });
    s.reset();
    expect(s.get()).toEqual(DEFAULT_PLAY_SETTINGS);
    expect(n).toBe(3);
  });

  it("speed scaling wraps the controller without changing its maths", () => {
    expect(toBodyVx(toControllerVx(100, 1.25), 1.25)).toBeCloseTo(100);
    expect(toBodyVx(256, 1.5)).toBe(384);
  });

  it("gravity and jump scale the arc", () => {
    const s = { ...DEFAULT_PLAY_SETTINGS };
    expect(playGravity(1500, s)).toBe(1500);
    expect(playGravity(1500, { ...s, gravityScale: 0.5 })).toBe(750);
    expect(scaledJumpVelocity(-550, { ...s, jumpScale: 1.2 })).toBeCloseTo(-660);
    const base = apexTiles(-550, 1500, s);
    expect(base).toBeCloseTo((550 * 550) / 3000 / 16);
    expect(apexTiles(-550, 1500, { ...s, gravityScale: 0.5 })).toBeCloseTo(base * 2);
  });

  it("enemy aggression: 0 passive, 1 designed, 2 harsher", () => {
    expect(enemyTuning(0)).toEqual({ speedMul: 0.5, fireMul: 0, chase: false });
    expect(enemyTuning(1)).toEqual({ speedMul: 1, fireMul: 1, chase: true });
    expect(enemyTuning(2)).toEqual({ speedMul: 1.5, fireMul: 2, chase: true });
  });

  it("round-trips through save v2 and the share code", async () => {
    const m = new LevelModel({ w: 20, h: 10 });
    const settings = { gravityScale: 1.2, enemyAggression: 0.5 };
    const parsed = parseSave(serializeSave(m, { playSettings: settingsForSave(settings) }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(normalisePlaySettings(parsed.file.playSettings)).toEqual({ ...DEFAULT_PLAY_SETTINGS, ...settings });
    const code = await encodeShareCode(m, { playSettings: settingsForSave(settings) });
    const dec = await decodeShareCode(code);
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(normalisePlaySettings(dec.playSettings)).toEqual({ ...DEFAULT_PLAY_SETTINGS, ...settings });
  });
});
