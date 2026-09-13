export const INSTALLED_FIRST_MAP_BUDGET = Object.freeze({
  javascriptBytes: 1_990_000,
  javascriptGzipBytes: 524_000,
});

// The receipt must enforce the issue's frozen limits even when the example's
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
