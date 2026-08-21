#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const GAP_OWNER = "https://github.com/honua-io/honua-sdk-js/issues/1113";
export const AUTH_POLICY_REVISION = "anonymous-public-v1";

const CAPABILITIES = {
  featureserver: "serve.geoservices-featureserver",
  geocoding: "serve.geoservices-geocodeserver",
  geometryserver: "serve.geoservices-geometry-service",
  gpserver: "process.geoprocessing",
  "grpc-web": "grpc.web",
  imageserver: "serve.geoservices-imageserver",
  mapserver: "serve.geoservices-mapserver",
  odata: "serve.odata",
  "ogc-features": "serve.ogc-api-features",
  "ogc-maps": "serve.ogc-api-maps",
  "ogc-processes": "process.ogc-api-processes",
  "ogc-records": "serve.ogc-api-records",
  "ogc-tiles": "serve.ogc-api-tiles",
  "ogc-coverages": "serve.ogc-api-coverages",
  realtime: "streaming.feature-subscriptions",
  routing: "routing.solve",
  stac: "serve.stac",
  wcs: "serve.wcs",
  wfs: "serve.wfs",
  wms: "serve.wms",
  wmts: "serve.wmts",
};

const OPERATIONS = [
  ["featureserver", "metadata", /feature[-_ ]?(?:server|service)/i, /metadata/i],
  ["featureserver", "query", /feature[-_ ]?(?:server|service)/i, /quer(y|ies).*feature/i],
  ["featureserver", "count", /feature[-_ ]?(?:server|service)/i, /count/i],
  ["featureserver", "object-ids", /feature[-_ ]?(?:server|service)/i, /object.?ids?/i],
  ["featureserver", "add-features", /feature[-_ ]?(?:server|service)/i, /add.?features/i],
  ["featureserver", "update-features", /feature[-_ ]?(?:server|service)/i, /update.?features/i],
  ["featureserver", "delete-features", /feature[-_ ]?(?:server|service)/i, /delete.?features/i],
  ["featureserver", "attachments", /feature[-_ ]?(?:server|service)/i, /attachment/i],
  ["geocoding", "forward", /geocod/i, /forward|find.?address|suggest/i],
  ["geocoding", "reverse", /geocod/i, /reverse/i],
  ["geometryserver", "project", /geometry.?server/i, /project/i],
  ["geometryserver", "buffer", /geometry.?server/i, /buffer/i],
  ["gpserver", "submit-job", /gp.?server|geoprocess/i, /submit/i],
  ["gpserver", "job-status", /gp.?server|geoprocess/i, /status|poll/i],
  ["grpc-web", "query", /grpc.?web/i, /query/i],
  ["grpc-web", "rest-parity", /grpc.?web/i, /parity/i],
  ["grpc-web", "authentication", /grpc.?web/i, /auth/i],
  ["grpc-web", "retry", /grpc.?web/i, /retry|backoff/i],
  ["imageserver", "metadata", /image.?server/i, /metadata/i],
  ["imageserver", "export-image", /image.?server/i, /export/i],
  ["mapserver", "metadata", /map.?server/i, /metadata/i],
  ["mapserver", "query", /map.?server/i, /quer(?:y|ies)/i],
  ["mapserver", "count", /map.?server/i, /count/i],
  ["mapserver", "export", /map.?server/i, /export/i],
  ["odata", "metadata", /odata/i, /metadata/i],
  ["odata", "entity-page", /odata/i, /entit|page|list/i],
  ["ogc-features", "landing", /ogc.*feature/i, /landing/i],
  ["ogc-features", "conformance", /ogc.*feature/i, /conformance/i, /^declares OGC Features conformance classes$/i],
  ["ogc-features", "collections", /ogc.*feature/i, /collections/i],
  ["ogc-features", "items", /ogc.*feature/i, /items|paginated/i],
  ["ogc-features", "item", /ogc.*feature/i, /item.*id|single.?item/i],
  ["ogc-maps", "landing", /ogc.*map/i, /landing/i],
  ["ogc-maps", "conformance", /ogc.*map/i, /conformance/i],
  ["ogc-maps", "render", /ogc.*map/i, /render|map image/i],
  ["ogc-processes", "landing", /ogc.*process/i, /landing/i],
  ["ogc-processes", "conformance", /ogc.*process/i, /conformance/i],
  ["ogc-processes", "list", /ogc.*process/i, /list(?:s|ing)?(?:\s+the)?\s+process(?:es)?|available processes/i],
  ["ogc-processes", "describe", /ogc.*process/i, /describe/i],
  ["ogc-records", "landing", /ogc.*record/i, /landing/i],
  ["ogc-records", "conformance", /ogc.*record/i, /conformance/i],
  ["ogc-records", "collections", /ogc.*record/i, /collections/i],
  ["ogc-records", "search", /ogc.*record/i, /search/i],
  ["ogc-records", "cursor-pagination", /ogc.*record/i, /cursor|pagination/i],
  ["ogc-tiles", "landing", /ogc.*tile/i, /landing/i],
  ["ogc-tiles", "conformance", /ogc.*tile/i, /conformance/i],
  ["ogc-tiles", "tile-matrix-sets", /ogc.*tile/i, /matrix.*set/i],
  ["ogc-tiles", "tilesets", /ogc.*tile/i, /tilesets/i],
  ["ogc-tiles", "tile", /ogc.*tile/i, /fetch.*tile|tile request/i],
  ["ogc-coverages", "landing", /ogc.*coverage/i, /landing/i],
  ["ogc-coverages", "conformance", /ogc.*coverage/i, /conformance/i],
  ["ogc-coverages", "coverage", /ogc.*coverage/i, /coverage|subset/i],
  ["realtime", "subscribe", /realtime|sse/i, /subscribe|decode/i],
  ["realtime", "resume", /realtime|sse/i, /reconnect|resume/i],
  ["routing", "solve", /routing|route/i, /solve|route/i],
  ["stac", "landing", /stac/i, /landing/i],
  ["stac", "collections", /stac/i, /collections/i],
  ["stac", "collection", /stac/i, /collection.*(?:get|id|advertis)|fetch.*collection|single.?collection/i],
  ["stac", "search", /stac/i, /search/i],
  ["wcs", "capabilities", /\bwcs\b/i, /capabilities/i],
  ["wcs", "get-coverage", /\bwcs\b/i, /coverage/i],
  ["wfs", "capabilities", /\bwfs\b/i, /capabilities/i],
  ["wfs", "get-feature", /\bwfs\b/i, /feature|page/i],
  ["wms", "capabilities", /\bwms\b/i, /capabilities/i],
  ["wms", "get-map", /\bwms\b/i, /get.?map|map image/i],
  ["wmts", "capabilities", /\bwmts\b/i, /reads service capabilities/i],
  ["wmts", "get-tile", /\bwmts\b/i, /tile/i],
];

