import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  buildFragment,
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
};

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
  assert.equal(metadata.contract_revision, `sdk-js-certification@${identity.producerSourceSha}`);
  assert.equal(metadata.auth_policy_revision, "anonymous-public-v1");
  assert.match(metadata.evidence_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(metadata.facet_results), metadata.scenario_facets);
  assert.ok(Object.values(metadata.facet_results).every((facet) => (
    facet.result === "pass" && facet.evidence_digest === metadata.evidence_digest
  )));
  assert.deepEqual(fragment.observations.find((row) => row.surface === "featureserver" && row.operation === "query").failure_messages, ["boom"]);
  const missing = fragment.observations.find((row) => row.surface === "wcs" && row.operation === "get-coverage");
  assert.equal(missing.result, "skip");
  assert.equal(missing.evidence_digest, null);
  assert.equal(missing.facet_results, null);
  assert.match(missing.skip_reason, new RegExp(GAP_OWNER));
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
  assert.equal(communityFragment.observations.some((row) => row.surface === "realtime"), false);
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
