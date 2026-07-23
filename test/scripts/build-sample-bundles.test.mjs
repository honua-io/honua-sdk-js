import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deriveExcludedSamples,
  EXCLUDED_SAMPLE_CATEGORIES,
  EXCLUDED_SAMPLES,
  INCLUDED_SAMPLE_IDS,
  INCLUDED_SAMPLES,
  validateSampleBundleManifest,
} from "../../scripts/build-sample-bundles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "samples/catalog.v2.json"), "utf8"));
const bundleSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "samples/contract/v2/schemas/sample-bundles.schema.json"), "utf8"),
);
const siteProjectionSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "samples/contract/v2/schemas/site-projection.schema.json"), "utf8"),
);

function fakeCatalog(samples) {
  return { samples };
}

function fakeSample(id, overrides = {}) {
  return {
    id,
    data: { mode: "fixture", config: [] },
    lifecycle: { state: "active", reason: "test fixture" },
    ...overrides,
  };
}

test("every real catalog sample is exactly bundled or excluded, never both", () => {
  const excluded = deriveExcludedSamples(catalog);
  const includedIds = new Set(INCLUDED_SAMPLE_IDS);
  const excludedIds = new Set(excluded.map((entry) => entry.id));

  assert.equal(excluded.length, catalog.samples.length - INCLUDED_SAMPLES.length);
  assert.equal(excludedIds.size, excluded.length, "excluded ids must be unique");

  for (const sample of catalog.samples) {
    const bundled = includedIds.has(sample.id);
    const isExcluded = excludedIds.has(sample.id);
    assert.notEqual(bundled, isExcluded, `${sample.id} must be either bundled or excluded, not both/neither`);
  }
  for (const id of includedIds) {
    assert.ok(
      catalog.samples.some((sample) => sample.id === id),
      `${id}: INCLUDED_SAMPLES id not found in samples/catalog.v2.json`,
    );
  }
});

test("overture-geoparquet is bundled through the existing prepare+build script chain", () => {
  const overture = INCLUDED_SAMPLES.find((sample) => sample.id === "overture-geoparquet");
  assert.ok(overture, "overture-geoparquet should now be an INCLUDED_SAMPLES entry (#656)");
  assert.equal(overture.buildScript, "demo:overture:build");
  assert.ok(
    !EXCLUDED_SAMPLES.some((entry) => entry.id === "overture-geoparquet"),
    "overture-geoparquet must not also appear in EXCLUDED_SAMPLES",
  );
});

test("every hand-classified exclusion category is declared in EXCLUDED_SAMPLE_CATEGORIES", () => {
  for (const entry of EXCLUDED_SAMPLES) {
    assert.ok(
      EXCLUDED_SAMPLE_CATEGORIES.includes(entry.category),
      `${entry.id}: category "${entry.category}" is not in EXCLUDED_SAMPLE_CATEGORIES`,
    );
  }
});

test("the exclusion category enum stays in sync between the source list and both JSON schemas", () => {
  const bundleEnum = bundleSchema.$defs.excludedSample.properties.category.enum;
  const projectionEnum =
    siteProjectionSchema.$defs.sampleBundles.properties.excluded.items.properties.category.enum;

  assert.deepEqual([...bundleEnum].sort(), [...EXCLUDED_SAMPLE_CATEGORIES].sort());
  assert.deepEqual([...projectionEnum].sort(), [...EXCLUDED_SAMPLE_CATEGORIES].sort());
});

test("no hand-classified id is not also an active or non-active catalog member's real state", () => {
  // Regression test for the bug this pass found: build-sample-bundles.mjs's
  // old catch-all comment claimed planning-permitting-workbench and
  // service-explorer had a non-"active" lifecycle.state when the catalog
  // actually marks both "active". deriveExcludedSamples must reject a
  // "lifecycle-not-active" category on an active catalog sample, and must
  // reject any other category on a non-active catalog sample.
  const activeSample = fakeSample("fixture-active");
  const reworkSample = fakeSample("fixture-rework", { lifecycle: { state: "rework", reason: "test fixture" } });
  const catalogFixture = fakeCatalog([activeSample, reworkSample]);

  assert.throws(
    () =>
      deriveExcludedSamples(catalogFixture, {
        explicit: [{ id: "fixture-active", category: "lifecycle-not-active", reason: "stale" }],
      }),
    /lifecycle\.state is "active"/,
  );

  assert.throws(
    () =>
      deriveExcludedSamples(catalogFixture, {
        explicit: [{ id: "fixture-rework", category: "agent-shaped", reason: "stale" }],
      }),
    /use category "lifecycle-not-active" instead/,
  );
});

