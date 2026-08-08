import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

export default defineConfig({
  root: exampleRoot,
  resolve: {
    alias: [
      { find: "@honua/sdk-js/stac", replacement: path.resolve(repoRoot, "src/stac/index.ts") },
      { find: "@honua/sdk-js/app-workspace", replacement: path.resolve(repoRoot, "src/app-workspace/index.ts") },
      { find: "@honua/sdk-js/exploration", replacement: path.resolve(repoRoot, "src/exploration/index.ts") },
    ],
  },
  server: {
    host: "127.0.0.1",
    fs: { allow: [repoRoot] },
  },
  preview: {
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
