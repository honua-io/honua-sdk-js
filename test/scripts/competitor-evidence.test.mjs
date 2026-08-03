/**
 * Competitor-evidence contract tests (honua-io/honua-sdk-js#499).
 *
 * The issue's Validation section requires negative coverage for expired,
 * missing-version, non-primary-source and non-comparable-metric records, plus
 * proof that a historical observation cannot back a current claim (REQ-006).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CompetitorEvidenceError,
  EVIDENCE_FORMAT,
  assertComparableMetrics,
  loadCompetitorEvidence,
  requireCurrentEvidence,
  validateCompetitorEvidence,
} from "../../scripts/lib/competitor-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A minimal, fully valid document. Each negative test damages exactly one field. */
function validDocument() {
  return {
    format: EVIDENCE_FORMAT,
    categories: {
      "headless-service-client": { label: "Headless service clients", definition: "Clients without a renderer." },
    },
    records: [
      {
        id: "example-client-scope",
        product: "Example Client",
        package: "@example/client",
        category: "headless-service-client",
        versionLine: "1.2.3",
        claim: "Example Client is a headless service client.",
        sourceUrl: "https://example.invalid/docs/client",
        sourceType: "primary",
        primarySourcePrefixes: ["https://example.invalid/"],
        observedAt: "2026-01-01",
        retrievedAt: "2026-01-02",
        expiresAt: "2027-01-01",
        methodology: "Read from the product's official documentation.",
        metrics: [{ key: "latestVersion", label: "Latest version", value: "1.2.3", unit: "release-line", compression: "not-applicable" }],
        comparability: "Same category as @honua/sdk-js.",
      },
    ],
  };
}

const NOW = "2026-08-02";
const validate = (document, now = NOW) => validateCompetitorEvidence(document, { now, rootDir: ROOT });

test("the committed evidence document is valid today", () => {
  const evidence = loadCompetitorEvidence({ rootDir: ROOT, now: NOW });
  assert.ok(evidence.records.length > 0);
  for (const record of evidence.records) {
    assert.equal(record.sourceType, "primary");
    assert.ok(record.versionLine.length > 0, `${record.id} must name a version line`);
    for (const metric of record.metrics) {
      assert.ok(metric.unit, `${record.id}/${metric.key} must declare a unit`);
      assert.ok(metric.compression, `${record.id}/${metric.key} must declare compression`);
    }
  }
});

test("a fixture document with every required field validates", () => {
  const evidence = validate(validDocument());
  assert.equal(evidence.records.length, 1);
  assert.ok(evidence.byId.has("example-client-scope"));
});

// --- negative case: expired -------------------------------------------------

test("an expired record fails validation", () => {
  const document = validDocument();
  document.records[0].expiresAt = "2026-07-01";
  assert.throws(
    () => validate(document),
    (error) => error instanceof CompetitorEvidenceError && /expired on 2026-07-01/.test(error.message),
  );
});

test("a record expiring in the future still validates", () => {
  const document = validDocument();
  document.records[0].expiresAt = "2026-08-03";
  assert.ok(validate(document).byId.has("example-client-scope"));
});

// --- negative case: missing version -----------------------------------------

test("a record with no version line fails validation", () => {
  const document = validDocument();
  delete document.records[0].versionLine;
  assert.throws(() => validate(document), /schema validation/);
});

test("a record with an empty version line fails validation", () => {
  const document = validDocument();
  document.records[0].versionLine = "";
  assert.throws(() => validate(document), /schema validation/);
});

// --- negative case: non-primary source --------------------------------------

test("a source URL outside the declared primary prefixes fails validation", () => {
  const document = validDocument();
  document.records[0].sourceUrl = "https://some-blog.invalid/post/restating-the-vendor-number";
  assert.throws(
    () => validate(document),
    (error) => error instanceof CompetitorEvidenceError && /not under a declared primary-source prefix/.test(error.message),
  );
});

test("a record declared secondary may not be projected", () => {
  const document = validDocument();
  document.records[0].sourceType = "secondary";
  assert.throws(() => validate(document), /only primary sources may be projected/);
});

// --- negative case: non-comparable metrics ----------------------------------

test("combining metrics with different compression without a caveat throws", () => {
  assert.throws(
    () =>
      assertComparableMetrics(
        [
          { key: "a", unit: "MB", compression: "none" },
          { key: "b", unit: "MB", compression: "gzip" },
        ],
        { context: "test" },
      ),
    (error) => error instanceof CompetitorEvidenceError && /non-comparable metrics/.test(error.message),
  );
});

