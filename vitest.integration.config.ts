import path from "node:path";

import { defineConfig } from "vitest/config";

/** Exact source aliases for stable package entrypoints imported by integration tests. */
export const integrationSdkAliases = [
  {
    find: /^@honua\/sdk-js\/geocoding$/,
    replacement: path.resolve(import.meta.dirname, "src/geocoding/index.ts"),
  },
  {
    find: /^@honua\/sdk-js\/honua$/,
    replacement: path.resolve(import.meta.dirname, "src/honua.ts"),
  },
  {
    find: /^@honua\/sdk-js$/,
    replacement: path.resolve(import.meta.dirname, "src/index.ts"),
  },
] as const;

export default defineConfig({
  resolve: {
    alias: integrationSdkAliases,
  },
  test: {
    include: ["test/integration/surfaces/**/*.integration.ts"],
    exclude: ["dist/**", "node_modules/**"],
    globalSetup: ["test/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
