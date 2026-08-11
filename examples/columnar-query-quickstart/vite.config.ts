import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  root: "examples/columnar-query-quickstart",
  resolve: {
    alias: {
      "@honua/sdk-js/columnar-workflow": path.resolve(repoRoot, "src/columnar-workflow/index.ts"),
    },
  },
  server: { port: 5193, fs: { allow: [repoRoot] } },
});
