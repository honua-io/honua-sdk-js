import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildFragment, GAP_OWNER } from "../scripts/protocol-certification-fragment.mjs";

const certificationContract = JSON.parse(readFileSync(new URL("../config/protocol-certification.v1.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const identity = {
  clientVersion: "1.2.3",
  deploymentTarget: "local-docker",
  sourceSha: "a".repeat(40),
  producerSourceSha: "c".repeat(40),
  imageDigest: `sha256:${"b".repeat(64)}`,
  fixtureRevision: "fixture-1",
  evidenceUri: "https://example.test/run/1",
  cutAt: "2026-08-19T00:00:00Z",
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
  assert.equal(metadata.auth_policy_revision, "anonymous-and-protected-v1");
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

  assert.equal(fragment.operation_scope.complete, false);
  assert.ok(fragment.observations.every((row) => row.result === "skip"));
});

test("machine-readable certification contract matches emitted operation identities", () => {
  const fragment = buildFragment({ identity, reports: [] });
  assert.deepEqual(
    fragment.observations.map(({ capability_key, surface, operation, scenario_facets }) => ({
      capability_key,
      surface,
      operation,
      scenario_facets,
    })),
    certificationContract.operations,
  );
  assert.equal(certificationContract.canonicalClient, "@honua/sdk-js");
  assert.equal(certificationContract.clientVersion, packageJson.version);
  assert.equal("fixtureRevision" in certificationContract, false);
});

test("matches canonical assertion wording without certifying neighboring operations", () => {
  const fragment = buildFragment({
    identity,
    now: "2026-08-20T00:00:00.000Z",
    reports: [{ testResults: [
      {
        name: "MapServer integration",
        assertionResults: [{ title: "queries features", status: "passed" }],
      },
      {
        name: "STAC integration",
        assertionResults: [{
          title: "fetches the configured STAC collection when it is advertised",
          status: "passed",
        }],
      },
      {
        name: "OGC Processes integration",
        assertionResults: [{ title: "returns conformance", status: "passed" }],
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
        { title: "reads service capabilities", status: "passed" },
        { title: "fetches a tile at zoom 0,0,0 when capabilities advertise a layer", status: "failed" },
      ],
    }] }],
  });
  const row = (operation) => fragment.observations.find(
    (candidate) => candidate.surface === "wmts" && candidate.operation === operation,
  );

  assert.equal(row("capabilities").result, "pass");
  assert.equal(row("get-tile").result, "fail");
});
