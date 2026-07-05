import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

export default defineConfig({
  root: exampleRoot,
  envDir: exampleRoot,
  // Automatic JSX runtime via esbuild keeps the demo plugin-free and aligned
  // with the repo's Vite tooling.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/react",
        replacement: path.resolve(repoRoot, "src/react/index.ts"),
      },
      {
        find: "@honua/sdk-js/runtime",
        replacement: path.resolve(repoRoot, "src/runtime/index.ts"),
      },
      {
        find: "@honua/sdk-js/contract",
        replacement: path.resolve(repoRoot, "src/contract/index.ts"),
      },
      {
        find: "@honua/sdk-js/honua",
        replacement: path.resolve(repoRoot, "src/honua.ts"),
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
