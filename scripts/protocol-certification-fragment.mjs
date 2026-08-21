#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const GAP_OWNER = "https://github.com/honua-io/honua-sdk-js/issues/1113";

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
  ["mapserver", "query", /map.?server/i, /query/i],
  ["mapserver", "count", /map.?server/i, /count/i],
  ["mapserver", "export", /map.?server/i, /export/i],
  ["odata", "metadata", /odata/i, /metadata/i],
  ["odata", "entity-page", /odata/i, /entit|page|list/i],
  ["ogc-features", "landing", /ogc.*feature/i, /landing/i],
  ["ogc-features", "conformance", /ogc.*feature/i, /conformance/i],
  ["ogc-features", "collections", /ogc.*feature/i, /collections/i],
  ["ogc-features", "items", /ogc.*feature/i, /items|paginated/i],
  ["ogc-features", "item", /ogc.*feature/i, /item.*id|single.?item/i],
  ["ogc-maps", "landing", /ogc.*map/i, /landing/i],
  ["ogc-maps", "conformance", /ogc.*map/i, /conformance/i],
  ["ogc-maps", "render", /ogc.*map/i, /render|map image/i],
  ["ogc-processes", "landing", /ogc.*process/i, /landing/i],
  ["ogc-processes", "conformance", /ogc.*process/i, /conformance/i],
  ["ogc-processes", "list", /ogc.*process/i, /list|processes/i],
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
  ["stac", "collection", /stac/i, /collection.*(get|id)|single.?collection/i],
  ["stac", "search", /stac/i, /search/i],
  ["wcs", "capabilities", /\bwcs\b/i, /capabilities/i],
  ["wcs", "get-coverage", /\bwcs\b/i, /coverage/i],
  ["wfs", "capabilities", /\bwfs\b/i, /capabilities/i],
  ["wfs", "get-feature", /\bwfs\b/i, /feature|page/i],
  ["wms", "capabilities", /\bwms\b/i, /capabilities/i],
  ["wms", "get-map", /\bwms\b/i, /get.?map|map image/i],
  ["wmts", "capabilities", /\bwmts\b/i, /capabilities/i],
  ["wmts", "get-tile", /\bwmts\b/i, /tile/i],
];

function assertions(report) {
  return (report?.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).map((test) => ({
      text: [suite.name, ...(test.ancestorTitles ?? []), test.fullName, test.title].filter(Boolean).join(" "),
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

export function buildFragment({ reports, identity, complete = true, now = new Date().toISOString() }) {
  const tests = reports.flatMap(assertions);
  return {
    schema_version: "1.0.0",
    complete,
    observations: OPERATIONS.map(([surface, operation, surfacePattern, operationPattern]) => {
      const matches = tests.filter(({ text }) => surfacePattern.test(text) && operationPattern.test(text));
      const result = statusFor(matches);
      return {
        surface,
        operation,
        canonical_client: "@honua/sdk-js",
        client_version: identity.clientVersion,
        deployment_target: identity.deploymentTarget,
        result,
        skip_reason: result === "skip" ? `No executable canonical SDK test matched this required operation; owner: ${GAP_OWNER}` : null,
        source_sha: identity.sourceSha,
        image_digest: identity.imageDigest,
        fixture_revision: identity.fixtureRevision,
        evidence_uri: identity.evidenceUri,
        started_at: identity.startedAt ?? now,
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

async function main() {
  const reportPaths = argument("reports", "test-results/integration-vitest.json,test-results/conformance-vitest.json").split(",");
  const reports = await Promise.all(reportPaths.map(async (path) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }));
  const metadata = JSON.parse(await readFile(argument("metadata", "test-results/integration-meta.json"), "utf8"));
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
  const fragment = buildFragment({
    reports: reports.filter(Boolean),
    complete: reports.every(Boolean),
    identity: {
      clientVersion: packageJson.version,
      deploymentTarget: required("deployment-target", deploymentTarget),
      sourceSha: required("source-sha", argument("source-sha", metadata.serverCommit)),
      imageDigest: required("image-digest", argument("image-digest", imageDigest)),
      fixtureRevision: required("fixture-revision", argument("fixture-revision", metadata.conformanceFixturesVersion)),
      evidenceUri: required("evidence-uri", argument("evidence-uri", process.env.HONUA_EVIDENCE_URI)),
      startedAt: argument("started-at", metadata.startedAt),
    },
  });
  await writeFile(argument("output", "test-results/protocol-certification-fragment.json"), `${JSON.stringify(fragment, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
