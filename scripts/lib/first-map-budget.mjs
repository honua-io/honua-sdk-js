// PR #2010: after renderer tree-shaking, MapLibre 6.14.0 measures 524,289 gzip
// bytes in CI. Approved 1,000-byte adjustment; raw-byte and CPU ceilings stay fixed.
// PR #2068: complete-set gRPC aggregation adds no dependencies. The packed CI
// consumer measures 525,579 gzip bytes (525,608 with the execution fixture).
// A further 1,000-byte adjustment preserves raw-byte, CPU, parse and peer guards.
export const INSTALLED_FIRST_MAP_BUDGET = Object.freeze({
  javascriptBytes: 1_990_000,
  javascriptGzipBytes: 526_000,
});

// The receipt must enforce the reviewed canonical limits even when the example's
// current build configuration permits a larger bundle.
export function evaluateFirstMapBudget(measurement) {
  return Object.entries(INSTALLED_FIRST_MAP_BUDGET).every(([key, ceiling]) =>
    Number.isSafeInteger(measurement?.[key]) && measurement[key] > 0 && measurement[key] <= ceiling,
  ) ? "passed" : "failed";
}

export function firstMapVerdict(observed) {
  const budgetStatus = evaluateFirstMapBudget(observed.measurement);
  return {
    budgetStatus,
    status: observed.buildStatus === "passed" && observed.peerIdentityStatus === "passed" && budgetStatus === "passed"
      ? "passed" : "failed",
  };
}
