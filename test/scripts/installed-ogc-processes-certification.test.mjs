import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { observationsFromQualification } from "../../scripts/installed-ogc-processes-certification.mjs";

test("maps passing live evidence onto the shared installed-certification denominator", () => {
  const observations = observationsFromQualification(
    {
      result: "passed",
      format: "honua.sdk.ogc-processes-candidate-qualification.v1",
      fixture: { sha256: "fixture-digest" },
    },
    "artifact://packet-92/ogc-processes-candidate-qualification.json",
  );
  assert.equal(observations.length, 6);
  assert(observations.every((row) => row.verdict === "pass"));
  assert(observations.some((row) => row.id === "sdk-operation:ogc-processes-execution-standalone:processes"));
  assert.deepEqual(new Set(observations.map((row) => row.diagnostic.evidenceUri)), new Set(["artifact://packet-92/ogc-processes-candidate-qualification.json"]));
  const serializedEvidence = `${JSON.stringify(
    {
      result: "passed",
      format: "honua.sdk.ogc-processes-candidate-qualification.v1",
      fixture: { sha256: "fixture-digest" },
    },
    null,
    2,
  )}\n`;
  assert.equal(
    observations[0].diagnostic.evidenceSha256,
    `sha256:${createHash("sha256").update(serializedEvidence).digest("hex")}`,
  );
});

test("refuses to project a non-passing qualification", () => {
  assert.throws(() => observationsFromQualification({ result: "failed" }, "artifact://receipt"), /did not pass/);
});
