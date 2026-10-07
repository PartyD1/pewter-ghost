/**
 * Runs the levels/ tests with the root config's aliases. The root
 * vite.config.ts only includes apps/, packages/, proxy/ and eval/ tests, so:
 *   npx vitest run --config levels/vitest.config.ts
 */
import { defineConfig } from "vitest/config";
import base from "../vite.config";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["levels/**/*.test.ts"],
    testTimeout: 60000,
  },
});
