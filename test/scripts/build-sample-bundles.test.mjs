import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildFixtureCogAssets } from "../../examples/imagery-cog-quickstart/fixture-cog-assets.mjs";
import {
  browserExposedCredentials,
  browserPublicConfigNames,
  deriveExcludedSamples,
  derivePublishedSamples,
  deriveSampleBundleDecisions,
  evaluateSampleBundleEligibility,
  EXCLUDED_SAMPLE_CATEGORIES,
  EXCLUDED_SAMPLES,
  INCLUDED_SAMPLE_IDS,
  INCLUDED_SAMPLES,
  INELIGIBLE_SUPPORT_TIERS,
  PUBLISHABLE_RUNTIME_HOSTING,
  PUBLISHED_LIVE_SAMPLE_POLICY,
  routeCoveredByHostFixtureRoutes,
  RUNNABILITY_BY_HOSTING,
  RUNTIME_HOSTING_KINDS,
  SAMPLE_BUNDLE_AUDIT,
  validateSampleBundleManifest,
  verifySampleBundleAudit,
} from "../../scripts/build-sample-bundles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "samples/catalog.v2.json"), "utf8"));
const bundleSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "samples/contract/v2/schemas/sample-bundles.schema.json"), "utf8"),
);
const siteProjectionSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "samples/contract/v2/schemas/site-projection.v3.schema.json"), "utf8"),
);
const legacySiteProjectionSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "samples/contract/v2/schemas/site-projection.schema.json"), "utf8"),
);

const catalogById = new Map(catalog.samples.map((sample) => [sample.id, sample]));

function fakeCatalog(samples) {
  return { samples };
}

function fakeSample(id, overrides = {}) {
  return {
    id,
    supportTier: "supported",
    track: "recipe",
    validationProfile: "browser-recipe",
    sourcePath: `examples/${id}`,
    data: { mode: "fixture", config: [], configurationStatus: "not-required", configClassifications: [] },
    lifecycle: { state: "active", reason: "test fixture" },
    ...overrides,
  };
}

function fakeAudit(id, overrides = {}) {
  return { id, runtimeHosting: "self-contained", buildScript: `demo:${id}:build`, auditedVia: "test fixture", ...overrides };
}

test("the imagery COG fixture pins a tiled EPSG:4326 overview and exact chunk digests", () => {
  const generated = buildFixtureCogAssets();
  assert.deepEqual(generated.assetBytes.subarray(0, 4), Buffer.from([0x49, 0x49, 42, 0]));
  assert.equal(generated.manifest.asset.crs, "EPSG:4326");
  assert.equal(generated.manifest.asset.license, "CC0-1.0");
  assert.deepEqual(
    generated.manifest.asset.levels.map((level) => level.decimation),
    [1, 4],
  );
  assert.ok(generated.manifest.asset.levels[1].bytes < generated.manifest.asset.bytes / 4);
  assert.equal(createHash("sha256").update(generated.assetBytes).digest("hex"), generated.manifest.asset.sha256);
  for (const chunk of generated.chunks) {
    assert.ok(chunk.bytes.byteLength <= 64 * 1024);
    assert.equal(createHash("sha256").update(chunk.bytes).digest("hex"), chunk.sha256);
    assert.equal(createHash("sha256").update(chunk.storedBytes).digest("hex"), chunk.storedSha256);
    assert.ok(chunk.storedBytes.byteLength < chunk.bytes.byteLength);
  }
});

test("the imagery COG fixture publishes a virtual href instead of a complete object", () => {
  const generated = buildFixtureCogAssets();
  const asset = generated.item.assets.cog;
  assert.equal(asset.href, "./assets/oahu-natural-color-v1.tif");
  assert.equal(asset["file:size"], generated.assetBytes.byteLength);
  assert.equal(asset["checksum:multihash"], `sha256:${generated.manifest.asset.sha256}`);
  assert.equal(
    generated.chunks.reduce((total, chunk) => total + chunk.bytes.length, 0),
    generated.assetBytes.length,
  );
  assert.ok(
    generated.chunks.reduce((total, chunk) => total + chunk.storedBytes.length, 0) < generated.assetBytes.length / 2,
  );
});

