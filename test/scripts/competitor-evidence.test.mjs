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
  OPERATION_KEYS,
  TRUSTED_PRIMARY_SOURCE_PREFIXES,
  assertComparableMetrics,
  loadCompetitorEvidence,
  operationCell,
  projectEvidence,
  requireCurrentEvidence,
  requireFreshEvidence,
  validateCompetitorEvidence,
} from "../../scripts/lib/competitor-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A minimal, fully valid document. Each negative test damages exactly one field. */
function validDocument() {
  return {
    format: EVIDENCE_FORMAT,
    categories: {
      "renderer-engine": { label: "Renderer engines", definition: "Engines that draw maps." },
    },
    records: [
      {
        id: "openlayers-example",
        product: "OpenLayers",
        package: "ol",
        category: "renderer-engine",
        versionLine: "10.10.0",
        claim: "OpenLayers is a map rendering library.",
        sourceUrl: "https://openlayers.org/doc/",
        sourceType: "primary",
        supportingSources: [
          {
            url: "https://registry.npmjs.org/ol",
            sourceType: "primary",
            supports: ["versionLine", "metric:latestVersion"],
          },
        ],
        observedAt: "2026-01-01",
        retrievedAt: "2026-01-02",
        expiresAt: "2027-01-01",
        methodology: "Read from the product's official documentation.",
        metrics: [{ key: "latestVersion", label: "Latest version", value: "10.10.0", unit: "release-line", compression: "not-applicable" }],
        comparability: "A renderer engine, not a headless client.",
      },
    ],
  };
}

const NOW = "2026-08-23";
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
  assert.ok(evidence.byId.has("openlayers-example"));
});

// --- negative case: expired --------------------------------------------------
// Freshness is enforced where the requirement puts it: on a PROJECTED claim.
// An archived observation is allowed to age, otherwise the documented recovery
// ("add a new observation, never rewrite the old one") could never work.

test("an expired record is marked expired but does not reject the document", () => {
  const document = validDocument();
  document.records[0].expiresAt = "2026-07-01";
  const evidence = validate(document);
  assert.equal(evidence.byId.get("openlayers-example").expired, true);
});

test("projecting an expired record fails", () => {
  const document = validDocument();
  document.records[0].expiresAt = "2026-07-01";
  const evidence = validate(document);
  assert.throws(
    () => projectEvidence(evidence, "openlayers-example"),
    (error) => error instanceof CompetitorEvidenceError && /expired on 2026-07-01/.test(error.message),
  );
});

test("an archived expired record can coexist with a fresh replacement", () => {
  const document = validDocument();
  document.records[0].expiresAt = "2026-07-01";
  document.records[0].historical = true;
  document.records[0].historicalReason = "Superseded by a newer observation.";
  document.records[0].supersededBy = "openlayers-example-2026";
  document.records.push({
    ...validDocument().records[0],
    id: "openlayers-example-2026",
    observedAt: "2026-08-01",
    retrievedAt: "2026-08-01",
    expiresAt: "2027-08-01",
  });
  const evidence = validate(document);
  // The whole document still validates, and only the replacement is projectable.
  assert.equal(projectEvidence(evidence, "openlayers-example-2026").id, "openlayers-example-2026");
  assert.throws(() => projectEvidence(evidence, "openlayers-example"), CompetitorEvidenceError);
});

