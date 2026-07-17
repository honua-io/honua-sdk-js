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
        find: "@honua/sdk-js/app-controller",
        replacement: path.resolve(import.meta.dirname, "src/app-controller/index.ts"),
      },
      {
        find: "@honua/sdk-js/app",
        replacement: path.resolve(import.meta.dirname, "src/app/index.ts"),
      },
      {
        find: "@honua/sdk-js/scene-workspace",
        replacement: path.resolve(import.meta.dirname, "src/scene-workspace/index.ts"),
      },
      {
        find: "@honua/sdk-js/control-plane",
        replacement: path.resolve(import.meta.dirname, "src/control-plane/index.ts"),
      },
      {
        find: "@honua/sdk-js/esri-compat",
        replacement: path.resolve(import.meta.dirname, "src/esri-compat-entry.ts"),
      },
      {
        find: "@honua/sdk-js/migration",
        replacement: path.resolve(import.meta.dirname, "src/migration-entry.ts"),
      },
      {
        find: "@honua/sdk-js/expr",
        replacement: path.resolve(import.meta.dirname, "src/expr/index.ts"),
      },
      {
        find: "@honua/sdk-js/webmap",
        replacement: path.resolve(import.meta.dirname, "src/webmap/index.ts"),
      },
      {
        find: "@honua/sdk-js/filter-registry",
        replacement: path.resolve(import.meta.dirname, "src/filter-registry/index.ts"),
      },
      {
        find: "@honua/sdk-js/style",
        replacement: path.resolve(import.meta.dirname, "src/style/index.ts"),
      },
      {
        find: "@honua/sdk-js/map",
        replacement: path.resolve(import.meta.dirname, "src/map/index.ts"),
      },
      {
        find: "@honua/sdk-js/agent-tools",
        replacement: path.resolve(import.meta.dirname, "src/agent-tools/index.ts"),
      },
      {
        find: "@honua/sdk-js/agent-safety",
        replacement: path.resolve(import.meta.dirname, "src/agent-safety/index.ts"),
      },
      {
        find: "@honua/sdk-js/query-planner",
        replacement: path.resolve(import.meta.dirname, "src/query-planner/index.ts"),
      },
      {
        find: "@honua/sdk-js/contract",
        replacement: path.resolve(import.meta.dirname, "src/contract/index.ts"),
      },
      {
        find: "@honua/sdk-js/query-planner",
        replacement: path.resolve(import.meta.dirname, "src/query-planner/index.ts"),
      },
      {
        find: "@honua/sdk-js/controls",
        replacement: path.resolve(import.meta.dirname, "src/controls/index.ts"),
      },
      {
        find: "@honua/sdk-js/collaboration",
        replacement: path.resolve(import.meta.dirname, "src/collaboration/index.ts"),
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
        find: "@honua/sdk-js/geometry",
        replacement: path.resolve(import.meta.dirname, "src/geometry/index.ts"),
      },
      {
        find: "@honua/sdk-js/generated-app",
        replacement: path.resolve(import.meta.dirname, "src/generated-app/index.ts"),
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
        find: "@honua/sdk-js/realtime",
        replacement: path.resolve(import.meta.dirname, "src/realtime/index.ts"),
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
        find: "@honua/sdk-js/web-components",
        replacement: path.resolve(import.meta.dirname, "src/web-components/index.ts"),
      },
      {
        find: "@honua/sdk-js/react",
        replacement: path.resolve(import.meta.dirname, "src/react/index.ts"),
      },
      {
        find: "@honua/sdk-js",
        replacement: path.resolve(import.meta.dirname, "src/index.ts"),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "test/react/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    globalSetup: ["test/prepared-sdk-artifacts.global-setup.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/**/*.ts",
        "examples/maplibre-quickstart/src/**/*.ts",
        "examples/storytelling-25d-map/src/**/*.ts",
      ],
      exclude: [
        "dist/**",
        "src/gen/**",
        "src/**/index.ts",
        "src/*-entry.ts",
        "src/honua.ts",
        "src/migration/cli.ts",
        "src/react/**",
        "examples/**/src/main.ts",
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 60,
        statements: 75,
      },
    },
    // Migration CLI tests execute one prepared dist tree and serialize their
    // child processes through the shared CLI lock. Keep file execution
    // serialized so the run-scoped SDK artifact remains immutable.
    fileParallelism: false,
    maxWorkers: ci ? 1 : undefined,
  },
});