test("the imagery COG fixture pins licensed imagery comparison and Terrain-RGB PNGs", () => {
  const generated = buildFixtureCogAssets();
  assert.deepEqual(
    generated.manifest.renderFixtures.map((fixture) => fixture.id),
    ["wms-natural-color", "image-server-natural-color", "terrain-rgb"],
  );
  for (const fixture of generated.renderFixtures) {
    assert.equal(fixture.metadata.license, "CC0-1.0");
    assert.equal(fixture.metadata.mediaType, "image/png");
    assert.equal(fixture.metadata.width, 256);
    assert.equal(fixture.metadata.height, 256);
    assert.equal(createHash("sha256").update(fixture.bytes).digest("hex"), fixture.metadata.sha256);
    assert.equal(fixture.bytes.byteLength, fixture.metadata.bytes);
  }
});

test("every catalog sample gets exactly one publish-or-exclude decision (#656 REQ-001)", () => {
  const decisions = deriveSampleBundleDecisions(catalog);
  assert.equal(decisions.length, catalog.samples.length, "every catalog entry must be decided exactly once");
  assert.equal(new Set(decisions.map((decision) => decision.id)).size, decisions.length, "decision ids must be unique");

  const includedIds = new Set(INCLUDED_SAMPLE_IDS);
  const excludedIds = new Set(EXCLUDED_SAMPLES.map((entry) => entry.id));
  assert.equal(includedIds.size + excludedIds.size, catalog.samples.length);
  for (const sample of catalog.samples) {
    assert.notEqual(
      includedIds.has(sample.id),
      excludedIds.has(sample.id),
      `${sample.id} must be either bundled or excluded, not both/neither`,
    );
  }
});

test("the audit table covers exactly the active catalog entries (#656 REQ-001)", () => {
  const auditedIds = SAMPLE_BUNDLE_AUDIT.map((record) => record.id);
  assert.equal(new Set(auditedIds).size, auditedIds.length, "audit ids must be unique");

  const activeIds = catalog.samples.filter((sample) => sample.lifecycle.state === "active").map((sample) => sample.id);
  assert.deepEqual([...auditedIds].sort(), [...activeIds].sort());

  for (const record of SAMPLE_BUNDLE_AUDIT) {
    assert.ok(
      RUNTIME_HOSTING_KINDS.includes(record.runtimeHosting),
      `${record.id}: unknown runtimeHosting "${record.runtimeHosting}"`,
    );
    assert.ok(
      typeof record.auditedVia === "string" && record.auditedVia.length > 0,
      `${record.id}: must record the source location that establishes its runtimeHosting`,
    );
  }
});

test("the audit table's structural claims hold against the tree (#656 REQ-001)", () => {
  assert.doesNotThrow(() => verifySampleBundleAudit(catalog));
});

test("verifySampleBundleAudit rejects a runtimeHosting claim the tree contradicts", () => {
  // maplibre-quickstart really is a Vite app, so claiming it is not a runtime
  // sample must fail rather than silently mis-describing the gallery.
  assert.throws(
    () =>
      verifySampleBundleAudit(catalog, {
        audit: [{ id: "maplibre-quickstart", runtimeHosting: "not-a-runtime-sample", auditedVia: "wrong" }],
      }),
    /claims there is no browser app, but examples\/maplibre-quickstart\/vite\.config\.ts exists/,
  );
  // node-backend-quickstart has no vite.config.ts, so claiming it bundles must fail.
  assert.throws(
    () =>
      verifySampleBundleAudit(catalog, {
        audit: [
          {
            id: "node-backend-quickstart",
            runtimeHosting: "self-contained",
            buildScript: "demo:node-backend:build",
            auditedVia: "wrong",
          },
        ],
      }),
    /implies a Vite browser app, but examples\/node-backend-quickstart\/vite\.config\.ts is missing/,
  );
});

