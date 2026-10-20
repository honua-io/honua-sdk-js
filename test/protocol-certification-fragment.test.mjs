import { requirementsContext } from "./fixtures/protocol-requirements-context.mjs";
import "./scripts/integration-candidate.test.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildFragment as buildRawFragment,
  certificationRequested,
  parseRequirementsContext,
  validateRequirementsContext,
  GAP_OWNER,
  LICENSED_PROOF_SCHEMA,
  validateCertificationIdentity,
  validateIdentityOverrideEnvironment,
  validateLicensedProof,
} from "../scripts/protocol-certification-fragment.mjs";
import { createHash } from "node:crypto";

const certificationContract = JSON.parse(readFileSync(new URL("../config/protocol-certification.v1.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const identity = {
  clientVersion: "1.2.3",
  deploymentTarget: "local-docker",
  sourceSha: "a".repeat(40),
  producerSourceSha: "c".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  fixtureRevision: "fixture-1",
  evidenceUri: "https://github.com/honua-io/honua-sdk-js/actions/runs/1",
  cutAt: "2026-08-19T00:00:00Z",
  requestContext: {
    baseUrl: "https://candidate.test/root/",
    serviceId: "places",
    layerId: 0,
    collectionId: "places",
    tileMatrixSetId: "WebMercatorQuad",
    wfsEndpointUrl: "/wfs",
    odataBasePath: "/odata",
    odataEntitySet: "Layers(0)/Features",
  },
};

// Existing normalization controls now use an explicit governed fixture. The
// raw producer is exercised separately below to prove there is no fallback.
function buildFragment(options) {
  return buildRawFragment({
    ...options,
    requirementsContext: requirementsContext(options.identity, Boolean(options.licensedProof)),
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function licensedProof(overrides = {}) {
  const proof = {
    schema: LICENSED_PROOF_SCHEMA,
    verification: "live-server-capability-probe-v1",
    policy_revision: "honua-pro-feature-subscriptions-v1",
    deployment_target: "licensed-release",
    checked_at: "2026-08-19T00:01:00Z",
    license_identity: { license_id: "license-1", edition: "Pro", issued_at: null, validation_state: "Valid" },
    entitlement: { key: "streaming.feature-subscriptions", active: true },
    license_fingerprint: "",
    ...overrides,
  };
  proof.license_fingerprint = overrides.license_fingerprint ?? `sha256:${createHash("sha256").update(canonicalJson({
    license_identity: proof.license_identity,
    entitlement: proof.entitlement,
  })).digest("hex")}`;
  return proof;
}

test("rejects partial self-contained candidate identity overrides", () => {
  assert.throws(
    () => validateIdentityOverrideEnvironment({ HONUA_SELF_CONTAINED_IDENTITY_OVERRIDE_INVALID: "true" }),
    /must be overridden together/,
  );
});

test("ignores self-contained override state for external certification", () => {
  assert.doesNotThrow(() =>
    validateIdentityOverrideEnvironment({
      HONUA_CERTIFICATION_EXTERNAL: "true",
      HONUA_SELF_CONTAINED_IDENTITY_OVERRIDE_INVALID: "true",
    }),
  );
});

test("validates the complete self-contained candidate identity", () => {
  const valid = {
    HONUA_INTEGRATION_SERVER_IMAGE: `ghcr.io/honua/server@sha256:${"a".repeat(64)}`,
    HONUA_INTEGRATION_SERVER_COMMIT: "b".repeat(40),
    HONUA_CANDIDATE_CUT_AT: "2026-08-20T07:58:03Z",
  };
  assert.doesNotThrow(() => validateIdentityOverrideEnvironment(valid));
  assert.throws(
    () => validateIdentityOverrideEnvironment({ ...valid, HONUA_INTEGRATION_SERVER_COMMIT: "main" }),
    /full lowercase commit SHA/,
  );
  assert.throws(
    () => validateIdentityOverrideEnvironment({ ...valid, HONUA_CANDIDATE_CUT_AT: "yesterday" }),
    /UTC ISO-8601/,
  );
  assert.throws(
    () => validateIdentityOverrideEnvironment({ ...valid, HONUA_CANDIDATE_CUT_AT: "2026-02-31T00:00:00Z" }),
    /UTC ISO-8601/,
  );
});

test("validates the resolved external candidate identity", () => {
  assert.doesNotThrow(() => validateCertificationIdentity(identity));
  assert.throws(
    () => validateCertificationIdentity({ ...identity, sourceSha: "A".repeat(40) }),
    /full lowercase commit SHA/,
  );
  assert.throws(
    () => validateCertificationIdentity({ ...identity, imageDigest: `sha256:${"B".repeat(64)}` }),
    /lowercase sha256 digest/,
  );
  assert.throws(
    () => validateCertificationIdentity({ ...identity, cutAt: "2026-02-31T00:00:00Z" }),
    /UTC ISO-8601/,
  );
});

test("normalizes execution and preserves missing operation gaps", () => {
  const fragment = buildFragment({
    identity,
    now: "2026-08-20T00:00:00.000Z",
    reports: [{ testResults: [{
      name: "test/integration/surfaces/feature-service.integration.ts",
      assertionResults: [
        { title: "returns metadata [cert:featureserver/metadata#positive] [cert:featureserver/metadata#metadata] [cert:featureserver/metadata#media-schema]", status: "passed" },
        { title: "queries features [cert:featureserver/query#positive] [cert:featureserver/query#pagination] [cert:featureserver/query#media-schema]", status: "failed", failureMessages: ["boom"] },
        { title: "validates a draft [cert:alerts/evaluation#positive] [cert:alerts/evaluation#media-schema]", status: "passed" },
      ],
    }] }],
  });

  assert.equal(fragment.schema, "honua.protocol-certification-fragment/v1");
  assert.equal(fragment.producer, "honua-sdk-js");
  assert.deepEqual(fragment.candidate, {
    source_sha: identity.sourceSha,
    image_digest: identity.imageDigest,
    cut_at: identity.cutAt,
  });
  assert.equal(fragment.operation_scope.complete, true);
  const metadata = fragment.observations.find((row) => row.surface === "featureserver" && row.operation === "metadata");
  assert.equal(metadata.result, "pass");
  assert.equal(metadata.capability_key, "serve.geoservices-featureserver");
  assert.deepEqual(metadata.scenario_facets, ["positive", "metadata", "media-schema"]);
  assert.equal(metadata.canonical_client, "@honua/sdk-js");
  assert.equal(metadata.client_id, metadata.canonical_client);
  assert.equal(metadata.runner_lane, "sdk-js-certification");
  assert.equal(metadata.protocol_version, "11.0");
  assert.equal(metadata.protocol_profile, "GeoServices REST");
  assert.equal(metadata.performed_by, metadata.client_id);
  assert.equal(metadata.request_url, "https://candidate.test/rest/services/places/FeatureServer/0");
  assert.deepEqual(metadata.exercised_capabilities, metadata.scenario_facets);
  assert.equal(metadata.contract_revision, `sdk-js-certification@${identity.producerSourceSha}`);
  assert.equal(metadata.auth_policy_revision, "anonymous-public-v1");
  assert.match(metadata.evidence_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(metadata.facet_results), metadata.scenario_facets);
  assert.ok(Object.values(metadata.facet_results).every((facet) => (
    facet.result === "pass" && facet.evidence_digest === metadata.evidence_digest
  )));
  assert.deepEqual(fragment.observations.find((row) => row.surface === "featureserver" && row.operation === "query").failure_messages, ["boom"]);
  assert.equal(fragment.observations.find((row) => row.surface === "alerts" && row.operation === "evaluation").result, "pass");
  const missing = fragment.observations.find((row) => row.surface === "wcs" && row.operation === "get-coverage");
  assert.equal(missing.result, "skip");
  assert.equal(missing.evidence_digest, null);
  assert.equal(missing.facet_results, null);
  assert.match(missing.skip_reason, new RegExp(GAP_OWNER));
  assert.equal(missing.protocol_version, "2.0.1");
  assert.deepEqual(missing.exercised_capabilities, []);
});

test("credentialed base URLs are rejected before any evidence is emitted", () => {
  const poisoned = structuredClone(identity);
  poisoned.requestContext.baseUrl = "https://user:secret@candidate.test/root/";
  assert.throws(() => buildFragment({ identity: poisoned, reports: [] }), /must not contain credentials/);
});

test("odata entity pages default to the harness entity set instead of undefined", () => {
  const bare = structuredClone(identity);
  delete bare.requestContext.odataEntitySet;
  const fragment = buildFragment({ identity: bare, reports: [] });
  const odata = fragment.observations.find((o) => o.surface === "odata" && o.operation !== "metadata");
  assert.ok(odata.request_url.endsWith("/odata/Layers(0)/Features"));
  assert.ok(!odata.request_url.includes("undefined"));
});

test("the tile operation certifies a tile request URL, not tileset discovery", () => {
  const fragment = buildFragment({ identity, reports: [] });
  const tile = fragment.observations.find((o) => o.surface === "ogc-tiles" && o.operation === "tile");
  assert.ok(tile.request_url.includes("/tiles/WebMercatorQuad/0/0/0"));
});

test("every observation satisfies the truthful identity ingest assertions", () => {
  const fragment = buildFragment({ identity, reports: [] });
  for (const observation of fragment.observations) {
    assert.equal(observation.client_id, observation.canonical_client);
    assert.equal(observation.runner_lane, "sdk-js-certification");
    assert.equal(observation.performed_by, observation.client_id);
    assert.ok(observation.protocol_version.length > 0);
    assert.ok(observation.protocol_profile.length > 0);
    if (observation.request_url === null) {
      assert.equal(observation.surface, "realtime");
      assert.equal(observation.result, "skip");
    } else {
      const requestUrl = new URL(observation.request_url);
      assert.ok(["http:", "https:"].includes(requestUrl.protocol));
    }
    assert.ok(Array.isArray(observation.exercised_capabilities));
    if (observation.result === "pass") {
      assert.ok(observation.scenario_facets.every((facet) => observation.exercised_capabilities.includes(facet)));
    }
  }
});

test("marks evidence incomplete when a suite report is unavailable", () => {
  const fragment = buildFragment({
    identity,
    complete: false,
    reports: [],
    now: "2026-08-20T00:00:00.000Z",
  });

  assert.equal(fragment.operation_scope.complete, false);
  assert.ok(fragment.observations.every((row) => row.result === "skip"));
});

test("machine-readable certification contract matches emitted operation identities", () => {
  const communityFragment = buildFragment({ identity, reports: [] });
  assert.equal(communityFragment.observations.length, 67);
  assert.equal(communityFragment.observations.filter((row) => row.surface === "realtime").length, 2);
  assert.ok(communityFragment.observations.filter((row) => row.surface === "realtime").every((row) => row.result === "skip" && row.evidence_receipt === null));
  const licensedIdentity = {
    ...identity,
    deploymentTarget: "licensed-release",
    startedAt: "2026-08-19T00:00:00Z",
  };
  const fragment = buildFragment({
    identity: licensedIdentity,
    licensedProof: licensedProof(),
    reports: [{ testResults: [{
      name: "test/integration/surfaces/realtime.integration.ts Realtime SSE",
      assertionResults: [
        { title: "subscribes and decodes [cert:realtime/subscribe#positive] [cert:realtime/subscribe#media-schema]", status: "passed" },
        { title: "resumes after reconnect [cert:realtime/resume#positive] [cert:realtime/resume#media-schema]", status: "passed" },
      ],
    }] }],
    now: "2026-08-19T00:02:00Z",
  });
  assert.deepEqual(
    fragment.observations.map(({ capability_key, surface, operation, scenario_facets }) => ({
      capability_key,
      surface,
      operation,
      scenario_facets,
    })),
    certificationContract.operations.filter(({ surface }) => surface === "realtime"),
  );
  assert.ok(fragment.observations.every(({ deployment_target }) => deployment_target === "licensed-release"));
  assert.equal(certificationContract.canonicalClient, "@honua/sdk-js");
  assert.equal(certificationContract.clientVersion, packageJson.version);
  assert.equal("fixtureRevision" in certificationContract, false);
  assert.throws(
    () => buildFragment({
      identity: licensedIdentity,
      licensedProof: licensedProof(),
      reports: [],
      now: "2026-08-19T00:02:00Z",
    }),
    /licensed certification requires realtime\/subscribe to pass; observed skip/,
  );
  assert.throws(
    () => buildFragment({
      identity: licensedIdentity,
      licensedProof: licensedProof(),
      reports: [{ testResults: [{
        name: "test/integration/surfaces/realtime.integration.ts Realtime SSE",
        assertionResults: [
          { title: "subscribes and decodes [cert:realtime/subscribe#positive] [cert:realtime/subscribe#media-schema]", status: "passed" },
        ],
      }] }],
      now: "2026-08-19T00:02:00Z",
    }),
    /licensed certification requires realtime\/resume to pass; observed skip/,
  );
});

test("accepts only a digest-bound closed licensed proof", () => {
  const proof = licensedProof();
  assert.doesNotThrow(() => validateLicensedProof(proof, "licensed-release"));
  assert.throws(
    () => validateLicensedProof({ ...proof, license_fingerprint: `sha256:${"0".repeat(64)}` }, "licensed-release"),
    /fingerprint does not match/,
  );
  assert.throws(
    () => validateLicensedProof(licensedProof({ entitlement: { key: "streaming.feature-subscriptions", active: false } }), "licensed-release"),
    /active streaming entitlement/,
  );
  assert.throws(
    () => buildFragment({
      identity: { ...identity, entitlementPolicyRevision: "honua-pro-feature-subscriptions-v1" },
      reports: [],
    }),
    /closed proof artifact/,
  );
  assert.throws(
    () => buildFragment({
      identity: {
        ...identity,
        deploymentTarget: "licensed-release",
        startedAt: "2026-08-19T00:02:00Z",
      },
      licensedProof: licensedProof(),
      reports: [],
      now: "2026-08-19T00:03:00Z",
    }),
    /within the certification execution interval/,
  );
});

test("production integration tests declare every currently executable certification marker", () => {
  const surfaces = new URL("integration/surfaces/", import.meta.url);
  const source = readdirSync(surfaces)
    .filter((name) => name.endsWith(".integration.ts"))
    .map((name) => readFileSync(new URL(name, surfaces), "utf8"))
    .join("\n");
  const missingOperations = certificationContract.operations
    .filter(({ surface, operation, scenario_facets }) =>
      scenario_facets.some((facet) => !source.includes(`[cert:${surface}/${operation}#${facet}]`))
    )
    .map(({ surface, operation }) => `${surface}/${operation}`);

  assert.deepEqual(missingOperations, [
    "featureserver/add-features",
    "featureserver/update-features",
    "featureserver/delete-features",
    "featureserver/attachments",
    "geocoding/reverse",
    "ogc-coverages/landing",
    "ogc-coverages/conformance",
    "ogc-coverages/coverage",
    "routing/solve",
    "wcs/capabilities",
    "wcs/get-coverage",
  ]);
});

test("matches canonical assertion wording without certifying neighboring operations", () => {
  const fragment = buildFragment({
    identity,
    now: "2026-08-20T00:00:00.000Z",
    reports: [{ testResults: [
      {
        name: "MapServer integration",
        assertionResults: [{ title: "queries features [cert:mapserver/query#positive] [cert:mapserver/query#pagination] [cert:mapserver/query#media-schema]", status: "passed" }],
      },
      {
        name: "STAC integration",
        assertionResults: [{
          title: "fetches collection [cert:stac/collection#positive] [cert:stac/collection#metadata] [cert:stac/collection#media-schema]",
          status: "passed",
        }],
      },
      {
        name: "OGC Processes integration",
        assertionResults: [{ title: "returns conformance [cert:ogc-processes/conformance#positive] [cert:ogc-processes/conformance#metadata] [cert:ogc-processes/conformance#media-schema]", status: "passed" }],
      },
    ] }],
  });

  const row = (surface, operation) => fragment.observations.find(
    (candidate) => candidate.surface === surface && candidate.operation === operation,
  );
  assert.equal(row("mapserver", "query").result, "pass");
  assert.equal(row("stac", "collection").result, "pass");
  assert.equal(row("ogc-processes", "conformance").result, "pass");
  assert.equal(row("ogc-processes", "list").result, "skip");
});

test("keeps WMTS capabilities independent from the tile assertion", () => {
  const fragment = buildFragment({
    identity,
    reports: [{ testResults: [{
      name: "test/integration/surfaces/wmts.integration.ts WMTS",
      assertionResults: [
        { title: "reads service capabilities [cert:wmts/capabilities#positive] [cert:wmts/capabilities#metadata] [cert:wmts/capabilities#media-schema]", status: "passed" },
        { title: "fetches tile [cert:wmts/get-tile#positive] [cert:wmts/get-tile#media-schema]", status: "failed" },
      ],
    }] }],
  });
  const row = (operation) => fragment.observations.find(
    (candidate) => candidate.surface === "wmts" && candidate.operation === operation,
  );

  assert.equal(row("capabilities").result, "pass");
  assert.equal(row("get-tile").result, "fail");
});

test("certifies OGC Features conformance only from the dedicated endpoint assertion", () => {
  const fragment = buildFragment({
    identity,
    reports: [{ testResults: [
      {
        name: "test/conformance/feature-service.conformance.ts",
        assertionResults: [{ title: "preserves the conformance projection shape", status: "passed" }],
      },
      {
        name: "test/integration/surfaces/ogc-features.integration.ts OGC API Features",
        assertionResults: [{
          ancestorTitles: [
            "[cert:ogc-features/conformance#positive]",
            "[cert:ogc-features/conformance#metadata]",
            "[cert:ogc-features/conformance#media-schema]",
          ],
          title: "declares OGC Features conformance classes",
          status: "failed",
        }],
      },
    ] }],
  });

  const conformance = fragment.observations.find(
    (candidate) => candidate.surface === "ogc-features" && candidate.operation === "conformance",
  );
  assert.equal(conformance.result, "fail");
});


test("v2 receipt binds governed maturity, tier, revision and candidate cut in its digest", () => {
  const context = requirementsContext(identity);
  const options = {
    identity, requirementsContext: context, now: "2026-08-20T00:00:00.000Z",
    reports: [{ testResults: [{ name: "FeatureServer", assertionResults: [{
      title: "metadata [cert:featureserver/metadata#positive] [cert:featureserver/metadata#metadata] [cert:featureserver/metadata#media-schema]",
      status: "passed",
    }] }] }],
  };
  const before = buildRawFragment(options).observations.find((row) => row.surface === "featureserver" && row.operation === "metadata");
  assert.equal(before.evidence_receipt.schema, "honua.certification-evidence-receipt/v2");
  assert.equal(before.evidence_receipt.identity.maturity, "preview");
  assert.equal(before.evidence_receipt.identity.required_tier, "nightly");
  assert.equal(before.evidence_receipt.identity.requirements_revision, context.requirements_revision);
  assert.equal(before.evidence_receipt.identity.candidate_cut_at, identity.cutAt);
  assert.equal(before.evidence_digest, `sha256:${createHash("sha256").update(canonicalJson(before.evidence_receipt)).digest("hex")}`);
  const requirement = context.requirements.find((row) => row.surface === "featureserver" && row.operation === "metadata");
  for (const [key, value] of [["maturity", "supported"], ["required_tier", "release"]]) {
    const changed = structuredClone(context);
    changed.requirements.find((row) => row.surface === "featureserver" && row.operation === "metadata")[key] = value;
    const after = buildRawFragment({ ...options, requirementsContext: changed }).observations.find((row) => row.surface === "featureserver" && row.operation === "metadata");
    assert.equal(after.evidence_receipt.identity[key], value);
    assert.notEqual(after.evidence_digest, before.evidence_digest);
    assert.equal(requirement[key], before.evidence_receipt.identity[key]);
  }
  const after = buildRawFragment({ ...options, requirementsContext: { ...context, requirements_revision: "next-reviewed-revision" } }).observations.find((row) => row.surface === "featureserver" && row.operation === "metadata");
  assert.notEqual(after.evidence_digest, before.evidence_digest);
});

test("context-less, v1 and incomplete contexts cannot produce a fragment", () => {
  for (const context of [undefined, null, {}, { ...requirementsContext(identity), schema: "honua.certification-evidence-receipt/v1" }]) {
    assert.throws(() => buildRawFragment({ identity, reports: [], requirementsContext: context }), /closed producer-context/);
  }
});

test("context refuses changed producer, candidate and every governed execution field", () => {
  const mutations = [
    (c) => { c.producer = "other-producer"; },
    (c) => { c.producer_source_sha = "d".repeat(40); },
    (c) => { c.candidate.source_sha = "d".repeat(40); },
    (c) => { c.candidate.image_digest = `sha256:${"d".repeat(64)}`; },
    (c) => { c.candidate.cut_at = "2026-08-20T00:00:00Z"; },
    (c) => { c.requirements_revision = " "; },
    (c) => { c.unknown = true; },
    (c) => { c.candidate.unknown = true; },
    (c) => { c.requirements.pop(); },
    (c) => { c.requirements[1] = structuredClone(c.requirements[0]); },
    (c) => { c.requirements[0].operation = "unknown"; },
    (c) => { c.requirements[0].scenario_facets = ["positive"]; },
    (c) => { c.requirements[0].scenario_facets.push("positive"); },
    (c) => { c.requirements[0].maturity = "ga"; },
    (c) => { c.requirements[0].required_tier = "optional"; },
    (c) => { delete c.requirements[0].maturity; },
    (c) => { c.requirements[0].unknown = true; },
    (c) => { c.requirements[0].test_ids = ["invented-test"]; },
    ...["capability_key", "canonical_client", "client_version", "client_lane", "deployment_target", "fixture_revision", "contract_revision", "auth_policy_revision"].map((key) => (c) => { c.requirements[0][key] = "wrong"; }),
  ];
  for (const mutate of mutations) {
    const context = requirementsContext(identity);
    mutate(context);
    assert.throws(() => validateRequirementsContext(context, identity), /requirements_context/);
  }
});

test("workflow distinguishes runtime-only runs and mandatory certification context", () => {
  assert.equal(certificationRequested({}), false);
  assert.equal(certificationRequested({ HONUA_REQUIREMENTS_CONTEXT: " ", HONUA_LICENSED_CERTIFICATION: "false" }), false);
  assert.throws(() => certificationRequested({ HONUA_NIGHTLY_DISPATCH_ID: "nightly-1" }), /requires requirements_context/);
  assert.throws(() => certificationRequested({ HONUA_LICENSED_CERTIFICATION: "true" }), /requires requirements_context/);
  assert.throws(() => certificationRequested({ HONUA_REQUIREMENTS_CONTEXT: "not json" }), SyntaxError);
  assert.equal(certificationRequested({ HONUA_REQUIREMENTS_CONTEXT: JSON.stringify(requirementsContext(identity)) }), true);
  const workflow = readFileSync(new URL("../.github/workflows/integration.yml", import.meta.url), "utf8");
  assert.match(workflow, /HONUA_REQUIREMENTS_CONTEXT: \$\{\{ inputs.requirements_context \}\}/);
  assert.match(workflow, /name: Emit protocol certification fragment\n        if: \$\{\{ always\(\) && steps.certification.outputs.enabled == 'true' \}\}/);
  assert.match(workflow, /name: Run live conformance round-trip\n        if: always\(\)/);
});

test("requirements context size limit is UTF-8 bytes, not characters", () => {
  const atLimit = '"' + "x".repeat(59998) + '"';
  assert.equal(parseRequirementsContext(atLimit).length, 59998);
  assert.throws(() => parseRequirementsContext('"' + "é".repeat(30000) + '"'), /60000 UTF-8 bytes/);
  assert.throws(() => parseRequirementsContext(""), /requires requirements_context/);
});


test("actual CLI emits only context-bound v2 and refuses mismatches without an artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "honua-certification-v2-"));
  try {
    const execution = { ...identity, clientVersion: packageJson.version };
    const context = requirementsContext(execution);
    const contextPath = join(directory, "context.json");
    const reportsPath = join(directory, "reports.json");
    const metadataPath = join(directory, "metadata.json");
    const output = join(directory, "fragment.json");
    writeFileSync(contextPath, JSON.stringify(context));
    writeFileSync(reportsPath, JSON.stringify({ testResults: [{ name: "FeatureServer", assertionResults: [{
      title: "metadata [cert:featureserver/metadata#positive] [cert:featureserver/metadata#metadata] [cert:featureserver/metadata#media-schema]", status: "passed",
    }] }] }));
    writeFileSync(metadataPath, JSON.stringify({ baseUrl: identity.requestContext.baseUrl }));
    const args = [fileURLToPath(new URL("../scripts/protocol-certification-fragment.mjs", import.meta.url)),
      "--reports", reportsPath, "--metadata", metadataPath, "--output", output,
      "--deployment-target", identity.deploymentTarget, "--source-sha", identity.sourceSha,
      "--producer-source-sha", identity.producerSourceSha, "--image-digest", identity.imageDigest,
      "--fixture-revision", identity.fixtureRevision, "--candidate-cut-at", identity.cutAt,
      "--evidence-uri", identity.evidenceUri,
    ];
    const run = (extra = []) => spawnSync(process.execPath, [...args, ...extra], {
      cwd: directory, env: { HONUA_CERTIFICATION_EXTERNAL: "true" }, encoding: "utf8",
    });
    const absent = run();
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /requires requirements_context/);
    assert.equal(existsSync(output), false);
    const passed = run(["--requirements-context", contextPath]);
    assert.equal(passed.status, 0, passed.stderr);
    const fragment = JSON.parse(readFileSync(output, "utf8"));
    const receipt = fragment.observations.find((row) => row.result === "pass").evidence_receipt;
    assert.equal(receipt.schema, "honua.certification-evidence-receipt/v2");
    assert.equal(receipt.identity.requirements_revision, context.requirements_revision);
    rmSync(output);
    context.candidate.source_sha = "d".repeat(40);
    writeFileSync(contextPath, JSON.stringify(context));
    const refused = run(["--requirements-context", contextPath]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /candidate does not match/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("actual workflow preflight emits runtime-only status and refuses missing certification context", () => {
  const workflow = readFileSync(new URL("../.github/workflows/integration.yml", import.meta.url), "utf8");
  const step = workflow.slice(workflow.indexOf("      - name: Validate certification context availability"));
  const script = step.split("        run: |\n")[1].split("\n\n")[0]
    .split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(join(tmpdir(), "honua-context-preflight-"));
  try {
    const scriptPath = join(directory, "preflight.sh");
    writeFileSync(scriptPath, script);
    const run = (name, environment) => {
      const output = join(directory, name);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", scriptPath], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...environment }, encoding: "utf8",
      });
      return { ...result, output };
    };
    const ordinary = run("ordinary", {});
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(readFileSync(ordinary.output, "utf8"), "enabled=false\n");
    assert.match(ordinary.stdout, /Runtime integration only/);
    const certification = run("certification", { HONUA_REQUIREMENTS_CONTEXT: JSON.stringify(requirementsContext(identity)) });
    assert.equal(certification.status, 0, certification.stderr);
    assert.equal(readFileSync(certification.output, "utf8"), "enabled=true\n");
    for (const [name, env] of [["nightly", { HONUA_NIGHTLY_DISPATCH_ID: "nightly-certification-1-1" }], ["licensed", { HONUA_LICENSED_CERTIFICATION: "true" }]]) {
      const refused = run(name, env);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /requires requirements_context/);
      assert.equal(existsSync(refused.output), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("catalog revision grammar matches the shared release and server contract", () => {
  for (const revision of ["release/2026.1", "2026-10-13.1", "A" + "x".repeat(199)]) {
    const context = requirementsContext(identity);
    context.requirements_revision = revision;
    assert.doesNotThrow(() => validateRequirementsContext(context, identity));
  }
  for (const revision of ["", " ", " leading", "trailing ", "line\nbreak", "trailing\n", "trailing\r\n", "-leading", "/leading", "é", "x".repeat(201), null, 7]) {
    const context = requirementsContext(identity);
    context.requirements_revision = revision;
    assert.throws(() => validateRequirementsContext(context, identity), /valid bounded requirements_revision/);
  }
});


test("full nightly roster retains licensed skips even when unlicensed reports contain passing markers", () => {
  const context = requirementsContext(identity);
  const fragment = buildRawFragment({ identity, requirementsContext: context, reports: [{ testResults: [{
    name: "Realtime SSE", assertionResults: [
      { title: "subscribes [cert:realtime/subscribe#positive] [cert:realtime/subscribe#media-schema]", status: "passed" },
      { title: "resumes [cert:realtime/resume#positive] [cert:realtime/resume#media-schema]", status: "passed" },
    ],
  }] }] });
  assert.equal(fragment.observations.length, 67);
  assert.equal(fragment.operation_scope.complete, true);
  for (const row of fragment.observations.filter((item) => item.surface === "realtime")) {
    assert.equal(row.result, "skip");
    assert.equal(row.deployment_target, "licensed-release");
    assert.equal(row.auth_policy_revision, "api-key-protected-v1");
    assert.equal(row.required_tier, "release");
    assert.equal(row.evidence_receipt, null);
    assert.equal(row.request_url, null);
    assert.equal(row.evidence_digest, null);
    assert.equal(row.facet_results, null);
    assert.deepEqual(row.exercised_capabilities, []);
    assert.match(row.skip_reason, /not executed.*live entitlement proof/);
  }
  for (const mutate of [
    (c) => { c.requirements = c.requirements.filter((row) => row.surface !== "realtime"); },
    (c) => { c.requirements.find((row) => row.surface === "realtime").deployment_target = "local-docker"; },
    (c) => { c.requirements.find((row) => row.surface === "realtime").auth_policy_revision = "anonymous-public-v1"; },
    ...["client_version", "client_lane", "canonical_client", "capability_key", "contract_revision", "fixture_revision"].map((field) => (c) => {
      c.requirements.find((row) => row.surface === "realtime")[field] = "foreign-value";
    }),
  ]) {
    const invalid = structuredClone(context);
    mutate(invalid);
    assert.throws(() => buildRawFragment({ identity, requirementsContext: invalid, reports: [] }), /requirements_context/);
  }
});
