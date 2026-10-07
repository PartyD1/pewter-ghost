/**
 * Dev token store over proxy/.data/tokens.json. Re-reads the file when its
 * mtime changes, so the token script can add tokens while the server runs.
 */
import { promises as fs } from "node:fs";
import { parseTokenFile, StaticTokenStore, type TokenFile, type TokenInfo, type TokenStore } from "../sessions";

export class FileTokenStore implements TokenStore {
  private readonly inner: StaticTokenStore;
  private mtimeMs = -1;
  private lastError: string | null = null;

  constructor(
    readonly file: string,
    open = false,
    private readonly onError?: (msg: string) => void,
  ) {
    this.inner = new StaticTokenStore({ tokens: {} }, open);
  }

  private async refresh(): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(this.file);
    } catch {
      if (this.mtimeMs !== 0) {
        this.inner.setFile({ tokens: {} });
        this.mtimeMs = 0;
      }
      return;
    }
    if (stat.mtimeMs === this.mtimeMs) return;
    try {
      const parsed: TokenFile = parseTokenFile(await fs.readFile(this.file, "utf8"));
      this.inner.setFile(parsed);
      this.mtimeMs = stat.mtimeMs;
      this.lastError = null;
    } catch (e) {
      const msg = `token file ${this.file} unreadable: ${e instanceof Error ? e.message : String(e)}`;
      if (msg !== this.lastError) this.onError?.(msg);
      this.lastError = msg;
    }
  }

  async lookup(token: string): Promise<TokenInfo | null> {
    await this.refresh();
    return this.inner.lookup(token);
  }
}

export async function readTokenFileOrEmpty(file: string): Promise<TokenFile> {
  try {
    return parseTokenFile(await fs.readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { tokens: {} };
    throw e;
  }
}
