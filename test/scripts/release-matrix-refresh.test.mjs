// The release-matrix receipt expires seven days after its observation, and
// only first-map-release-smoke.yml renews it. Release Please dispatches that
// smoke at release time, so without a refresh between releases the docs site
// and strict sample verification go red a week after every release. These
// tests pin the refresh decision and the regeneration workflow that acts on it.
// The trunk-moved re-entry is executed in reseal-token-lifetime.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  RELEASE_MATRIX_REFRESH_LEAD_MS,
  releaseMatrixRefreshDue,
} from "../../scripts/release-matrix-refresh-due.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/regenerate-derived-artifacts.yml"), "utf8");
const HOUR = 60 * 60 * 1000;

function receipt(expiresAt, status = "passed") {
  return { status, observedAt: new Date(Date.parse(expiresAt) - 7 * 24 * HOUR).toISOString(), expiresAt };
}

describe("release-matrix refresh decision", () => {
  const now = "2026-11-21T12:00:00.000Z";

  it("is due inside the lead window before expiry", () => {
    const decision = releaseMatrixRefreshDue(receipt("2026-11-22T12:00:00.000Z"), { now });
    assert.equal(decision.due, true);
    assert.match(decision.reason, /expires in 24\.0 h/u);
  });

  it("is due once the receipt has expired", () => {
    const decision = releaseMatrixRefreshDue(receipt("2026-11-21T11:00:00.000Z"), { now });
    assert.equal(decision.due, true);
    assert.match(decision.reason, /expired/u);
  });

  it("is not due while more than the lead window remains", () => {
    const decision = releaseMatrixRefreshDue(receipt("2026-11-24T12:00:00.000Z"), { now });
    assert.equal(decision.due, false);
  });

  it("does not re-run a fresh failed matrix, so a red receipt cannot loop the smoke", () => {
    const decision = releaseMatrixRefreshDue(receipt("2026-11-27T12:00:00.000Z", "failed"), { now });
    assert.equal(decision.due, false);
  });

  it("is not due without a readable receipt", () => {
    assert.equal(releaseMatrixRefreshDue(undefined, { now }).due, false);
    assert.equal(releaseMatrixRefreshDue({ expiresAt: "not a time" }, { now }).due, false);
  });

  it("leads by two days, longer than the six-hour regeneration cadence", () => {
    assert.equal(RELEASE_MATRIX_REFRESH_LEAD_MS, 48 * HOUR);
  });
});

const dispatchStep = parse(workflow).jobs["commit-and-validate"].steps.find(
  (candidate) => candidate.name === "Dispatch strict trunk CI and docs validation",
);

// A scratch checkout holding the refresh script, a receipt that expires
// `hoursLeft` hours from now, and a stub gh that records its arguments.
function scratchCheckout(dir, hoursLeft) {
  const evidence = path.join(dir, "samples/evidence/maplibre-quickstart");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(evidence, { recursive: true });
  fs.copyFileSync(
    path.join(root, "scripts/release-matrix-refresh-due.mjs"),
    path.join(dir, "scripts/release-matrix-refresh-due.mjs"),
  );
  const expiresAt = new Date(Date.now() + hoursLeft * HOUR).toISOString();
  fs.writeFileSync(path.join(evidence, "release-matrix.v1.json"), JSON.stringify(receipt(expiresAt)));
  const gh = `#!/bin/bash\nprintf '%s\\n' "$*" >> "$TRACE"\n[[ "$1 $2" != "run list" ]] || echo "$ACTIVE"\n`;
  fs.writeFileSync(path.join(dir, "bin/gh"), gh, { mode: 0o755 });
}

// Executes the dispatch step in a scratch checkout; returns the gh calls.
function runDispatchStep(hoursLeft, activeSmokes = "0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-matrix-refresh-"));
  try {
    scratchCheckout(dir, hoursLeft);
    const trace = path.join(dir, "trace");
    const result = spawnSync("bash", ["-c", dispatchStep.run], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
        TRACE: trace,
        ACTIVE: activeSmokes,
        GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(trace, "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("regeneration workflow keeps the release-matrix receipt fresh", () => {
  it("dispatches the release smoke at trunk when the receipt is due", () => {
    const trace = runDispatchStep(-1);
    assert.match(trace, /workflow run ci\.yml[\s\S]*workflow run docs-site\.yml/u);
    assert.match(trace, /run list --repo honua-io\/honua-sdk-js --workflow first-map-release-smoke\.yml/u);
    assert.match(trace, /workflow run first-map-release-smoke\.yml --repo honua-io\/honua-sdk-js --ref trunk/u);
  });

  it("leaves a current receipt alone", () => {
    assert.doesNotMatch(runDispatchStep(72), /first-map-release-smoke/u);
  });

  it("does not stack a second smoke on one already queued or running", () => {
    const trace = runDispatchStep(12, "1");
    assert.match(trace, /run list/u);
    assert.doesNotMatch(trace, /workflow run first-map-release-smoke/u);
  });
});
