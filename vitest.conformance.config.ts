import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Live conformance lane: round-trips the shared geospatial-grpc conformance
 * fixtures through the real `HonuaClient` against a pinned, live
 * `honua-server` (see `.github/workflows/integration.yml` → conformance job
 * and `test/conformance/`). Double-gated on `HONUA_INTEGRATION_BASE_URL`
 * (live server) and `HONUA_CONFORMANCE_FIXTURES_DIR` (fetched fixtures); when
 * either is unset every suite degrades to an explicit `describe.skip`.
 *
 * Reuses the integration lane's global setup so the same
 * `test-results/integration-meta.json` records the pinned server image,
 * server commit/version, and the conformance surfaces (REQ-002).
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@honua/sdk-js/contract",
        replacement: path.resolve(import.meta.dirname, "src/contract/index.ts"),
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
    include: ["test/conformance/**/*.conformance.ts"],
    exclude: ["dist/**", "node_modules/**"],
    globalSetup: ["test/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
