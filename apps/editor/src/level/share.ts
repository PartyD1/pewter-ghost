/**
 * Share codes (G-37 pure part): a level as a short copy-pasteable string.
 *
 * Code:   "pg1." + method + "." + base64url(payload)
 *         method "d" = deflate-raw (CompressionStream), "r" = PackBits RLE.
 * Payload (before compression), little-endian:
 *   u8  format (1)
 *   u16 w, u16 h, u16 startX, u16 startY
 *   u8  flags: 1 goal, 2 authors, 4 playSettings
 *   [u16 goalX, u16 goalY]
 *   w*h bytes: tile | author << 4
 *   u16 entity count; per entity: u8 kind, u16 x, u16 y, u8 author, u16 textLen (0xffff = none), utf8 text
 *   [4 x u16 playSettings in thousandths; 0xffff = unset]
 *   u32 FNV-1a checksum of everything above
 *
 * Provenance and entity ids are not shared (research data / regenerated);
 * decoded entities get ids e1..eN in order.
 */
import { AUTHOR, type Author, type Entity, type LevelSnapshot } from "../contracts";
import { ENTITY_KINDS } from "./entities";
import type { LevelModel } from "./LevelModel";
import type { PlaySettings } from "./save";
import { playSettingsSchema } from "./save";
import { checkSnapshot, MAX_ENTITIES, MAX_LEVEL_CELLS } from "./snapshot";

export const SHARE_PREFIX = "pg1";
const FORMAT = 1;
const FLAG_GOAL = 1;
const FLAG_AUTHORS = 2;
const FLAG_SETTINGS = 4;
/** Text length marking an entity without text. */
const NO_TEXT = 0xffff;
/** Refuse to inflate beyond this (decompression-bomb guard). */
const MAX_PAYLOAD = MAX_LEVEL_CELLS + MAX_ENTITIES * 600 + 64;
const SETTING_KEYS = ["gravityScale", "speedScale", "jumpScale", "enemyAggression"] as const;

export type ShareMethod = "auto" | "deflate" | "rle";

export interface ShareOptions {
  /** auto (default): the shorter of deflate (when available) and RLE. */
  method?: ShareMethod;
  /** Keep who placed each tile (default true). */
  includeAuthors?: boolean;
  playSettings?: PlaySettings;
}

export type ShareDecodeResult =
  | { ok: true; snapshot: LevelSnapshot; playSettings?: PlaySettings; warnings: string[] }
  | { ok: false; error: string };

export const deflateAvailable = (): boolean =>
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export async function encodeShareCode(level: LevelModel | LevelSnapshot, opts: ShareOptions = {}): Promise<string> {
  const snap = "snapshot" in level && typeof level.snapshot === "function" ? level.snapshot() : (level as LevelSnapshot);
  const raw = encodePayload(snap, opts);
  const method = opts.method ?? "auto";
  if (method === "deflate" && !deflateAvailable()) throw new Error("deflate is not available in this environment");
  const candidates: [string, Uint8Array][] = [];
  if (method !== "deflate") candidates.push(["r", packBits(raw)]);
  if (method !== "rle" && deflateAvailable()) candidates.push(["d", await deflateRaw(raw)]);
  candidates.sort((a, b) => a[1].length - b[1].length);
  const [m, bytes] = candidates[0];
  return `${SHARE_PREFIX}.${m}.${toBase64Url(bytes)}`;
}

