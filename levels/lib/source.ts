/**
 * Readable level sources (levels/src/*.txt) -> LevelSnapshot.
 *
 * A source is plain text a person can edit in any editor:
 *
 *   ; comment lines start with a semicolon ('#' is the grass glyph)
 *   @name parkour-1            must match the file name (without .txt)
 *   @kind reference            reference | fixture
 *   @type parkour              parkour | maze | collect-a-thon | story | speedrun (references only)
 *   @title Pillar Run
 *   @expect beatable           beatable | unbeatable | open (default beatable)
 *   @note free text            any number of these
 *   @sign Text of a sign       one per 'i' glyph, in x order (then y)
 *   @size 200x20               optional, default 200x20
 *
 *   == section name            starts a section; sections are laid side by side
 *   ......cc......
 *   P.............
 *   ##############
 *   dddddddddddddd
 *
 * Glyphs are @measure's ASCII alphabet (ASCII_LEGEND): '.' empty, '#' grass,
 * 'd' dirt, 'B' block, '=' half block, '?' question block, 'c' coin,
 * 'f' fruit, 's' slime, 'U' ultraslime, 'F' flag, 'i' sign, 'P' start.
 *
 * Every row of a section must have the same width (a short row would silently
 * open a hole). A section may be shorter than the level; it is bottom-aligned,
 * so flat ground needs only its top rows plus the dirt below. Sections
 * concatenate left to right; the total width must not exceed the level width
 * and is padded with empty columns on the right.
 *
 * Pure: no file system. build.ts and load.ts do the I/O.
 */
import {
  ASCII_ENTITIES,
  ASCII_TILES,
  snapshotFromAscii,
} from "@measure";
import {
  AUTHOR,
  LEVEL_H,
  LEVEL_W,
  type EntityKind,
  type LevelSnapshot,
  type Point,
} from "../../apps/editor/src/contracts";
import { checkSnapshot } from "../../apps/editor/src/level/snapshot";

export const LEVEL_TYPES = ["parkour", "maze", "collect-a-thon", "story", "speedrun"] as const;
export type LevelType = (typeof LEVEL_TYPES)[number];

