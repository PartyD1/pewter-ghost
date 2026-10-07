/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("./apps/editor"),
  base: "./",
  publicDir: r("./apps/editor/public"),
  resolve: {
    alias: [
      { find: /^@app\/(.*)$/, replacement: r("./apps/editor/src/") + "$1" },
      { find: /^@physsim$/, replacement: r("./packages/physsim/src/index.ts") },
      { find: /^@physsim\/(.*)$/, replacement: r("./packages/physsim/src/") + "$1" },
      { find: /^@measure$/, replacement: r("./packages/measure/src/index.ts") },
      { find: /^@measure\/(.*)$/, replacement: r("./packages/measure/src/") + "$1" },
      { find: /^@jump-tables$/, replacement: r("./packages/jump-tables/src/index.ts") },
      { find: /^@jump-tables\/(.*)$/, replacement: r("./packages/jump-tables/src/") + "$1" },
      { find: /^@chunks$/, replacement: r("./packages/chunks/src/index.ts") },
      { find: /^@chunks\/(.*)$/, replacement: r("./packages/chunks/src/") + "$1" },
    ],
  },
  build: { outDir: r("./dist"), emptyOutDir: true, target: "es2022" },
  worker: { format: "es" },
  server: { port: 5173, strictPort: false },
  test: {
    root: r("."),
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "proxy/**/*.test.ts",
      "eval/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 20000,
  },
});