test("verifySampleBundleAudit binds hostFixtureRoutes to the same-origin-fixture-service kind", () => {
  assert.throws(
    () =>
      verifySampleBundleAudit(catalog, {
        audit: [
          {
            id: "service-explorer",
            runtimeHosting: "same-origin-fixture-service",
            buildScript: "demo:service-explorer:build",
            auditedVia: "missing routes",
          },
        ],
      }),
    /same-origin-fixture-service must declare hostFixtureRoutes/,
  );
  assert.throws(
    () =>
      verifySampleBundleAudit(catalog, {
        audit: [
          {
            id: "sketch-editing",
            runtimeHosting: "self-contained",
            buildScript: "demo:sketch-editing:build",
            hostFixtureRoutes: ["/fixtures/anything"],
            auditedVia: "self-contained samples need no host routes",
          },
        ],
      }),
    /only same-origin-fixture-service may declare hostFixtureRoutes/,
  );
  assert.throws(
    () =>
      verifySampleBundleAudit(catalog, {
        audit: [
          {
            id: "service-explorer",
            runtimeHosting: "same-origin-fixture-service",
            buildScript: "demo:service-explorer:build",
            hostFixtureRoutes: ["fixtures/ogc"],
            auditedVia: "relative route",
          },
        ],
      }),
    /must be an absolute path/,
  );
});

test("verifySampleBundleAudit requires a declared buildScript to actually build that sample", () => {
  assert.throws(
    () =>
      verifySampleBundleAudit(catalog, {
        audit: [
          {
            id: "sketch-editing",
            runtimeHosting: "self-contained",
            buildScript: "demo:quickstart:build",
            auditedVia: "wrong build script",
          },
        ],
      }),
    /does not build examples\/sketch-editing\/vite\.config\.ts/,
  );
});

test("every published bundle clears the catalog-derived eligibility gates (#656 REQ-002/REQ-003)", () => {
  assert.ok(INCLUDED_SAMPLES.length > 0);
  for (const included of INCLUDED_SAMPLES) {
    const entry = catalogById.get(included.id);
    assert.ok(entry, `${included.id}: published id is not in samples/catalog.v2.json`);
    assert.equal(entry.lifecycle.state, "active", `${included.id}: only active samples may publish`);
    assert.ok(
      !INELIGIBLE_SUPPORT_TIERS.has(entry.supportTier),
      `${included.id}: supportTier "${entry.supportTier}" may not publish a bundle`,
    );
    assert.notEqual(
      entry.data.configurationStatus,
      "legacy-unsafe",
      `${included.id}: legacy-unsafe browser configuration may not publish a bundle`,
    );
    assert.deepEqual(
      browserExposedCredentials(entry),
      [],
      `${included.id}: a published bundle may not depend on a browser-public credential`,
    );
    assert.ok(
      PUBLISHABLE_RUNTIME_HOSTING.has(included.runtimeHosting) || PUBLISHED_LIVE_SAMPLE_POLICY.has(included.id),
      `${included.id}: runtimeHosting "${included.runtimeHosting}" is not publishable`,
    );
    assert.equal(included.runnability, RUNNABILITY_BY_HOSTING.get(included.runtimeHosting));
  }
});

test("published bundles declare the prerequisites implied by runnability (#656 REQ-005)", () => {
  const published = derivePublishedSamples(catalog);
  assert.deepEqual(
    published.map((entry) => entry.id),
    [...INCLUDED_SAMPLE_IDS].sort(),
  );
  for (const entry of published) {
    if (entry.runnability === "standalone") {
      assert.deepEqual(entry.hostFixtureRoutes, [], `${entry.id}: a standalone bundle needs no host routes`);
    } else if (entry.runnability === "requires-host-fixture-service") {
      assert.equal(entry.runnability, "requires-host-fixture-service");
      assert.ok(entry.hostFixtureRoutes.length > 0, `${entry.id}: must state what the host has to serve`);
    } else {
      assert.equal(entry.runnability, "requires-live-endpoint");
      assert.deepEqual(entry.hostFixtureRoutes, [], `${entry.id}: a live-backed bundle must not claim host fixture routes`);
      assert.ok(PUBLISHED_LIVE_SAMPLE_POLICY.has(entry.id), `${entry.id}: live publication must be explicitly allowlisted`);
    }
  }
  // The five samples whose default lane addresses same-origin fixture routes
  // the bundle does not contain must never be presented as standalone.
  const byId = new Map(published.map((entry) => [entry.id, entry]));
  for (const id of [
    "planning-permitting-workbench",
    "react-quickstart",
  ]) {
    assert.equal(byId.get(id)?.runnability, "requires-host-fixture-service", `${id} must declare its prerequisites`);
  }
});

