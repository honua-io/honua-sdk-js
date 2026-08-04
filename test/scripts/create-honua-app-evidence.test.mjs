import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CREATE_HONUA_APP_BUDGET_MS,
  CREATE_HONUA_APP_EVIDENCE_FORMAT,
  CREATE_HONUA_APP_STAGES,
  liveLaneEnabled,
  parseArgs,
  validateCreateHonuaAppEvidence,
} from "../../scripts/lib/create-honua-app-evidence.mjs";

function passedEvidence(overrides = {}) {
  return {
    format: CREATE_HONUA_APP_EVIDENCE_FORMAT,
    status: "passed",
    measurement: {
      budgetMs: CREATE_HONUA_APP_BUDGET_MS,
      elapsedMs: 61_000,
      withinBudget: true,
      scope: "scaffold-to-first-map",
      stages: CREATE_HONUA_APP_STAGES.map((name) => ({ name, elapsedMs: 12_000 })),
    },
    app: { template: "vanilla-ts", sdkPackage: "@honua/sdk-js", sdkVersion: "0.1.2-beta.0" },
    environment: { node: "v20.19.0", createHonuaAppVersion: "0.1.0", revision: "abc123" },
    journey: { mapMounted: true, renderedFeatureCount: 3, dataLane: "fixture", consoleErrors: [], externalRequests: [] },
    ...overrides,
  };
}

describe("create-honua-app evidence contract", () => {
  it("accepts a complete passing document", () => {
    assert.equal(validateCreateHonuaAppEvidence(passedEvidence()).status, "passed");
  });

  it("enforces the two-minute budget", () => {
    assert.equal(CREATE_HONUA_APP_BUDGET_MS, 120_000);
    const overBudget = passedEvidence();
    overBudget.measurement.elapsedMs = 130_000;
    assert.throws(() => validateCreateHonuaAppEvidence(overBudget), /withinBudget|within budget/);
  });

  it("requires every stage, in order", () => {
    const missingStage = passedEvidence();
    missingStage.measurement.stages = missingStage.measurement.stages.slice(1);
    assert.throws(() => validateCreateHonuaAppEvidence(missingStage), /stages must record every measurement stage/);
  });

  it("requires a rendered map with no console errors and no off-origin requests", () => {
    const noMap = passedEvidence();
    noMap.journey.mapMounted = false;
    assert.throws(() => validateCreateHonuaAppEvidence(noMap), /must report a mounted map/);

    const noFeatures = passedEvidence();
    noFeatures.journey.renderedFeatureCount = 0;
    assert.throws(() => validateCreateHonuaAppEvidence(noFeatures), /at least one feature/);

    const noisy = passedEvidence();
    noisy.journey.consoleErrors = ["boom"];
    assert.throws(() => validateCreateHonuaAppEvidence(noisy), /zero console errors/);

    const offOrigin = passedEvidence();
    offOrigin.journey.externalRequests = ["https://tiles.example/1.png"];
    assert.throws(() => validateCreateHonuaAppEvidence(offOrigin), /zero off-origin requests/);
  });

  it("requires a message on a failed document and a reason on a skip", () => {
    assert.throws(
      () => validateCreateHonuaAppEvidence(passedEvidence({ status: "failed", journey: undefined })),
      /failed evidence must include a failure message/,
    );
    assert.throws(
      () =>
        validateCreateHonuaAppEvidence({
          format: CREATE_HONUA_APP_EVIDENCE_FORMAT,
          status: "skipped",
        }),
      /skipped evidence must record a reason/,
    );
    assert.equal(
      validateCreateHonuaAppEvidence({
        format: CREATE_HONUA_APP_EVIDENCE_FORMAT,
        status: "skipped",
        skip: { reason: "network lane disabled" },
      }).status,
      "skipped",
    );
  });

  it("rejects a foreign format", () => {
    assert.throws(() => validateCreateHonuaAppEvidence(passedEvidence({ format: "other.v1" })), /format is invalid/);
  });
});

describe("create-honua-app runner arguments", () => {
  it("defaults the output path and template", () => {
    assert.deepEqual(parseArgs([]), {
      output: "test-results/create-honua-app-time-to-map.json",
      template: undefined,
      keepWorkspace: false,
    });
  });

  it("accepts the supported flags and rejects anything else", () => {
    assert.equal(parseArgs(["--template", "react-ts"]).template, "react-ts");
    assert.equal(parseArgs(["--output", "out.json"]).output, "out.json");
    assert.equal(parseArgs(["--keep-workspace"]).keepWorkspace, true);
    assert.throws(() => parseArgs(["--unknown"]), /Unknown or incomplete argument/);
  });

  it("keeps the registry lane opt-in", () => {
    assert.equal(liveLaneEnabled({}), false);
    assert.equal(liveLaneEnabled({ HONUA_CREATE_APP_LIVE_ENABLED: "false" }), false);
    assert.equal(liveLaneEnabled({ HONUA_CREATE_APP_LIVE_ENABLED: "true" }), true);
    assert.equal(liveLaneEnabled({ HONUA_CREATE_APP_LIVE_ENABLED: "1" }), true);
  });
});
