import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/runtime",
        replacement: path.resolve(import.meta.dirname, "src/runtime/index.ts"),
      },
      {
        find: "@honua/sdk-js",
        replacement: path.resolve(import.meta.dirname, "src/index.ts"),
      },
    ],
  },
  test: {
    include: ["test/first-map-workflow.test.ts", "test/first-map-presentation.test.ts"],
    fileParallelism: false,
  },
});