test("imagery-cog publishes as standalone with no fictional host routes", () => {
  const sample = INCLUDED_SAMPLES.find((candidate) => candidate.id === "imagery-cog-quickstart");
  assert.equal(sample?.runtimeHosting, "self-contained");
  assert.deepEqual(sample?.hostFixtureRoutes ?? [], []);
  assert.match(
    SAMPLE_BUNDLE_AUDIT.find((record) => record.id === "imagery-cog-quickstart")?.auditedVia ?? "",
    /SHA-256-pinned logical 64 KiB chunks with independently pinned lossless storage and licensed PNG map fixtures/,
  );
});

test("routeCoveredByHostFixtureRoutes matches whole path segments, not bare string prefixes", () => {
  assert.ok(routeCoveredByHostFixtureRoutes("/fixtures/cog/assets/x", ["/fixtures/cog/"]));
  assert.ok(routeCoveredByHostFixtureRoutes("/fixtures/cog", ["/fixtures/cog"]));
  assert.ok(routeCoveredByHostFixtureRoutes("/rest/services/A/ImageServer/exportImage", ["/rest/services/A/ImageServer"]));
  assert.ok(!routeCoveredByHostFixtureRoutes("/fixtures/cognition", ["/fixtures/cog"]));
  assert.ok(!routeCoveredByHostFixtureRoutes("/fixtures/other", ["/fixtures/cog/"]));
});

test("the newly published samples audited by #656 are bundled", () => {
  for (const id of [
    "ai-spatial-app-builder",
    "imagery-cog-quickstart",
    "planning-permitting-workbench",
    "react-quickstart",
    "service-explorer",
  ]) {
    const included = INCLUDED_SAMPLES.find((sample) => sample.id === id);
    assert.ok(included, `${id} should be published by #656's audit`);
    assert.ok(included.buildScript, `${id} must reuse an existing demo build script`);
    assert.ok(
      !EXCLUDED_SAMPLES.some((entry) => entry.id === id),
      `${id} must not also appear as an exclusion`,
    );
  }
});

test("overture-geoparquet is bundled through the existing prepare+build script chain", () => {
  const overture = INCLUDED_SAMPLES.find((sample) => sample.id === "overture-geoparquet");
  assert.ok(overture, "overture-geoparquet should be a published sample (#656)");
  assert.equal(overture.buildScript, "demo:overture:build");
  assert.equal(overture.runnability, "standalone");
});

test("every computed exclusion category is declared in EXCLUDED_SAMPLE_CATEGORIES", () => {
  for (const entry of EXCLUDED_SAMPLES) {
    assert.ok(
      EXCLUDED_SAMPLE_CATEGORIES.includes(entry.category),
      `${entry.id}: category "${entry.category}" is not in EXCLUDED_SAMPLE_CATEGORIES`,
    );
    assert.ok(entry.reason.length > 0, `${entry.id}: every exclusion must carry a reason (#656 REQ-004)`);
  }
});

test("no projected exclusion reason leaks a config variable name", () => {
  // `sampleBundles.excluded[].reason` lands in the public site projection,
  // which test/sample-contract.test.ts asserts never contains "VITE_". Guard
  // it here too, next to the audit records the reasons are composed from, so
  // a new `auditedVia` string fails fast rather than in a distant spec.
  for (const entry of EXCLUDED_SAMPLES) {
    assert.doesNotMatch(
      entry.reason,
      /VITE_/,
      `${entry.id}: an exclusion reason is projected publicly and must not name a browser config variable`,
    );
  }
});

