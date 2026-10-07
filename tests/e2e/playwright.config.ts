/**
 * Pewter Ghost end-to-end suite (G-07 harness, G-32 latency contracts).
 *
 *   npx playwright test -c tests/e2e/playwright.config.ts
 *
 * Starts its own Vite dev server on a free port (PG_E2E_PORT to pin one) and
 * drives the real editor in Chromium. Model answers are never live: every
 * POST /fill is answered from tests/e2e/fixtures/*.json (support/proxyMock.ts).
 */
import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");

/**
 * A free TCP port, picked once in the runner process. Workers re-evaluate this
 * file but inherit the runner's environment, so they all agree on the port.
 */
function freePort(): number {
  const out = execFileSync(
    process.execPath,
    ["-e", "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"],
    { encoding: "utf8" },
  );
  const port = Number(out.trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`could not find a free port (${out})`);
  return port;
}
if (!process.env.PG_E2E_PORT) process.env.PG_E2E_PORT = String(freePort());
const PORT = Number(process.env.PG_E2E_PORT);
const BASE = `http://127.0.0.1:${PORT}/`;

/** Use the preinstalled Chromium when Playwright's own lookup would miss it. */
function chromiumPath(): string | undefined {
  if (process.env.PG_E2E_CHROMIUM) return process.env.PG_E2E_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).sort().reverse()) {
    if (!/^chromium-\d+$/.test(d)) continue;
    const p = path.join(base, d, "chrome-linux", "chrome");
    if (existsSync(p)) return p;
  }
  return undefined;
}

export default defineConfig({
  testDir: path.join(here, "specs"),
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(ROOT, "test-results", "e2e"),
  fullyParallel: false,
  // The latency contracts measure wall-clock time; one worker keeps the dev server and CPU quiet.
  workers: process.env.PG_E2E_WORKERS ? Number(process.env.PG_E2E_WORKERS) : 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: path.join(ROOT, "playwright-report") }]] : [["list"]],
  use: {
    baseURL: BASE,
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1366, height: 768 },
        launchOptions: {
          executablePath: chromiumPath(),
          args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
        },
      },
    },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: ROOT,
    url: BASE,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { BROWSER: "none" },
  },
});
