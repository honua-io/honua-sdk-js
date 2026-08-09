import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

export default defineConfig({
  root: exampleRoot,
  envDir: exampleRoot,
  base: "./",
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/nl-map-control",
        replacement: path.resolve(repoRoot, "src/nl-map-control/index.ts"),
      },
      {
        find: "@honua/sdk-js/agent-tools",
        replacement: path.resolve(repoRoot, "src/agent-tools/index.ts"),
      },
      {
        find: "@honua/sdk-js/agent-safety",
        replacement: path.resolve(repoRoot, "src/agent-safety/index.ts"),
      },
      {
        find: "@honua/sdk-js/query-planner",
        replacement: path.resolve(repoRoot, "src/query-planner/index.ts"),
      },
      {
        find: "@honua/sdk-js/exploration",
        replacement: path.resolve(repoRoot, "src/exploration/index.ts"),
      },
      {
        find: "@honua/sdk-js/contract",
        replacement: path.resolve(repoRoot, "src/contract/index.ts"),
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