test("configDefaults describes only the browser-public config surface", () => {
  // `data.config` is a sample's whole configuration surface and mixes in
  // server-only settings; publishing those in a field the schema documents as
  // the browser-public surface overstates what a consumer can influence and
  // leaks backend topology. Two published samples (ai-spatial-app-builder,
  // service-explorer) have an entirely server-only surface, so they are the
  // regression canaries.
  for (const included of INCLUDED_SAMPLES) {
    const entry = catalogById.get(included.id);
    const browserPublic = browserPublicConfigNames(entry);
    const serverOnly = (entry.data.configClassifications ?? [])
      .filter((classification) => classification.exposure !== "browser-public")
      .map((classification) => classification.name);
    for (const name of serverOnly) {
      assert.ok(
        !browserPublic.includes(name),
        `${included.id}: server-only config name ${name} must not reach the published configDefaults`,
      );
    }
  }
  assert.deepEqual(browserPublicConfigNames(catalogById.get("ai-spatial-app-builder")), []);
  assert.deepEqual(browserPublicConfigNames(catalogById.get("service-explorer")), []);
  assert.deepEqual(browserPublicConfigNames(catalogById.get("imagery-cog-quickstart")), ["VITE_HONUA_IMAGERY_BASE_URL"]);
});

test("browserPublicConfigNames fails closed on an unclassified config name", () => {
  const entry = fakeSample("fixture-unclassified", {
    data: { mode: "hybrid", config: ["VITE_MYSTERY"], configurationStatus: "approved", configClassifications: [] },
  });
  assert.throws(() => browserPublicConfigNames(entry), /has no configClassifications entry/);
});

test("the exclusion category enum stays in sync between the source list and both JSON schemas", () => {
  const bundleEnum = bundleSchema.$defs.excludedSample.properties.category.enum;
  const projectionEnum = siteProjectionSchema.$defs.sampleBundles.properties.excluded.items.properties.category.enum;

  assert.deepEqual([...bundleEnum].sort(), [...EXCLUDED_SAMPLE_CATEGORIES].sort());
  assert.deepEqual([...projectionEnum].sort(), [...EXCLUDED_SAMPLE_CATEGORIES].sort());
});

test("the v3 runnability enum stays in sync while the closed v2 schema remains compatible", () => {
  const expected = [...new Set(RUNNABILITY_BY_HOSTING.values())].sort();
  assert.deepEqual([...bundleSchema.$defs.sample.properties.runnability.enum].sort(), expected);
  assert.deepEqual(
    [...siteProjectionSchema.$defs.sampleBundles.properties.published.items.properties.runnability.enum].sort(),
    expected,
  );
  assert.deepEqual(
    [...legacySiteProjectionSchema.$defs.sampleBundles.properties.published.items.properties.runnability.enum].sort(),
    expected.filter((runnability) => runnability !== "requires-live-endpoint"),
  );
  assert.deepEqual(
    [...bundleSchema.$defs.sample.properties.runtimeHosting.enum].sort(),
    [...PUBLISHABLE_RUNTIME_HOSTING, "external-live-endpoint"].sort(),
  );
});

test("only the exact-origin service explorer bypasses generic external exclusion", () => {
  assert.deepEqual([...PUBLISHED_LIVE_SAMPLE_POLICY.keys()], ["service-explorer"]);
  for (const [id, policy] of PUBLISHED_LIVE_SAMPLE_POLICY) {
    assert.deepEqual(policy.allowedOrigins, [id === "maplibre-quickstart" ? "https://demo.honua.io" : "https://demo.pygeoapi.io"]);
    assert.equal(new URL(policy.semanticProbe.url).origin, policy.allowedOrigins[0]);
    const included = INCLUDED_SAMPLES.find((sample) => sample.id === id);
    assert.equal(included?.runtimeHosting, "external-live-endpoint");
    assert.equal(included?.runnability, "requires-live-endpoint");
  }
  const unexpected = evaluateSampleBundleEligibility(
    fakeSample("fixture-unapproved-live"),
    fakeAudit("fixture-unapproved-live", { runtimeHosting: "external-live-endpoint" }),
  );
  assert.equal(unexpected.decision, "exclude");
  assert.equal(unexpected.category, "requires-live-backend");
});

