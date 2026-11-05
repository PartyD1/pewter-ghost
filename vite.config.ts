/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** `/replay` (no slash) opens the replay page, in dev and in `vite preview`. */
const replayRoute = (): Plugin => {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const m = /^\/replay(\?.*)?$/.exec(req.url ?? "");
    if (m) req.url = `/replay/${m[1] ?? ""}`;
    next();
  };
  return {
    name: "pewter-replay-route",
    configureServer: (s) => void s.middlewares.use(rewrite),
    configurePreviewServer: (s) => void s.middlewares.use(rewrite),
  };
};

export default defineConfig({
  root: r("./apps/editor"),
  base: "./",
  publicDir: r("./apps/editor/public"),
  plugins: [replayRoute()],
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
  build: {
    outDir: r("./dist"),
    emptyOutDir: true,
    target: "es2022",
    // Two pages: the editor and the session replay viewer (served at /replay/).
    rollupOptions: { input: { main: r("./apps/editor/index.html"), replay: r("./apps/editor/replay/index.html") } },
  },
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
