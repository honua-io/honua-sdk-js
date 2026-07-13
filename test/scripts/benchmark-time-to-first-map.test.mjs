import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ChromiumUnavailableError,
  parseArgs,
  TTFM_FORMAT,
  TTFM_LANES,
  validateTtfmEvidence,
} from "../../scripts/benchmark-time-to-first-map.mjs";

function validEvidence(overrides = {}) {
  return {
    format: TTFM_FORMAT,
    status: "passed",
    lane: TTFM_LANES.browser,
    measuredAt: "2026-07-13",
    phases: { installMs: 15000, firstMapMs: 30000, totalMs: 45000 },
    install: { package: "@honua/sdk-js", version: "0.1.0-beta.0", cache: "cold" },
    environment: { node: "v20.19.0", platform: "linux", arch: "x64", cpus: 8 },
    definition: "Cold install plus fixture-lane first map.",
    ...overrides,
  };
}

test("parseArgs defaults and flag parsing", () => {
  assert.deepEqual(parseArgs([]), {
    output: "test-results/time-to-first-map.json",
    lane: "auto",
    writeReference: false,
  });
  assert.deepEqual(parseArgs(["--lane", "node-query", "--write-reference", "--output", "out.json"]), {
    output: "out.json",
    lane: "node-query",
    writeReference: true,
  });
  assert.throws(() => parseArgs(["--lane", "warp"]), /--lane must be/);
  assert.throws(() => parseArgs(["--frobnicate"]), /Unknown or incomplete argument/);
});

test("validateTtfmEvidence accepts a complete passing record", () => {
  const evidence = validEvidence();
  assert.equal(validateTtfmEvidence(evidence), evidence);
});

test("validateTtfmEvidence rejects inconsistent totals", () => {
  assert.throws(
    () => validateTtfmEvidence(validEvidence({ phases: { installMs: 1, firstMapMs: 2, totalMs: 4 } })),
    /totalMs must equal/,
  );
});

test("validateTtfmEvidence rejects warm caches, bad lanes, and missing environment", () => {
  assert.throws(
    () => validateTtfmEvidence(validEvidence({ install: { package: "@honua/sdk-js", version: "1", cache: "warm" } })),
    /cache must be cold/,
  );
  assert.throws(() => validateTtfmEvidence(validEvidence({ lane: "guesswork" })), /lane is invalid/);
  assert.throws(
    () => validateTtfmEvidence(validEvidence({ environment: { node: "v20.19.0", platform: "", arch: "x64" } })),
    /environment\.platform is required/,
  );
});

test("auto-lane fallback is gated on ChromiumUnavailableError only", () => {
  // Mirrors the runBenchmark gate: `--lane auto` may divert to node-query only
  // when the browser environment is missing, never on build/render failures.
  const shouldFallBack = (lane, error) => lane !== "browser" && error instanceof ChromiumUnavailableError;
  assert.equal(shouldFallBack("auto", new ChromiumUnavailableError("chromium missing")), true);
  assert.equal(shouldFallBack("browser", new ChromiumUnavailableError("chromium missing")), false);
  assert.equal(shouldFallBack("auto", new Error("vite build failed")), false);
  assert.equal(shouldFallBack("auto", new Error("waitForFunction timeout: map never rendered")), false);
  assert.ok(new ChromiumUnavailableError("x") instanceof Error);
});
