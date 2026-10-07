/**
 * levels/index.json: one entry per built level (references and
 * fixtures) with its file, type, the agent's verdict and the type numbers,
 * so tools and people can browse the set without re-measuring it.
 * Timing (ms) is left out so the file only changes when a level does.
 */
import type { BuiltLevel } from "./pipeline";
import type { Expect, LevelType, SourceKind } from "./source";
import type { TypeNumbers } from "./types";

export interface IndexEntry {
  name: string;
  kind: SourceKind;
  type?: LevelType;
  title: string;
  /** Path relative to levels/. */
  file: string;
  expect: Expect;
  notes: string[];
  sections: { name: string; x0: number; x1: number }[];
  agent?: { beatable: boolean; exhausted: boolean; seconds?: number; frames?: number };
  fitsType?: boolean;
  numbers: TypeNumbers;
}

export interface IndexFile {
  version: 1;
  generatedBy: string;
  levels: IndexEntry[];
}

export function buildIndex(built: readonly BuiltLevel[]): IndexFile {
  return {
    version: 1,
    generatedBy: "levels/build.ts",
    levels: built.map((b) => {
      const s = b.source;
      const e: IndexEntry = {
        name: s.name,
        kind: s.kind,
        type: s.type,
        title: s.title,
        file: b.out,
        expect: s.expect,
        notes: s.notes,
        sections: s.sections.map(({ name, x0, x1 }) => ({ name, x0, x1 })),
        numbers: b.numbers,
      };
      if (b.beat)
        e.agent = { beatable: b.beat.beatable, exhausted: b.beat.exhausted, seconds: b.beat.seconds, frames: b.beat.frames };
      if (b.fit) e.fitsType = b.fit.ok;
      return e;
    }),
  };
}

export function formatIndex(f: IndexFile): string {
  return JSON.stringify(f, null, 2) + "\n";
}
