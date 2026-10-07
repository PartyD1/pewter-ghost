import { describe, expect, it } from "vitest";
import { TILE } from "../contracts";
import { LevelModel } from "../level/LevelModel";
import { parseSave } from "../level/save";
import {
  AUTOSAVE_KEY,
  AutoSaver,
  reloadTask,
  restoreAutosave,
  safeGet,
  safeSet,
  saveTask,
  TASK_SAVE_KEY,
  type SaveSources,
  type StorageLike,
  type Timers,
} from "./saveTask";

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const throwing: StorageLike = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("quota");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

class FakeTimers implements Timers {
  next = 1;
  pending = new Map<number, { fn: () => void; at: number }>();
  now = 0;
  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.pending.set(id, { fn, at: this.now + ms });
    return id;
  }
  clearTimeout(h: unknown) {
    this.pending.delete(h as number);
  }
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

function sources(m: LevelModel): SaveSources {
  return {
    model: m,
    playSettings: () => ({ speedScale: 1.2 }),
    history: () => ({ shown: 2, outcomes: { accepted: 1, esc: 1 }, recent: [] }),
    now: () => new Date(2026, 9, 7, 12, 0, 0),
  };
}

describe("save task", () => {
  it("builds a v2 file with settings and history and keeps a local copy", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    m.paintTile(3, 4, TILE.GRASS);
    const st = new MemStorage();
    const r = saveTask(sources(m), st);
    expect(r.fileName).toBe("pewter-level_2026-10-07_12-00-00.json");
    expect(r.storedLocally).toBe(true);
    const parsed = parseSave(r.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.playSettings).toEqual({ speedScale: 1.2 });
    expect(parsed.file.history?.shown).toBe(2);
    expect(parsed.snapshot.cells[4 * 20 + 3]).toBe(TILE.GRASS);
    expect(st.getItem(TASK_SAVE_KEY)).toBe(r.text);
    expect(st.getItem(AUTOSAVE_KEY)).toBe(r.text);
    expect(r.snapshotId).toMatch(/^r\d+-\d+$/);
  });

  it("reload puts back exactly the saved level and clears history", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    m.paintTile(1, 1, TILE.DIRT);
    const st = new MemStorage();
    saveTask(sources(m), st);
    m.paintTile(2, 2, TILE.DIRT);
    const res = reloadTask(m, st);
    expect(res.ok).toBe(true);
    expect(m.tileAt(1, 1)).toBe(TILE.DIRT);
    expect(m.tileAt(2, 2)).toBe(0);
    expect(m.canUndo).toBe(false);
  });

  it("reload without a save explains itself and changes nothing", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    m.paintTile(1, 1, TILE.DIRT);
    const res = reloadTask(m, new MemStorage());
    expect(res.ok).toBe(false);
    expect(m.tileAt(1, 1)).toBe(TILE.DIRT);
  });

  it("survives blocked storage", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    expect(saveTask(sources(m), throwing).storedLocally).toBe(false);
    expect(saveTask(sources(m), null).storedLocally).toBe(false);
    expect(safeGet(throwing, "x")).toBeNull();
    expect(safeSet(throwing, "x", "y")).toBe(false);
    expect(restoreAutosave(m, throwing)).toBeNull();
  });
});

describe("AutoSaver", () => {
  it("debounces and writes the latest level", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    const st = new MemStorage();
    const t = new FakeTimers();
    const a = new AutoSaver(sources(m), st, 1000, t);
    m.paintTile(1, 1, TILE.GRASS);
    a.schedule();
    t.advance(500);
    m.paintTile(2, 1, TILE.GRASS);
    a.schedule();
    t.advance(900);
    expect(a.saves).toBe(0);
    t.advance(200);
    expect(a.saves).toBe(1);
    const back = new LevelModel({ w: 20, h: 10 });
    expect(restoreAutosave(back, st)?.ok).toBe(true);
    expect(back.tileAt(2, 1)).toBe(TILE.GRASS);
  });

  it("flush writes pending changes immediately and is a no-op when clean", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    const st = new MemStorage();
    const t = new FakeTimers();
    const a = new AutoSaver(sources(m), st, 1000, t);
    expect(a.flush()).toBe(true);
    expect(a.saves).toBe(0);
    a.schedule();
    expect(a.pending).toBe(true);
    expect(a.flush()).toBe(true);
    expect(a.saves).toBe(1);
    expect(t.pending.size).toBe(0);
  });

  it("counts failures when storage refuses", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    const a = new AutoSaver(sources(m), throwing, 10, new FakeTimers());
    a.schedule();
    expect(a.flush()).toBe(false);
    expect(a.failures).toBe(1);
  });

  it("a corrupt autosave is reported, and the model is untouched", () => {
    const m = new LevelModel({ w: 20, h: 10 });
    m.paintTile(1, 1, TILE.GRASS);
    const st = new MemStorage();
    st.setItem(AUTOSAVE_KEY, "{not json");
    const res = restoreAutosave(m, st);
    expect(res?.ok).toBe(false);
    expect(m.tileAt(1, 1)).toBe(TILE.GRASS);
  });
});