test("combining metrics with different units without a caveat throws", () => {
  assert.throws(
    () =>
      assertComparableMetrics([
        { key: "a", unit: "MB", compression: "none" },
        { key: "b", unit: "seconds", compression: "not-applicable" },
      ]),
    /non-comparable metrics/,
  );
});

test("non-comparable metrics are permitted only with an explicit caveat", () => {
  const result = assertComparableMetrics(
    [
      { key: "a", unit: "MB", compression: "none" },
      { key: "b", unit: "MB", compression: "gzip" },
    ],
    { caveat: "Different compression; reported side by side, never divided." },
  );
  assert.equal(result.comparable, false);
  assert.match(result.caveat, /side by side/);
});

test("metrics sharing unit and compression are comparable", () => {
  const result = assertComparableMetrics([
    { key: "a", unit: "KiB", compression: "gzip" },
    { key: "b", unit: "KiB", compression: "gzip" },
  ]);
  assert.equal(result.comparable, true);
});

// --- REQ-006: historical evidence cannot back a current claim ---------------

test("a historical record is refused for a current claim", () => {
  const record = { id: "old", product: "Example", versionLine: "1.0", observedAt: "2024-01-01", historical: true };
  assert.throws(
    () => requireCurrentEvidence(record, { claimKind: "current ratio" }),
    (error) => error instanceof CompetitorEvidenceError && /may not support a current ratio/.test(error.message),
  );
});

test("a current record is returned unchanged for a current claim", () => {
  const record = { id: "new", product: "Example", versionLine: "2.0", observedAt: "2026-08-01" };
  assert.equal(requireCurrentEvidence(record), record);
});

test("a historical record must explain why it is superseded", () => {
  const document = validDocument();
  document.records[0].historical = true;
  assert.throws(() => validate(document), /schema validation|must explain why/);
});

test("the committed @arcgis/core build metrics are labelled historical and are not current evidence", () => {
  const evidence = loadCompetitorEvidence({ rootDir: ROOT, now: NOW });
  const record = evidence.byId.get("arcgis-core-4-30-core-sample-build-metrics");
  assert.ok(record, "the @arcgis/core build-metrics record must exist");
  assert.equal(record.historical, true);
  assert.ok(record.historicalReason.length > 0);
  assert.throws(() => requireCurrentEvidence(record, { claimKind: "current ratio" }), CompetitorEvidenceError);
});

// --- structural integrity ---------------------------------------------------

test("an unknown category is rejected", () => {
  const document = validDocument();
  document.records[0].category = "not-declared";
  assert.throws(() => validate(document), /unknown category/);
});

test("duplicate record ids are rejected", () => {
  const document = validDocument();
  document.records.push({ ...document.records[0] });
  assert.throws(() => validate(document), /duplicate evidence record id/);
});

test("a wrong format string is rejected", () => {
  const document = validDocument();
  document.format = "honua.sdk.competitor-evidence.v2";
  assert.throws(() => validate(document), /schema validation|format must be/);
});

test("supersededBy must reference a real record", () => {
  const document = validDocument();
  document.records[0].supersededBy = "does-not-exist";
  assert.throws(() => validate(document), /references unknown record/);
});

test("page generation itself fails once the committed evidence expires", async () => {
  const { buildPage } = await import("../../scripts/generate-comparison-page.mjs");
  // Every committed record expires well before 2030, so generation at that
  // instant must refuse rather than publish a stale external claim (NFR-002).
  assert.throws(
    () => buildPage(ROOT, { now: "2030-01-01" }),
    (error) => error instanceof CompetitorEvidenceError && /expired on/.test(error.message),
  );
  assert.equal(typeof buildPage(ROOT, { now: NOW }), "string");
});

test("the generated comparison page projects the evidence and states no current ratio", () => {
  const page = fs.readFileSync(path.join(ROOT, "docs", "comparison.md"), "utf8");
  assert.match(page, /Historical evidence/);
  assert.match(page, /no current claim rests on it/);
  // The pre-#499 page derived a current superiority ratio from the 2024 4.30
  // measurement. It must not come back.
  assert.equal(/roughly a third of the JavaScript/.test(page), false);
  assert.match(page, /## Operation-level behaviour/);
  assert.match(page, /## What is being compared/);
  assert.match(page, /### Evidence contract/);
});
