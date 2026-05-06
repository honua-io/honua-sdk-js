import path from "node:path";

import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  resolve: {
    alias: [
      // Subpath aliases come first so the prefix-matching parent
      // aliases below cannot rewrite `@honua/sdk-js/operator/<sub>`
      // into `src/operator/index.ts/<sub>` (which is a nonexistent
      // path). Each must be an exact-suffix entry pointing at the
      // matching `index.ts` for that subpath export.
      {
        find: "@honua/sdk-js/operator/controllers",
        replacement: path.resolve(import.meta.dirname, "src/operator/controllers/index.ts"),
      },
      {
        find: "@honua/sdk-js/operator/workspace",
        replacement: path.resolve(import.meta.dirname, "src/operator/workspace/index.ts"),
      },
      {
        find: "@honua/sdk-js/operator/theming",
        replacement: path.resolve(import.meta.dirname, "src/operator/theming/index.ts"),
      },
      {
        find: "@honua/sdk-js/operator/i18n",
        replacement: path.resolve(import.meta.dirname, "src/operator/i18n/index.ts"),
      },
      {
        find: "@honua/sdk-js/app-workspace",
        replacement: path.resolve(import.meta.dirname, "src/app-workspace/index.ts"),
      },
      {
        find: "@honua/sdk-js/contract",
        replacement: path.resolve(import.meta.dirname, "src/contract/index.ts"),
      },
      {
        find: "@honua/sdk-js/exploration",
        replacement: path.resolve(import.meta.dirname, "src/exploration/index.ts"),
      },
      {
        find: "@honua/sdk-js/geocoding",
        replacement: path.resolve(import.meta.dirname, "src/geocoding/index.ts"),
      },
      {
        find: "@honua/sdk-js/honua",
        replacement: path.resolve(import.meta.dirname, "src/honua.ts"),
      },
      {
        find: "@honua/sdk-js/interactions",
        replacement: path.resolve(import.meta.dirname, "src/interactions/index.ts"),
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
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/**/*.ts",
        "examples/maplibre-quickstart/src/**/*.ts",
        "examples/storytelling-25d-map/src/**/*.ts",
      ],
      exclude: ["dist/**", "src/gen/**", "src/**/index.ts", "src/*-entry.ts"],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 60,
        statements: 75,
      },
    },
    // Several migration CLI tests rebuild and execute the shared dist CLI.
    // Keep file execution serialized locally as well as in CI so those tests
    // do not contend for the same generated artifacts.
    fileParallelism: false,
    maxWorkers: ci ? 1 : undefined,
  },
});