test("a browser-public credential blocks publication as requires-api-key (#656 REQ-003)", () => {
  const entry = fakeSample("fixture-secret", {
    data: {
      mode: "hybrid",
      config: ["VITE_SECRET"],
      configurationStatus: "approved",
      configClassifications: [{ name: "VITE_SECRET", exposure: "browser-public", valueKind: "credential" }],
    },
  });
  const decision = evaluateSampleBundleEligibility(entry, fakeAudit("fixture-secret"));
  assert.equal(decision.decision, "exclude");
  assert.equal(decision.category, "requires-api-key");
  // The projected reason counts the offending names without printing them --
  // the public site projection must never carry a config variable name.
  assert.match(decision.reason, /1 declared config name as a browser-public credential/);
  assert.doesNotMatch(decision.reason, /VITE_SECRET/);
  // ...but the names stay locally derivable for debugging.
  assert.deepEqual(browserExposedCredentials(entry), ["VITE_SECRET"]);
  // A server-only credential never reaches the browser build, so it must not block.
  const serverOnly = fakeSample("fixture-server-secret", {
    data: {
      mode: "hybrid",
      config: ["SECRET"],
      configurationStatus: "approved",
      configClassifications: [{ name: "SECRET", exposure: "server-only", valueKind: "credential" }],
    },
  });
  assert.equal(evaluateSampleBundleEligibility(serverOnly, fakeAudit("fixture-server-secret")).decision, "publish");
});

test("legacy-unsafe configuration and ineligible support tiers block publication (#656 REQ-003)", () => {
  const legacy = fakeSample("fixture-legacy", {
    data: { mode: "hybrid", config: [], configurationStatus: "legacy-unsafe", configClassifications: [] },
  });
  const legacyDecision = evaluateSampleBundleEligibility(legacy, fakeAudit("fixture-legacy"));
  assert.equal(legacyDecision.category, "legacy-unsafe-configuration");

  for (const tier of INELIGIBLE_SUPPORT_TIERS) {
    const decision = evaluateSampleBundleEligibility(
      fakeSample(`fixture-${tier}`, { supportTier: tier }),
      fakeAudit(`fixture-${tier}`),
    );
    assert.equal(decision.category, "unsupported-support-tier", `${tier} must not publish`);
  }
});

test("each non-publishable runtimeHosting maps to its own exclusion category (#656 REQ-004)", () => {
  const expected = new Map([
    ["external-live-endpoint", "requires-live-backend"],
    ["companion-process", "requires-companion-server"],
    ["server-side-app", "non-browser-app"],
    ["not-a-runtime-sample", "non-runtime-sample"],
  ]);
  for (const [hosting, category] of expected) {
    const decision = evaluateSampleBundleEligibility(
      fakeSample("fixture-hosting"),
      fakeAudit("fixture-hosting", { runtimeHosting: hosting }),
    );
    assert.equal(decision.decision, "exclude");
    assert.equal(decision.category, category, `${hosting} should exclude as ${category}`);
    assert.match(decision.reason, /test fixture$/, "the reason must end with the audit evidence");
  }
  for (const hosting of PUBLISHABLE_RUNTIME_HOSTING) {
    const audit = fakeAudit("fixture-hosting", {
      runtimeHosting: hosting,
      ...(hosting === "same-origin-fixture-service" ? { hostFixtureRoutes: ["/fixtures"] } : {}),
    });
    assert.equal(evaluateSampleBundleEligibility(fakeSample("fixture-hosting"), audit).decision, "publish");
  }
});

test("a structural non-browser sample keeps its structural category even at an ineligible tier", () => {
  // "this is not a browser app at all" is the more fundamental truth than
  // "its support tier is internal", so it must win the reported category
  // while the tier still shows up as a recorded blocker.
  const decision = evaluateSampleBundleEligibility(
    fakeSample("fixture-internal-docs", { supportTier: "internal" }),
    fakeAudit("fixture-internal-docs", { runtimeHosting: "not-a-runtime-sample", buildScript: undefined }),
  );
  assert.equal(decision.category, "non-runtime-sample");
  assert.deepEqual(
    decision.blockers.map((blocker) => blocker.category),
    ["non-runtime-sample", "unsupported-support-tier"],
  );
});

test("an audit record for a non-active catalog entry fails loudly instead of shadowing the lifecycle truth", () => {
  const catalogFixture = fakeCatalog([
    fakeSample("fixture-rework", { lifecycle: { state: "rework", reason: "test fixture" } }),
  ]);
  assert.throws(
    () => deriveSampleBundleDecisions(catalogFixture, { audit: [fakeAudit("fixture-rework")] }),
    /drop the record so the mechanical lifecycle-not-active exclusion applies/,
  );
});

