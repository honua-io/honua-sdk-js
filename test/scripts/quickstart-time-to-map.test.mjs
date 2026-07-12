import assert from "node:assert/strict";
import test from "node:test";

import {
  QUICKSTART_BUDGET_MS,
  QUICKSTART_STAGES,
  parseArgs,
  validateQuickstartEvidence,
} from "../../scripts/quickstart-time-to-map.mjs";

function passingEvidence() {
  return {
    format: "honua.sdk.quickstart-time-to-map.v1",
    status: "passed",
    measurement: { budgetMs: QUICKSTART_BUDGET_MS, elapsedMs: 42_000, withinBudget: true },
    journey: {
      mode: "fixture",
      journeyComplete: true,
      completedStages: QUICKSTART_STAGES,
      mountedCanvas: true,
      renderableFeatureCount: 3,
    },
  };
}

test("parses output and an external monotonic start", () => {
  assert.deepEqual(parseArgs(["--started-at-monotonic-ms", "1200", "--output", "result.json"]), {
    startedAtMonotonicMs: 1200,
    output: "result.json",
  });
});

test("rejects malformed arguments", () => {
  assert.throws(() => parseArgs(["--started-at-monotonic-ms", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--budget-ms", "999999"]), /Unknown or incomplete argument/);
});

test("accepts complete fixture-map evidence", () => {
  const evidence = passingEvidence();
  assert.equal(validateQuickstartEvidence(evidence), evidence);
});

test("rejects a timing claim before the map is usable", () => {
  const evidence = passingEvidence();
  evidence.journey.mountedCanvas = false;
  assert.throws(() => validateQuickstartEvidence(evidence), /MapLibre canvas must be mounted/);
});

test("rejects incomplete stages and a mutable budget", () => {
  const evidence = passingEvidence();
  evidence.measurement.budgetMs = 600_000;
  evidence.journey.completedStages = QUICKSTART_STAGES.slice(0, -1);
  assert.throws(() => validateQuickstartEvidence(evidence), /budget must be 300000ms.*all five journey stages/);
});
