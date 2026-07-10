import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.resolve(repoRoot, "package.json"), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __HONUA_SDK_VERSION__: JSON.stringify(packageJson.version),
  },
  root: exampleRoot,
  envDir: exampleRoot,
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/contract",
        replacement: path.resolve(repoRoot, "src/contract/index.ts"),
      },
      {
        find: "@honua/sdk-js/exploration",
        replacement: path.resolve(repoRoot, "src/exploration/index.ts"),
      },
      {
        find: "@honua/sdk-js/query-planner",
        replacement: path.resolve(repoRoot, "src/query-planner/index.ts"),
      },
      {
        find: "@honua/sdk-js/interactions",
        replacement: path.resolve(repoRoot, "src/interactions/index.ts"),
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