test("an active catalog sample with no inclusion or exclusion entry fails loudly instead of guessing", () => {
  const catalogFixture = fakeCatalog([fakeSample("fixture-unaccounted")]);
  assert.throws(() => deriveExcludedSamples(catalogFixture, { explicit: [] }), /has no INCLUDED_SAMPLES or EXCLUDED_SAMPLES entry/);
});

test("a non-active catalog sample is auto-derived with a lifecycle-not-active reason from its own catalog data", () => {
  const catalogFixture = fakeCatalog([
    fakeSample("fixture-retire", {
      lifecycle: {
        state: "retire",
        reason: "Superseded by the next thing.",
        targetRelease: "9.9.9",
        replacement: { kind: "external", id: "some-other-thing" },
      },
    }),
  ]);
  const excluded = deriveExcludedSamples(catalogFixture, { explicit: [] });
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].id, "fixture-retire");
  assert.equal(excluded[0].category, "lifecycle-not-active");
  assert.match(excluded[0].reason, /^Catalog lifecycle\.state is "retire" \(target 9\.9\.9\): Superseded by the next thing\./);
  assert.match(excluded[0].reason, /Replacement: external "some-other-thing"\.$/);
});

test("duplicate or overlapping hand-classified entries are rejected", () => {
  const catalogFixture = fakeCatalog([fakeSample("fixture-a")]);
  assert.throws(
    () =>
      deriveExcludedSamples(catalogFixture, {
        explicit: [
          { id: "fixture-a", category: "agent-shaped", reason: "one" },
          { id: "fixture-a", category: "agent-shaped", reason: "two" },
        ],
      }),
    /duplicate id in EXCLUDED_SAMPLES/,
  );
  assert.throws(
    () =>
      deriveExcludedSamples(catalogFixture, {
        explicit: [{ id: "fixture-a", category: "agent-shaped", reason: "one" }],
        includedIds: new Set(["fixture-a"]),
      }),
    /listed in both INCLUDED_SAMPLES and EXCLUDED_SAMPLES/,
  );
});

test("validateSampleBundleManifest rejects a manifest whose excluded ids overlap its bundled ids", async () => {
  const manifest = {
    format: "honua.sdk.sample-bundles.v1",
    schemaVersion: 1,
    build: { node: ">=20.0.0", lockfileSha256: "a".repeat(64) },
    samples: INCLUDED_SAMPLE_IDS.map((id) => ({
      id,
      entrypoint: "index.html",
      dataMode: "fixture",
      configDefaults: {},
      builtFrom: { commit: "b".repeat(40), packageVersion: "0.0.0" },
      files: [
        {
          path: "index.html",
          bytes: 1,
          sha256: "c".repeat(64),
          integrity: "sha256-AA==",
          mediaType: "text/html",
        },
      ],
    })),
    excluded: [{ id: INCLUDED_SAMPLE_IDS[0], category: "agent-shaped", reason: "duplicate of a bundled sample" }],
  };
  await assert.rejects(validateSampleBundleManifest(manifest), /listed in both samples and excluded/);
});

function placeholderFile() {
  return { path: "index.html", bytes: 1, sha256: "c".repeat(64), integrity: "sha256-AA==", mediaType: "text/html" };
}

function placeholderSample(id) {
  return {
    id,
    entrypoint: "index.html",
    dataMode: "fixture",
    configDefaults: {},
    builtFrom: { commit: "b".repeat(40), packageVersion: "0.0.0" },
    files: [placeholderFile()],
  };
}

test("validateSampleBundleManifest cross-checks full catalog coverage when given a catalog", async () => {
  const excluded = deriveExcludedSamples(catalog);
  const completeManifest = {
    format: "honua.sdk.sample-bundles.v1",
    schemaVersion: 1,
    build: { node: ">=20.0.0", lockfileSha256: "a".repeat(64) },
    samples: INCLUDED_SAMPLE_IDS.map((id) => placeholderSample(id)),
    excluded,
  };
  await assert.doesNotReject(validateSampleBundleManifest(completeManifest, { catalog }));

  const droppedManifest = { ...completeManifest, excluded: excluded.slice(1) };
  await assert.rejects(
    validateSampleBundleManifest(droppedManifest, { catalog }),
    /manifest accounts for \d+ of \d+ catalog samples/,
  );
});
