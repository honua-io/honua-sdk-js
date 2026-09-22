import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFirstMapBudget, firstMapVerdict } from "../../scripts/lib/first-map-budget.mjs";

test("the frozen byte ceilings include the boundary and reject either overage", () => {
  assert.equal(evaluateFirstMapBudget({ javascriptBytes: 1_990_000, javascriptGzipBytes: 524_000 }), "passed");
  assert.equal(evaluateFirstMapBudget({ javascriptBytes: 1_990_001, javascriptGzipBytes: 524_000 }), "failed");
  assert.equal(evaluateFirstMapBudget({ javascriptBytes: 1_990_000, javascriptGzipBytes: 524_001 }), "failed");
});

test("a successful build under a raised Vite ceiling cannot emit a passing receipt", () => {
  assert.deepEqual(firstMapVerdict({ buildStatus: "passed", peerIdentityStatus: "passed",
    measurement: { javascriptBytes: 2_037_902, javascriptGzipBytes: 547_069 } }),
  { budgetStatus: "failed", status: "failed" });
});

test("missing, empty, nonfinite and fractional measurements fail closed", () => {
  for (const value of [undefined, 0, -1, NaN, Infinity, 1.5, "1"]) {
    assert.equal(evaluateFirstMapBudget({ javascriptBytes: value, javascriptGzipBytes: 1 }), "failed");
    assert.equal(evaluateFirstMapBudget({ javascriptBytes: 1, javascriptGzipBytes: value }), "failed");
  }
});

test("passing bytes cannot hide a failed build or mixed peer graph", () => {
  const measurement = { javascriptBytes: 1_979_893, javascriptGzipBytes: 523_377 };
  for (const [buildStatus, peerIdentityStatus] of [["failed", "passed"], ["passed", "failed"]]) {
    assert.equal(firstMapVerdict({ buildStatus, peerIdentityStatus, measurement }).status, "failed");
  }
  assert.equal(firstMapVerdict({ buildStatus: "passed", peerIdentityStatus: "passed", measurement }).status, "passed");
});
