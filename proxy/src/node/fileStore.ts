/**
 * Node file-backed ProxyStore: keys map to files under a root directory
 * (proxy/.data in dev). Appends to one key are serialised so lines never interleave.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProxyStore } from "../store";

export class FileStore implements ProxyStore {
  private readonly chains = new Map<string, Promise<void>>();
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Absolute path for a key; refuses keys that escape the root. */
  pathFor(key: string): string {
    if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.split("/").some((seg) => seg === "" || seg === "." || seg === ".."))
      throw new Error(`unsafe store key: ${key}`);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error(`unsafe store key: ${key}`);
    return p;
  }

  append(key: string, text: string): Promise<void> {
    let file: string;
    try {
      file = this.pathFor(key);
    } catch (e) {
      return Promise.reject(e);
    }
    const prev = this.chains.get(file) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, text, "utf8");
      });
    this.chains.set(file, next);
    void next.finally(() => {
      if (this.chains.get(file) === next) this.chains.delete(file);
    }).catch(() => undefined);
    return next;
  }

  /** Keys of the files under the prefix's directory whose key starts with the prefix. */
  async list(prefix: string): Promise<string[]> {
    const slash = prefix.lastIndexOf("/");
    const dirKey = slash >= 0 ? prefix.slice(0, slash) : "";
    const dir = dirKey ? this.pathFor(`${dirKey}/x`).replace(/[/\\]x$/, "") : this.root;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return names
      .map((n) => (dirKey ? `${dirKey}/${n}` : n))
      .filter((k) => k.startsWith(prefix))
      .sort();
  }

  async read(key: string): Promise<string | null> {
    const file = this.pathFor(key);
    await (this.chains.get(file) ?? Promise.resolve()).catch(() => undefined);
    try {
      return await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}
