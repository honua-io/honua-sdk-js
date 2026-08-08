import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

export default defineConfig({
  root: exampleRoot,
  resolve: {
    alias: [
      { find: "@honua/sdk-js/coverages", replacement: path.resolve(repoRoot, "src/coverages/index.ts") },
      { find: "@honua/sdk-js/honua", replacement: path.resolve(repoRoot, "src/honua.ts") },
    ],
  },
  server: { host: "127.0.0.1", fs: { allow: [repoRoot] } },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
