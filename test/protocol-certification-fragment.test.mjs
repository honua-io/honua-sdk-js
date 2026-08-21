import assert from "node:assert/strict";
import test from "node:test";

import { buildFragment, GAP_OWNER } from "../scripts/protocol-certification-fragment.mjs";

const identity = {
  clientVersion: "1.2.3",
  deploymentTarget: "local-docker",
  sourceSha: "a".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  fixtureRevision: "fixture-1",
  evidenceUri: "https://example.test/run/1",
};

test("normalizes execution and preserves missing operation gaps", () => {
  const fragment = buildFragment({
    identity,
    now: "2026-08-20T00:00:00.000Z",
    reports: [{ testResults: [{
      name: "test/integration/surfaces/feature-service.integration.ts",
      assertionResults: [
        { title: "returns metadata", status: "passed" },
        { title: "queries features", status: "failed", failureMessages: ["boom"] },
      ],
    }] }],
  });

  assert.equal(fragment.complete, true);
  assert.equal(fragment.observations.find((row) => row.surface === "featureserver" && row.operation === "metadata").result, "pass");
  assert.deepEqual(fragment.observations.find((row) => row.surface === "featureserver" && row.operation === "query").failure_messages, ["boom"]);
  const missing = fragment.observations.find((row) => row.surface === "wcs" && row.operation === "get-coverage");
  assert.equal(missing.result, "skip");
  assert.match(missing.skip_reason, new RegExp(GAP_OWNER));
});

test("marks evidence incomplete when a suite report is unavailable", () => {
  const fragment = buildFragment({
    identity,
    complete: false,
    reports: [],
    now: "2026-08-20T00:00:00.000Z",
  });

  assert.equal(fragment.complete, false);
  assert.ok(fragment.observations.every((row) => row.result === "skip"));
});
