import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

export default defineConfig({
  root: exampleRoot,
  resolve: {
    alias: [
      { find: "@honua/sdk-js/query-planner", replacement: path.resolve(repoRoot, "src/query-planner/index.ts") },
      { find: "@honua/sdk-js/contract", replacement: path.resolve(repoRoot, "src/contract/index.ts") },
      { find: "@honua/sdk-js/agent-tools", replacement: path.resolve(repoRoot, "src/agent-tools/index.ts") },
      { find: "@honua/sdk-js/app-workspace", replacement: path.resolve(repoRoot, "src/app-workspace/index.ts") },
      { find: "@honua/sdk-js/exploration", replacement: path.resolve(repoRoot, "src/exploration/index.ts") },
      { find: "@honua/sdk-js/interactions", replacement: path.resolve(repoRoot, "src/interactions/index.ts") },
      { find: "@honua/sdk-js/honua", replacement: path.resolve(repoRoot, "src/honua.ts") },
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