export function encodePayload(snap: LevelSnapshot, opts: Pick<ShareOptions, "includeAuthors" | "playSettings"> = {}): Uint8Array {
  const includeAuthors = opts.includeAuthors ?? true;
  const w = new ByteWriter();
  w.u8(FORMAT);
  w.u16(snap.w);
  w.u16(snap.h);
  w.u16(snap.start.x);
  w.u16(snap.start.y);
  const settings = opts.playSettings && Object.values(opts.playSettings).some((v) => v !== undefined) ? opts.playSettings : undefined;
  w.u8((snap.goal ? FLAG_GOAL : 0) | (includeAuthors ? FLAG_AUTHORS : 0) | (settings ? FLAG_SETTINGS : 0));
  if (snap.goal) {
    w.u16(snap.goal.x);
    w.u16(snap.goal.y);
  }
  const n = snap.w * snap.h;
  for (let i = 0; i < n; i++) w.u8((snap.cells[i] & 0x0f) | (includeAuthors ? (snap.authors[i] & 0x03) << 4 : 0));
  if (snap.entities.length > 0xffff) throw new RangeError("too many entities to share");
  w.u16(snap.entities.length);
  const enc = new TextEncoder();
  for (const e of snap.entities) {
    w.u8(ENTITY_KINDS.indexOf(e.kind));
    w.u16(e.x);
    w.u16(e.y);
    w.u8(includeAuthors ? (snap.entityAuthors[e.id] ?? AUTHOR.PERSON) : AUTHOR.NONE);
    if (e.text === undefined) {
      w.u16(NO_TEXT);
      continue;
    }
    const text = enc.encode(e.text);
    if (text.length >= NO_TEXT) throw new RangeError("sign text too long to share");
    w.u16(text.length);
    w.bytes(text);
  }
  if (settings)
    for (const k of SETTING_KEYS) {
      const v = settings[k];
      w.u16(v === undefined ? 0xffff : Math.min(0xfffe, Math.max(0, Math.round(v * 1000))));
    }
  const body = w.done();
  const out = new ByteWriter();
  out.bytes(body);
  out.u32(fnv1a(body));
  return out.done();
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export async function decodeShareCode(code: string): Promise<ShareDecodeResult> {
  if (typeof code !== "string") return { ok: false, error: "A share code must be text." };
  const clean = code.replace(/\s+/g, "");
  const parts = clean.split(".");
  if (parts.length !== 3 || parts[0] !== SHARE_PREFIX)
    return { ok: false, error: "This is not a Pewter share code." };
  const [, method, body] = parts;
  const packed = fromBase64Url(body);
  if (!packed) return { ok: false, error: "This share code has invalid characters." };
  let raw: Uint8Array | undefined;
  try {
    if (method === "r") raw = unpackBits(packed, MAX_PAYLOAD);
    else if (method === "d") {
      if (!deflateAvailable()) return { ok: false, error: "This browser cannot open compressed share codes." };
      raw = await inflateRaw(packed, MAX_PAYLOAD);
    } else return { ok: false, error: "This share code uses an unknown packing." };
  } catch {
    raw = undefined;
  }
  if (!raw) return { ok: false, error: "This share code is damaged (could not unpack it)." };
  return decodePayload(raw);
}

export function decodePayload(raw: Uint8Array): ShareDecodeResult {
  if (raw.length < 4) return { ok: false, error: "This share code is damaged (too short)." };
  const body = raw.subarray(0, raw.length - 4);
  const sum = new DataView(raw.buffer, raw.byteOffset + raw.length - 4, 4).getUint32(0, true);
  if (fnv1a(body) !== sum) return { ok: false, error: "This share code is damaged (checksum mismatch)." };
  const r = new ByteReader(body);
  try {
    const format = r.u8();
    if (format !== FORMAT) return { ok: false, error: `This share code is format ${format}; this Pewter reads ${FORMAT}.` };
    const w = r.u16();
    const h = r.u16();
    if (w < 1 || h < 1 || w * h > MAX_LEVEL_CELLS) return { ok: false, error: "This share code has an invalid level size." };
    const start = { x: r.u16(), y: r.u16() };
    const flags = r.u8();
    const goal = flags & FLAG_GOAL ? { x: r.u16(), y: r.u16() } : undefined;
    const n = w * h;
    const cells = new Array<number>(n);
    const authors = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const b = r.u8();
      cells[i] = b & 0x0f;
      authors[i] = flags & FLAG_AUTHORS ? (b >> 4) & 0x03 : AUTHOR.NONE;
    }
    const count = r.u16();
    const dec = new TextDecoder("utf-8", { fatal: true });
    const entities: Entity[] = [];
    const entityAuthors: Record<string, Author> = {};
    for (let k = 0; k < count; k++) {
      const kind = ENTITY_KINDS[r.u8()];
      if (!kind) return { ok: false, error: "This share code has an unknown entity." };
      const x = r.u16();
      const y = r.u16();
      const a = r.u8();
      const len = r.u16();
      const id = `e${k + 1}`;
      const e: Entity = { id, kind, x, y };
      if (len !== NO_TEXT) e.text = dec.decode(r.bytes(len));
      entities.push(e);
      entityAuthors[id] = (a <= 2 ? a : AUTHOR.PERSON) as Author;
    }
    let playSettings: PlaySettings | undefined;
    if (flags & FLAG_SETTINGS) {
      const s: PlaySettings = {};
      for (const key of SETTING_KEYS) {
        const v = r.u16();
        if (v !== 0xffff) s[key] = v / 1000;
      }
      const ok = playSettingsSchema.safeParse(s);
      if (!ok.success) return { ok: false, error: "This share code has invalid play settings." };
      playSettings = s;
    }
    if (!r.atEnd()) return { ok: false, error: "This share code is damaged (trailing data)." };
    const snap: LevelSnapshot = { w, h, cells, authors, provenance: {}, entities, entityAuthors, start };
    if (goal) snap.goal = goal;
    const checked = checkSnapshot(snap);
    if (!checked.ok) return { ok: false, error: `This share code is damaged: ${checked.error}` };
    const res: ShareDecodeResult = { ok: true, snapshot: checked.snapshot, warnings: checked.warnings };
    if (playSettings) res.playSettings = playSettings;
    return res;
  } catch {
    return { ok: false, error: "This share code is damaged (truncated)." };
  }
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

/**
 * PackBits: control byte c < 128 -> c+1 literal bytes follow;
 * c >= 128 -> the next byte repeats c-126 times (2..129).
 */
export function packBits(src: Uint8Array): Uint8Array {
  const out = new ByteWriter();
  let i = 0;
  const n = src.length;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 129 && src[i + run] === src[i]) run++;
    if (run >= 2) {
      out.u8(run + 126);
      out.u8(src[i]);
      i += run;
      continue;
    }
    const startLit = i;
    let len = 0;
    while (i < n && len < 128) {
      if (i + 1 < n && src[i + 1] === src[i]) break;
      i++;
      len++;
    }
    out.u8(len - 1);
    out.bytes(src.subarray(startLit, startLit + len));
  }
  return out.done();
}

