import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CREATE_HONUA_APP_BUDGET_MS,
  CREATE_HONUA_APP_EVIDENCE_FORMAT,
  CREATE_HONUA_APP_STAGES,
  liveLaneEnabled,
  parseArgs,
  validateCreateHonuaAppEvidence,
  verifyRegistryInstall,
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
      sdkVersion: undefined,
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

  it("accepts only a single exact SDK override", () => {
    assert.equal(parseArgs(["--sdk-version", "0.2.1"]).sdkVersion, "0.2.1");
    for (const value of ["latest", "^0.2.1", "0.2", " 0.2.1", "0.2.1\n", "--keep-workspace"]) {
      assert.throws(() => parseArgs(["--sdk-version", value]), /exact version/);
    }
    assert.throws(() => parseArgs(["--sdk-version"]), /exact version/);
    assert.throws(() => parseArgs(["--sdk-version", "0.2.1", "--sdk-version", "0.2.2"]), /exact version/);
  });
});

function installedFixture() {
  const packageName = "@honua/sdk-js";
  const version = "0.2.1";
  const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  const tarball = "https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-0.2.1.tgz";
  return {
    packageName, version,
    metadata: { name: packageName, version, gitHead: "a".repeat(40), dist: { integrity, tarball } },
    installed: { name: packageName, version },
    lock: { packages: { "": { dependencies: { [packageName]: version } },
      [`node_modules/${packageName}`]: { version, integrity, resolved: tarball } } },
  };
}

describe("explicit scaffold registry certification", () => {
  it("binds the installed exact package, source and integrity", () => {
    const proof = verifyRegistryInstall(installedFixture());
    assert.equal(proof.version, "0.2.1");
    assert.equal(proof.sourceRevision, "a".repeat(40));
    const evidence = passedEvidence();
    evidence.app.sdkVersion = "0.2.1";
    evidence.requestedSdkVersion = "0.2.1";
    evidence.registryInstall = proof;
    assert.equal(validateCreateHonuaAppEvidence(evidence).status, "passed");
    for (const field of ["package", "version", "sourceRevision", "integrity", "tarball", "defaultPeerResolution"]) {
      const missing = structuredClone(evidence);
      delete missing.registryInstall[field];
      assert.throws(() => validateCreateHonuaAppEvidence(missing), /registry install proof/);
    }
    delete evidence.registryInstall;
    assert.throws(() => validateCreateHonuaAppEvidence(evidence), /registry install proof/);
  });

  it("refuses registry, installed package and lock substitution", () => {
    const mutations = [
      (f) => { f.metadata.name = "other"; },
      (f) => { f.metadata.version = "0.2.2"; },
      (f) => { f.metadata.gitHead = "trunk"; },
      (f) => { f.metadata.dist.integrity = "sha1-invalid"; },
      (f) => { f.metadata.dist.tarball = "https://registry.npmjs.org.evil.test/other.tgz"; },
      (f) => { f.installed.version = "0.2.0"; },
      (f) => { f.installed.name = "other"; },
      (f) => { f.lock.packages[""].dependencies[f.packageName] = "^0.2.1"; },
      (f) => { f.lock.packages[`node_modules/${f.packageName}`].integrity = `sha512-${Buffer.alloc(64, 8).toString("base64")}`; },
      (f) => { f.lock.packages[`node_modules/${f.packageName}`].version = "0.2.0"; },
      (f) => { f.lock.packages[`node_modules/${f.packageName}`].resolved = "file:../sdk.tgz"; },
      (f) => { f.lock.packages[`node_modules/${f.packageName}`].link = true; },
    ];
    for (const mutate of mutations) {
      const fixture = installedFixture();
      mutate(fixture);
      assert.throws(() => verifyRegistryInstall(fixture));
    }
  });

  it("executes the workflow shell with safely separated optional inputs", () => {
    const workflow = fs.readFileSync(new URL("../../.github/workflows/create-honua-app-live.yml", import.meta.url), "utf8");
    const block = workflow.split("      - name: Measure scaffold to first map\n")[1].split("\n      - name:")[0];
    const shell = block.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^          /, "")).join("\n");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-workflow-"));
    try {
      fs.writeFileSync(path.join(directory, "npm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENT_FILE"\n', { mode: 0o755 });
      for (const [template, version, expected] of [
        ["", "", ["run", "create-app:time-to-map", "--"]],
        ["react-ts", "0.2.1", ["run", "create-app:time-to-map", "--", "--template", "react-ts", "--sdk-version", "0.2.1"]],
        ["", '$(touch injected)', ["run", "create-app:time-to-map", "--", "--sdk-version", '$(touch injected)']],
      ]) {
        const argumentFile = path.join(directory, "args");
        execFileSync("bash", ["--noprofile", "--norc", "-c", shell], { cwd: directory,
          env: { PATH: `${directory}:${process.env.PATH}`, ARGUMENT_FILE: argumentFile, CREATE_APP_TEMPLATE: template, CREATE_APP_SDK_VERSION: version } });
        assert.deepEqual(fs.readFileSync(argumentFile, "utf8").trimEnd().split("\n"), expected);
        assert.equal(fs.existsSync(path.join(directory, "injected")), false);
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