function assertions(report) {
  return (report?.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).map((test) => ({
      text: [suite.name, ...(test.ancestorTitles ?? []), test.fullName, test.title].filter(Boolean).join(" "),
      title: String(test.title ?? ""),
      status: String(test.status ?? "unknown").toLowerCase(),
      failures: test.failureMessages ?? [],
    })),
  );
}

function statusFor(matches) {
  if (matches.some(({ status }) => ["failed", "fail"].includes(status))) return "fail";
  if (matches.some(({ status }) => ["passed", "pass"].includes(status))) return "pass";
  return "skip";
}

function facetStatus(surface, operation, facet, matches) {
  const governedTestId = "[cert:" + surface + "/" + operation + "#" + facet + "]";
  return statusFor(matches.filter(({ text }) => text.includes(governedTestId)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ":" + canonicalJson(value[key]),
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function facetsFor(operation) {
  const facets = ["positive"];
  if (/metadata|landing|conformance|capabilities|collections|list|describe/.test(operation)) facets.push("metadata");
  if (/query|items|entity-page|cursor-pagination|object-ids/.test(operation)) facets.push("pagination");
  if (operation === "authentication") facets.push("auth");
  if (/retry|invalid/.test(operation)) facets.push("negative");
  facets.push("media-schema");
  return facets;
}

export function buildFragment({ reports, identity, complete = true, now = new Date().toISOString() }) {
  const tests = reports.flatMap(assertions);
  const payloadBase64 = Buffer.from(JSON.stringify(reports), "utf8").toString("base64");
  return {
    schema: "honua.protocol-certification-fragment/v1",
    producer: "honua-sdk-js",
    generated_at: now,
    candidate: {
      source_sha: identity.sourceSha,
      image_digest: identity.imageDigest,
      cut_at: identity.cutAt,
    },
    operation_scope: { complete, owner_issue: GAP_OWNER },
    observations: OPERATIONS.map(([surface, operation, surfacePattern, operationPattern, titlePattern]) => {
      const matches = tests.filter(({ text, title }) =>
        surfacePattern.test(text) && operationPattern.test(text) && (!titlePattern || titlePattern.test(title))
      );
      const scenarioFacets = facetsFor(operation);
      const facetStatuses = Object.fromEntries(
        scenarioFacets.map((facet) => [facet, facetStatus(surface, operation, facet, matches)]),
      );
      const result = Object.values(facetStatuses).some((status) => status === "fail")
        ? "fail"
        : Object.values(facetStatuses).every((status) => status === "pass") ? "pass" : "skip";
      const normalizedFacets = Object.fromEntries(
        scenarioFacets.map((facet) => [facet, facetStatuses[facet] === "pass" ? "pass" : "fail"]),
      );
      const startedAt = identity.startedAt ?? now;
      const contractRevision = `sdk-js-certification@${identity.producerSourceSha}`;
      const evidenceReceipt = result === "skip" ? null : {
        schema: "honua.certification-evidence-receipt/v1",
        identity: {
          capability_key: CAPABILITIES[surface],
          surface,
          operation,
          canonical_client: "@honua/sdk-js",
          client_version: identity.clientVersion,
          deployment_target: identity.deploymentTarget,
          source_sha: identity.sourceSha,
          producer_source_sha: identity.producerSourceSha,
          image_digest: identity.imageDigest,
          fixture_revision: identity.fixtureRevision,
          contract_revision: contractRevision,
          auth_policy_revision: AUTH_POLICY_REVISION,
          started_at: startedAt,
          completed_at: now,
        },
        result,
        facets: normalizedFacets,
        payload_base64: payloadBase64,
      };
      const evidenceDigest = evidenceReceipt === null ? null
        : `sha256:${createHash("sha256").update(canonicalJson(evidenceReceipt)).digest("hex")}`;
      return {
        capability_key: CAPABILITIES[surface],
        surface,
        operation,
        scenario_facets: scenarioFacets,
        canonical_client: "@honua/sdk-js",
        client_version: identity.clientVersion,
        deployment_target: identity.deploymentTarget,
        result,
        skip_reason: result === "skip" ? `No executable canonical SDK test matched this required operation; owner: ${GAP_OWNER}` : null,
        source_sha: identity.sourceSha,
        producer_source_sha: identity.producerSourceSha,
        image_digest: identity.imageDigest,
        fixture_revision: identity.fixtureRevision,
        contract_revision: contractRevision,
        auth_policy_revision: AUTH_POLICY_REVISION,
        evidence_uri: result === "skip" ? null : `https://evidence.honua.io/data/sha256/${evidenceDigest.slice(7)}`,
        evidence_digest: result === "skip" ? null : evidenceDigest,
        evidence_receipt: result === "skip" ? null : evidenceReceipt,
        facet_results: result === "skip" ? null : Object.fromEntries(
          scenarioFacets.map((facet) => [
            facet,
            {
              result: normalizedFacets[facet],
              evidence_digest: evidenceDigest,
            },
          ]),
        ),
        started_at: startedAt,
        completed_at: now,
        failure_messages: result === "fail" ? matches.flatMap(({ failures }) => failures) : [],
      };
    }),
  };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function isStrictUtcTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value ?? "");
  if (!match) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const date = new Date(parsed);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

export function validateCertificationIdentity(identity) {
  if (!/^[0-9a-f]{40}$/.test(identity.sourceSha ?? "")) {
    throw new Error("source-sha must be a full lowercase commit SHA");
  }
  if (!/^[0-9a-f]{40}$/.test(identity.producerSourceSha ?? "")) {
    throw new Error("producer-source-sha must be a full lowercase commit SHA");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(identity.imageDigest ?? "")) {
    throw new Error("image-digest must be an immutable lowercase sha256 digest");
  }
  if (!isStrictUtcTimestamp(identity.cutAt)) {
    throw new Error("candidate-cut-at must be a valid UTC ISO-8601 timestamp");
  }
}

export function validateIdentityOverrideEnvironment(environment = process.env) {
  if (environment.HONUA_CERTIFICATION_EXTERNAL === "true") return;
  if (environment.HONUA_SELF_CONTAINED_IDENTITY_OVERRIDE_INVALID === "true") {
    throw new Error(
      "HONUA_INTEGRATION_SERVER_IMAGE, HONUA_INTEGRATION_SERVER_COMMIT, and HONUA_CANDIDATE_CUT_AT must be overridden together",
    );
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(environment.HONUA_INTEGRATION_SERVER_IMAGE ?? "")) {
    throw new Error("HONUA_INTEGRATION_SERVER_IMAGE must be an immutable sha256 digest reference");
  }
  if (!/^[0-9a-f]{40}$/.test(environment.HONUA_INTEGRATION_SERVER_COMMIT ?? "")) {
    throw new Error("HONUA_INTEGRATION_SERVER_COMMIT must be a full lowercase commit SHA");
  }
  const cutAt = environment.HONUA_CANDIDATE_CUT_AT ?? "";
  if (!isStrictUtcTimestamp(cutAt)) {
    throw new Error("HONUA_CANDIDATE_CUT_AT must be a valid UTC ISO-8601 timestamp");
  }
}

async function main() {
  validateIdentityOverrideEnvironment();
  const reportPaths = argument("reports", "test-results/integration-vitest.json,test-results/conformance-vitest.json").split(",");
  const reports = await Promise.all(reportPaths.map(async (path) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }));
  let metadata = {};
  let metadataAvailable = true;
  try {
    metadata = JSON.parse(await readFile(argument("metadata", "test-results/integration-meta.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    metadataAvailable = false;
  }
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const required = (name, value) => {
    if (!value) throw new Error(`Missing required certification identity: ${name}`);
    return value;
  };
  const serverImage = argument("server-image", metadata.serverImage ?? process.env.HONUA_INTEGRATION_SERVER_IMAGE);
  const imageDigest = serverImage?.includes("@") ? serverImage.slice(serverImage.indexOf("@") + 1) : undefined;
  const external = process.env.HONUA_CERTIFICATION_EXTERNAL === "true";
  const deploymentTarget = argument(
    "deployment-target",
    external ? process.env.HONUA_DEPLOYMENT_TARGET : (process.env.HONUA_DEPLOYMENT_TARGET ?? "local-docker"),
  );
  const identity = {
    clientVersion: packageJson.version,
    deploymentTarget: required("deployment-target", deploymentTarget),
    sourceSha: required("source-sha", argument("source-sha", metadata.serverCommit ?? process.env.HONUA_INTEGRATION_SERVER_COMMIT)),
    producerSourceSha: required("producer-source-sha", argument("producer-source-sha", process.env.GITHUB_SHA)),
    imageDigest: required("image-digest", argument("image-digest", imageDigest)),
    fixtureRevision: required("fixture-revision", argument("fixture-revision", metadata.conformanceFixturesVersion ?? process.env.HONUA_CONFORMANCE_FIXTURES_VERSION)),
    evidenceUri: required("evidence-uri", argument("evidence-uri", process.env.HONUA_EVIDENCE_URI)),
    cutAt: required("candidate-cut-at", argument("candidate-cut-at", metadata.candidateCutAt ?? process.env.HONUA_CANDIDATE_CUT_AT)),
    startedAt: argument("started-at", process.env.HONUA_CERTIFICATION_STARTED_AT ?? metadata.startedAt),
  };
  validateCertificationIdentity(identity);
  const fragment = buildFragment({
    reports: reports.filter(Boolean),
    complete: metadataAvailable && reports.every(Boolean),
    identity,
  });
  await writeFile(argument("output", "test-results/protocol-certification-fragment.json"), `${JSON.stringify(fragment, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