export function unpackBits(src: Uint8Array, maxOut = Number.POSITIVE_INFINITY): Uint8Array {
  const out = new ByteWriter();
  let i = 0;
  while (i < src.length) {
    const c = src[i++];
    if (c < 128) {
      const len = c + 1;
      if (i + len > src.length) throw new RangeError("truncated literal");
      out.bytes(src.subarray(i, i + len));
      i += len;
    } else {
      if (i >= src.length) throw new RangeError("truncated run");
      const len = c - 126;
      const b = src[i++];
      for (let k = 0; k < len; k++) out.u8(b);
    }
    if (out.length > maxOut) throw new RangeError("payload too large");
  }
  return out.done();
}

async function pump(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxOut: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Do not await: reading must run concurrently or back-pressure deadlocks.
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const out = new ByteWriter();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.bytes(value);
    if (out.length > maxOut) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("payload too large");
    }
  }
  return out.done();
}

export function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new CompressionStream("deflate-raw"), Number.POSITIVE_INFINITY);
}

export function inflateRaw(bytes: Uint8Array, maxOut = MAX_PAYLOAD): Promise<Uint8Array> {
  return pump(bytes, new DecompressionStream("deflate-raw"), maxOut);
}

// ---------------------------------------------------------------------------
// base64url (no padding), portable to workers and Node
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const v = bytes[i] << 16;
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63];
  }
  return s;
}

/** Returns undefined on invalid characters or an impossible length. */
export function fromBase64Url(s: string): Uint8Array | undefined {
  if (s.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) return undefined;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class ByteWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
  }

  u16(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
    this.ensure(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

class ByteReader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError("truncated");
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  atEnd(): boolean {
    return this.pos === this.buf.length;
  }
}
