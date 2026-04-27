import path from "node:path";

import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/honua",
        replacement: path.resolve(import.meta.dirname, "src/honua.ts"),
      },
      {
        find: "@honua/sdk-js/operator",
        replacement: path.resolve(import.meta.dirname, "src/operator/index.ts"),
      },
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
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: !ci,
    maxWorkers: ci ? 1 : undefined,
  },
});
