import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { firstMapExecutionVerdict } from "../../scripts/lib/first-map-execution-budget.mjs";
const budget = JSON.parse(readFileSync(new URL("../../config/first-map-execution-budget.v1.json", import.meta.url)));
const execution = { host: { platform: "linux", architecture: "x64", cpu: "any provisioned x64 CPU" }, runnerImage: "ubuntu24", browser: "145.0.7632.6", repetitions: 3, cpuThrottle: 4,
  samples: [{ scriptCpuMs: 134.518, parseCompileMs: 97.483 }, { scriptCpuMs: 122.351, parseCompileMs: 76.504 }, { scriptCpuMs: 139.612, parseCompileMs: 80.796 }] };
test("calibrated median passes and preserves observed costs", () => {
  const result = firstMapExecutionVerdict(execution, budget);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.measured, { medianScriptCpuMs: 134.518, medianParseCompileMs: 80.796 });
});
test("script and parse regressions independently fail", () => {
  for (const metric of ["scriptCpuMs", "parseCompileMs"]) {
    const changed = structuredClone(execution);
    for (const sample of changed.samples) sample[metric] = 1000;
    assert.equal(firstMapExecutionVerdict(changed, budget).status, "failed");
  }
});
test("missing, nonfinite and nonpositive evidence fails", () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const changed = structuredClone(execution);
    changed.samples[0].scriptCpuMs = value;
    assert.equal(firstMapExecutionVerdict(changed, budget).status, "failed");
  }
});
test("changed browser, image, throttle or sample count fails profile admission", () => {
  for (const [field, value] of [["browser", "146.0"], ["runnerImage", "ubuntu26"], ["cpuThrottle", 1], ["repetitions", 1], ["samples", []]]) {
    assert.equal(firstMapExecutionVerdict({ ...execution, [field]: value }, budget).status, "failed");
  }
});