test("projecting a fresh record returns it", () => {
  const evidence = validate(validDocument());
  assert.equal(requireFreshEvidence(evidence.byId.get("openlayers-example")).id, "openlayers-example");
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

test("a source URL outside the trusted origins for the package fails validation", () => {
  const document = validDocument();
  document.records[0].sourceUrl = "https://some-blog.invalid/post/restating-the-vendor-number";
  assert.throws(
    () => validate(document),
    (error) => error instanceof CompetitorEvidenceError && /not under a trusted primary-source origin/.test(error.message),
  );
});

test("an additional source outside the trusted origins fails validation", () => {
  const document = validDocument();
  document.records[0].supportingSources[0].url = "https://some-blog.invalid/npm-version";
  assert.throws(
    () => validate(document),
    (error) => error instanceof CompetitorEvidenceError && /not under a trusted primary-source origin/.test(error.message),
  );
});

test("a registry-derived version must cite the package registry", () => {
  const document = validDocument();
  document.records[0].supportingSources[0].url = "https://openlayers.org/releases/";
  assert.throws(() => validate(document), /latestVersion is not backed by a package-registry primary source/);
});

test("a registry source attributed only to claim or operations is not version evidence", () => {
  // The hole this closes: the URL prefix alone used to satisfy the predicate,
  // so a registry source added for `operations` still passed as the backing for
  // latestVersion — an unbacked version claim reaching the comparison page.
  const document = validDocument();
  document.records[0].supportingSources[0].supports = ["claim", "operations"];
  assert.throws(() => validate(document), /latestVersion is not backed by a package-registry primary source/);
});

test("an observation or retrieval date in the future fails validation", () => {
  const document = validDocument();
  document.records[0].observedAt = "2026-08-24";
  document.records[0].retrievedAt = "2026-08-24";
  assert.throws(() => validate(document), /observations cannot come from the future/);
});

test("a record cannot whitelist its own source origin", () => {
  const document = validDocument();
  document.records[0].sourceUrl = "https://some-blog.invalid/post";
  // Declaring the blog inside the record must not help: trust comes from code,
  // and the schema rejects the unknown property outright.
  document.records[0].primarySourcePrefixes = ["https://some-blog.invalid/"];
  assert.throws(() => validate(document), CompetitorEvidenceError);
});

test("a package with no trusted origins cannot be projected", () => {
  const document = validDocument();
  document.records[0].package = "@some/unreviewed-package";
  assert.throws(
    () => validate(document),
    (error) => error instanceof CompetitorEvidenceError && /has no trusted primary-source origins/.test(error.message),
  );
});

test("trusted origins are declared in code for every projected package", () => {
  const evidence = loadCompetitorEvidence({ rootDir: ROOT, now: NOW });
  for (const record of evidence.records) {
    assert.ok(
      TRUSTED_PRIMARY_SOURCE_PREFIXES[record.package],
      `${record.package} must have reviewed trusted origins in scripts/lib/competitor-evidence.mjs`,
    );
  }
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

// --- REQ-003: operation cells come from evidence, not inline constants ------

test("every competitor column projected onto the page states all rendered operations", () => {
  const evidence = loadCompetitorEvidence({ rootDir: ROOT, now: NOW });
  for (const id of [
    "maplibre-gl-scope",
    "esri-arcgis-rest-js-scope",
    "openlayers-scope",
    "mapbox-gl-js-scope-2026-08",
    "carto-api-client-scope-2026-08",
    "felt-js-sdk-scope-2026-08",
  ]) {
    const record = evidence.byId.get(id);
    assert.ok(record, `${id} must exist`);
    for (const key of OPERATION_KEYS) {
      assert.doesNotThrow(() => operationCell(record, key), `${id} must state operation ${key}`);
    }
  }
});

test("rendering an operation the record does not state fails", () => {
  const evidence = loadCompetitorEvidence({ rootDir: ROOT, now: NOW });
  const record = { ...evidence.byId.get("openlayers-scope"), operations: { discovery: { support: "✓" } } };
  assert.throws(
    () => operationCell(record, "paging"),
    (error) => error instanceof CompetitorEvidenceError && /does not state operation "paging"/.test(error.message),
  );
});

test("an unknown operation key is a programming error, not an evidence error", () => {
  const evidence = loadCompetitorEvidence({ rootDir: ROOT, now: NOW });
  assert.throws(() => operationCell(evidence.byId.get("openlayers-scope"), "teleport"), TypeError);
});

test("an invalid operation support glyph fails schema validation", () => {
  const document = validDocument();
  document.records[0].operations = { discovery: { support: "yes" } };
  assert.throws(() => validate(document), /schema validation/);
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

test("page generation fails once a projected record expires", async () => {
  const { buildPage } = await import("../../scripts/generate-comparison-page.mjs");
  // Every projected record expires well before 2030, so generation at that
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
  // Operation cells must be traceable to a dated, sourced observation.
  assert.match(page, /Competitor columns as observed/);
  assert.match(page, /Mapbox GL JS/);
  assert.match(page, /CARTO for Developers/);
  assert.match(page, /Felt JavaScript SDK/);
  assert.match(page, /registry\.npmjs\.org\/@feltmaps\/js-sdk/);
});
