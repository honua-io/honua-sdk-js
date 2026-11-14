import { expect, it } from "vitest";

import { runSpatialAnalyticsCycles } from "../bench/spatial-analytics-bench.js";

it("keeps repeated bounded-local fixture execution deterministic", async () => {
  const result = await runSpatialAnalyticsCycles(100);
  expect(result.fingerprintCount).toBe(1);
  expect(result.rowsValid).toBe(true);
});
