import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

export default defineConfig({
  root: exampleRoot,
  envDir: exampleRoot,
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/web-components",
        replacement: path.resolve(repoRoot, "src/web-components/index.ts"),
      },
      {
        find: "@honua/sdk-js/controls",
        replacement: path.resolve(repoRoot, "src/controls/index.ts"),
      },
      {
        find: "@honua/sdk-js/runtime",
        replacement: path.resolve(repoRoot, "src/runtime/index.ts"),
      },
      {
        find: "@honua/sdk-js/map",
        replacement: path.resolve(repoRoot, "src/map/index.ts"),
      },
      {
        find: "@honua/sdk-js",
        replacement: path.resolve(repoRoot, "src/index.ts"),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [repoRoot],
    },
  },
  preview: {
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
