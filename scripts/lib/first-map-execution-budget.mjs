import assert from "node:assert/strict";

export function firstMapExecutionVerdict(execution, budget) {
  assert.equal(budget.schema, "honua.first-map-execution-budget/v1");
  const violations = [];
  for (const field of ["platform", "architecture"]) {
    if (execution.host?.[field] !== budget[field]) violations.push(`execution host ${field} differs from calibrated profile`);
  }
  if (execution.runnerImage !== budget.runnerImage) violations.push("runner image differs from calibrated profile");
  if (Number.parseInt(execution.browser, 10) !== budget.browserMajor) violations.push("browser major differs from calibrated profile");
  for (const field of ["cpuThrottle", "repetitions"]) {
    if (execution[field] !== budget[field]) violations.push(`${field} differs from calibrated profile`);
  }
  const samples = execution.samples ?? [];
  if (samples.length !== budget.repetitions) violations.push("execution sample count differs from calibrated profile");
  const measured = {};
  for (const [metric, ceiling] of [["scriptCpuMs", "medianScriptCpuMs"], ["parseCompileMs", "medianParseCompileMs"]]) {
    assert.ok(Number.isFinite(budget[ceiling]) && budget[ceiling] > 0, `${ceiling} must be positive`);
    const values = samples.map((sample) => sample[metric]).sort((a, b) => a - b);
    if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) {
      violations.push(`${metric} samples must be finite and positive`);
      continue;
    }
    const middle = Math.floor(values.length / 2);
    measured[ceiling] = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    if (measured[ceiling] > budget[ceiling]) violations.push(`${ceiling} exceeds ${budget[ceiling]} ms`);
  }
  return { status: violations.length ? "failed" : "passed", profile: budget.profile, measured, budget, violations };
}
