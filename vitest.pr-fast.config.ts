import { defineConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

/**
 * A representative, deterministic smoke tier for early pull-request feedback.
 * The complete unit/coverage suite remains required in `.github/workflows/ci.yml`.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      "test/core-client.test.ts",
      "test/benchmark-lab.test.ts",
      "test/error-hierarchy.test.ts",
      "test/expr.test.ts",
      "test/query-builder.test.ts",
      "test/pr-fast-runner.test.ts",
      "test/realtime.test.ts",
      "test/live-benchmark-evidence.test.ts",
      "test/runtime-style-interactions.test.ts",
      "test/stream-perf-bench.test.ts",
      "test/contract/conformance.test.ts",
      "test/contract/geoservices-conformance.test.ts",
      "test/contract/odata-conformance.test.ts",
      "test/contract/ogc-conformance.test.ts",
      "test/contract/stac.test.ts",
      "test/contract/wfs.test.ts",
    ],
    fileParallelism: true,
    maxWorkers: 4,
  },
});