test("an active catalog sample with no audit record fails loudly instead of guessing", () => {
  const catalogFixture = fakeCatalog([fakeSample("fixture-unaccounted")]);
  assert.throws(
    () => deriveSampleBundleDecisions(catalogFixture, { audit: [] }),
    /has no SAMPLE_BUNDLE_AUDIT record/,
  );
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
  const excluded = deriveExcludedSamples(catalogFixture, { audit: [] });
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].id, "fixture-retire");
  assert.equal(excluded[0].category, "lifecycle-not-active");
  assert.match(
    excluded[0].reason,
    /^Catalog lifecycle\.state is "retire" \(target 9\.9\.9\): Superseded by the next thing\./,
  );
  assert.match(excluded[0].reason, /Replacement: external "some-other-thing"\.$/);
});

test("duplicate audit records and unknown catalog ids are rejected", () => {
  const catalogFixture = fakeCatalog([fakeSample("fixture-a")]);
  assert.throws(
    () => deriveSampleBundleDecisions(catalogFixture, { audit: [fakeAudit("fixture-a"), fakeAudit("fixture-a")] }),
    /duplicate id in SAMPLE_BUNDLE_AUDIT/,
  );
  assert.throws(
    () => deriveSampleBundleDecisions(catalogFixture, { audit: [fakeAudit("fixture-ghost")] }),
    /not found in samples\/catalog\.v2\.json/,
  );
});

function placeholderFile() {
  return { path: "index.html", bytes: 1, sha256: "c".repeat(64), integrity: "sha256-AA==", mediaType: "text/html" };
}

function placeholderSample(id) {
  const included = INCLUDED_SAMPLES.find((sample) => sample.id === id);
  const entry = catalogById.get(id);
  return {
    id,
    entrypoint: "index.html",
    dataMode: entry?.data.mode ?? "fixture",
    configDefaults: {},
    runtimeHosting: included?.runtimeHosting ?? "self-contained",
    runnability: included?.runnability ?? "standalone",
    hostFixtureRoutes: [...(included?.hostFixtureRoutes ?? [])],
    support: {
      tier: entry?.supportTier ?? "supported",
      track: entry?.track ?? "recipe",
      validationProfile: entry?.validationProfile ?? "browser-recipe",
    },
    lifecycle: { state: "active", reason: entry?.lifecycle.reason ?? "test fixture" },
    builtFrom: { commit: "b".repeat(40), packageVersion: "0.0.0" },
    files: [placeholderFile()],
  };
}

test("validateSampleBundleManifest rejects a manifest whose excluded ids overlap its bundled ids", async () => {
  const manifest = {
    format: "honua.sdk.sample-bundles.v2",
    schemaVersion: 2,
    build: { node: ">=20.0.0", lockfileSha256: "a".repeat(64) },
    samples: INCLUDED_SAMPLE_IDS.map((id) => placeholderSample(id)),
    excluded: [{ id: INCLUDED_SAMPLE_IDS[0], category: "agent-shaped", reason: "duplicate of a bundled sample" }],
  };
  await assert.rejects(validateSampleBundleManifest(manifest), /listed in both samples and excluded/);
});

test("validateSampleBundleManifest rejects runnability truth that drifted from the audited decision", async () => {
  const samples = INCLUDED_SAMPLE_IDS.map((id) => placeholderSample(id));
  const target = samples.find((sample) => sample.runnability === "requires-host-fixture-service");
  assert.ok(target, "at least one published bundle should declare host prerequisites");
  const manifest = {
    format: "honua.sdk.sample-bundles.v2",
    schemaVersion: 2,
    build: { node: ">=20.0.0", lockfileSha256: "a".repeat(64) },
    samples: samples.map((sample) =>
      sample.id === target.id
        ? { ...sample, runnability: "standalone", runtimeHosting: "self-contained", hostFixtureRoutes: [] }
        : sample,
    ),
    excluded: deriveExcludedSamples(catalog),
  };
  await assert.rejects(validateSampleBundleManifest(manifest), /runnability truth drifted from the audited decision/);
});

test("validateSampleBundleManifest cross-checks full catalog coverage when given a catalog", async () => {
  const excluded = deriveExcludedSamples(catalog);
  const completeManifest = {
    format: "honua.sdk.sample-bundles.v2",
    schemaVersion: 2,
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
