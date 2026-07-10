import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/contract",
        replacement: path.resolve(import.meta.dirname, "src/contract/index.ts"),
      },
      {
        find: "@honua/sdk-js/query-planner",
        replacement: path.resolve(import.meta.dirname, "src/query-planner/index.ts"),
      },
      {
        find: "@honua/sdk-js/honua",
        replacement: path.resolve(import.meta.dirname, "src/honua.ts"),
      },
      {
        find: "@honua/sdk-js",
        replacement: path.resolve(import.meta.dirname, "src/index.ts"),
      },
    ],
  },
  test: {
    include: ["test/staging/**/*.integration.ts"],
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
  },
});