export const SOURCE_KINDS = ["reference", "fixture"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** What the playtest agent must conclude. `open` = no flag; start must reach the rightmost standable column. */
export const EXPECTS = ["beatable", "unbeatable", "open"] as const;
export type Expect = (typeof EXPECTS)[number];

export interface SourceSection {
  name: string;
  /** First and last level column of the section (inclusive). */
  x0: number;
  x1: number;
  /** 1-based line of the `==` header in the source. */
  line: number;
}

export interface LevelSource {
  name: string;
  kind: SourceKind;
  type?: LevelType;
  title: string;
  expect: Expect;
  notes: string[];
  signs: string[];
  w: number;
  h: number;
  /** Full-size rows (h rows of w glyphs). */
  rows: string[];
  sections: SourceSection[];
  /** Source file name, for messages. */
  file?: string;
}

export class LevelSourceError extends Error {
  constructor(
    message: string,
    readonly file: string | undefined,
    readonly line: number | undefined,
  ) {
    super(`${file ?? "<source>"}${line !== undefined ? `:${line}` : ""}: ${message}`);
    this.name = "LevelSourceError";
  }
}

const GLYPHS = new Set<string>([...Object.keys(ASCII_TILES), ...Object.keys(ASCII_ENTITIES), "P"]);

const isOneOf = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** Parse a level source. Throws LevelSourceError (with file and line) on any mistake. */
export function parseLevelSource(text: string, file?: string): LevelSource {
  const fail = (msg: string, line?: number): never => {
    throw new LevelSourceError(msg, file, line);
  };
  const meta: Partial<Record<string, string>> = {};
  const notes: string[] = [];
  const signs: string[] = [];
  const sections: { name: string; line: number; rows: string[]; rowLines: number[] }[] = [];
  let w = LEVEL_W;
  let h = LEVEL_H;

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, i) => {
    const ln = i + 1;
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "" || line.trimStart().startsWith(";")) return;
    if (line.startsWith("@")) {
      const m = /^@([a-z]+)\s*(.*)$/.exec(line);
      if (!m) return fail(`bad directive '${line}'`, ln);
      const [, key, value] = m;
      switch (key) {
        case "note":
          notes.push(value);
          return;
        case "sign":
          if (!value) return fail("@sign needs text", ln);
          signs.push(value);
          return;
        case "size": {
          const s = /^(\d+)x(\d+)$/.exec(value);
          if (!s) return fail(`@size must look like 200x20, got '${value}'`, ln);
          w = Number(s[1]);
          h = Number(s[2]);
          if (w < 1 || h < 2 || w > 4096 || h > 4096) return fail(`@size ${value} is out of range`, ln);
          return;
        }
        case "name":
        case "kind":
        case "type":
        case "title":
        case "expect":
          if (meta[key] !== undefined) return fail(`@${key} given twice`, ln);
          meta[key] = value;
          return;
        default:
          return fail(`unknown directive @${key}`, ln);
      }
    }
    if (line.startsWith("==")) {
      sections.push({ name: line.replace(/^=+\s*/, "") || `section ${sections.length + 1}`, line: ln, rows: [], rowLines: [] });
      return;
    }
    if (!sections.length) return fail("map rows must follow a '== section' header", ln);
    const row = line.trim();
    for (let x = 0; x < row.length; x++)
      if (!GLYPHS.has(row[x])) fail(`unknown glyph '${row[x]}' at column ${x + 1} of the section row`, ln);
    const sec = sections[sections.length - 1];
    sec.rows.push(row);
    sec.rowLines.push(ln);
  });

  const name = meta.name ?? fail("missing @name");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`@name '${name}' must be lower-case letters, digits and '-'`);
  if (file) {
    const base = file.replace(/^.*[\\/]/, "").replace(/\.txt$/, "");
    if (base !== name) fail(`@name '${name}' does not match the file name '${base}'`);
  }
  const kindRaw = meta.kind ?? "reference";
  if (!isOneOf(SOURCE_KINDS, kindRaw)) fail(`@kind must be one of ${SOURCE_KINDS.join(", ")}`);
  const kind = kindRaw as SourceKind;
  let type: LevelType | undefined;
  if (meta.type !== undefined) {
    if (!isOneOf(LEVEL_TYPES, meta.type)) fail(`@type must be one of ${LEVEL_TYPES.join(", ")}`);
    type = meta.type as LevelType;
  }
  if (kind === "reference" && !type) fail("a reference level needs @type");
  const expectRaw = meta.expect ?? "beatable";
  if (!isOneOf(EXPECTS, expectRaw)) fail(`@expect must be one of ${EXPECTS.join(", ")}`);
  const expect = expectRaw as Expect;
  if (kind === "reference" && expect !== "beatable") fail("reference levels must be @expect beatable");
  if (!sections.length) fail("no map sections");

  // Lay the sections side by side, bottom-aligned.
  const grid: string[][] = Array.from({ length: h }, () => []);
  const placed: SourceSection[] = [];
  let x = 0;
  for (const s of sections) {
    if (!s.rows.length) fail(`section '${s.name}' has no rows`, s.line);
    if (s.rows.length > h) fail(`section '${s.name}' has ${s.rows.length} rows; the level has ${h}`, s.line);
    const sw = s.rows[0].length;
    s.rows.forEach((r, i) => {
      if (r.length !== sw)
        fail(`section '${s.name}': row is ${r.length} wide, the section's first row is ${sw}`, s.rowLines[i]);
    });
    const top = h - s.rows.length;
    for (let y = 0; y < h; y++) {
      const r = y >= top ? s.rows[y - top] : ".".repeat(sw);
      grid[y].push(r);
    }
    placed.push({ name: s.name, x0: x, x1: x + sw - 1, line: s.line });
    x += sw;
  }
  if (x > w) fail(`sections are ${x} columns wide; the level is ${w}`);
  const rows = grid.map((parts) => parts.join("").padEnd(w, "."));

  let starts = 0;
  for (const r of rows) for (const ch of r) if (ch === "P") starts++;
  if (starts !== 1) fail(`expected exactly one start 'P', found ${starts}`);
  const flags = rows.reduce((n, r) => n + [...r].filter((c) => c === "F").length, 0);
  if (expect === "open" && flags) fail("an @expect open level has no flag");
  if (expect !== "open" && flags !== 1) fail(`expected exactly one flag 'F', found ${flags}`);
  const signCount = rows.reduce((n, r) => n + [...r].filter((c) => c === "i").length, 0);
  if (signCount !== signs.length) fail(`${signCount} sign glyph(s) 'i' but ${signs.length} @sign line(s)`);

  return {
    name,
    kind,
    type,
    title: meta.title ?? name,
    expect,
    notes,
    signs,
    w,
    h,
    rows,
    sections: placed,
    file,
  };
}

