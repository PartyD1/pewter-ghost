import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanDir, scanText } from "./keyScan";

const FAKE = "AIza" + "B".repeat(35);

describe("keyScan", () => {
  it("finds Google key patterns and the configured key, masked", () => {
    const hits = scanText(`const k="${FAKE}"; other="sk-local-secret-123"`, "a.js", "sk-local-secret-123");
    expect(hits.map((h) => h.kind)).toEqual(["pattern", "configured-key"]);
    expect(JSON.stringify(hits)).not.toContain(FAKE);
    expect(JSON.stringify(hits)).not.toContain("sk-local-secret-123");
    expect(scanText("clean", "b.js")).toEqual([]);
  });
  it("walks a directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pg-scan-"));
    try {
      await mkdir(path.join(dir, "assets"));
      await writeFile(path.join(dir, "index.html"), "<html></html>");
      await writeFile(path.join(dir, "assets", "main.js"), `x="${FAKE}"`);
      const hits = await scanDir(dir);
      expect(hits).toHaveLength(1);
      expect(hits[0].file).toBe(path.join("assets", "main.js"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
