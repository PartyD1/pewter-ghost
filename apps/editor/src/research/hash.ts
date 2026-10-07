/**
 * Canonical JSON and SHA-256, shared by the proxy (requestHash on /fill) and
 * the client (so a fill.call can carry a hash even when the proxy never answered).
 *
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace,
 * `undefined` members dropped (as JSON.stringify does), non-finite numbers -> null,
 * arrays keep order. Same input object -> same string in Node, browsers and Workers.
 */

export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}

function write(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      return Number.isFinite(v) ? JSON.stringify(v) : "null";
    case "boolean":
      return v ? "true" : "false";
    case "bigint":
      return JSON.stringify(v.toString());
    case "undefined":
    case "function":
    case "symbol":
      return "null";
    case "object":
      break;
  }
  const obj = v as object;
  if (seen.has(obj)) throw new TypeError("canonicalJson: cyclic structure");
  const toJSON = (obj as { toJSON?: () => unknown }).toJSON;
  if (typeof toJSON === "function") return write(toJSON.call(obj), seen);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return "[" + obj.map((x) => (x === undefined || typeof x === "function" || typeof x === "symbol" ? "null" : write(x, seen))).join(",") + "]";
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => {
        const x = rec[k];
        return x !== undefined && typeof x !== "function" && typeof x !== "symbol";
      })
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + write(rec[k], seen)).join(",") + "}";
  } finally {
    seen.delete(obj);
  }
}

/** Lowercase hex SHA-256 of a UTF-8 string (WebCrypto: Node 18+, browsers, Workers). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** requestHash as used in fill.call events and proxy recordings. */
export function hashRequest(request: unknown): Promise<string> {
  return sha256Hex(canonicalJson(request));
}