/** Where the knight touches the flag: the flag's cell, or undefined for an open level. */
export function flagOf(s: LevelSnapshot): Point | undefined {
  const f = s.entities.find((e) => e.kind === "flag");
  return f ? { x: f.x, y: f.y } : undefined;
}

/**
 * Build the snapshot: every tile and entity authored by the person (lab
 * levels are hand-made), entity ids e1..eN in x order, sign texts in x order,
 * goal = the flag, enemy patrols derived from the floor.
 */
export function sourceToSnapshot(src: LevelSource): LevelSnapshot {
  const raw = snapshotFromAscii(src.rows, { w: src.w, h: src.h, offsetX: 0, offsetY: 0 });
  const ents = [...raw.entities].sort((a, b) => a.x - b.x || a.y - b.y);
  const entities = ents.map((e, i) => ({ id: `e${i + 1}`, kind: e.kind as EntityKind, x: e.x, y: e.y }));
  const entityAuthors: LevelSnapshot["entityAuthors"] = {};
  for (const e of entities) entityAuthors[e.id] = AUTHOR.PERSON;
  let sign = 0;
  for (const e of entities) if (e.kind === "sign") (e as { text?: string }).text = src.signs[sign++];
  const snap: LevelSnapshot = { ...raw, provenance: {}, entities, entityAuthors };
  const flag = entities.find((e) => e.kind === "flag");
  if (flag) snap.goal = { x: flag.x, y: flag.y };
  const checked = checkSnapshot(snap);
  if (!checked.ok) throw new LevelSourceError(checked.error, src.file, undefined);
  if (checked.warnings.length) throw new LevelSourceError(checked.warnings.join("; "), src.file, undefined);
  return checked.snapshot;
}

/** Inverse of the map part: render a snapshot back to full-size rows (for diffs and the README). */
export function snapshotRows(s: LevelSnapshot): string[] {
  const tileGlyph = new Map<number, string>(Object.entries(ASCII_TILES).map(([g, t]) => [t, g]));
  const entGlyph = new Map<string, string>(Object.entries(ASCII_ENTITIES).map(([g, k]) => [k, g]));
  const rows: string[][] = [];
  for (let y = 0; y < s.h; y++) {
    const r: string[] = [];
    for (let x = 0; x < s.w; x++) r.push(tileGlyph.get(s.cells[y * s.w + x]) ?? "#");
    rows.push(r);
  }
  for (const e of s.entities) rows[e.y][e.x] = entGlyph.get(e.kind) ?? "?";
  if (rows[s.start.y]?.[s.start.x] === ".") rows[s.start.y][s.start.x] = "P";
  return rows.map((r) => r.join(""));
}
