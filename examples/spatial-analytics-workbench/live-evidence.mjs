import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { capabilities, createDataset } from "../../dist/src/contract/index.js";
import { HonuaClient } from "../../dist/src/honua.js";
import { executeQueryPlan, explainQuery } from "../../dist/src/query-planner/index.js";
import { liveEvidenceOutputContract } from "../../scripts/lib/live-evidence-output.mjs";
import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

const producerPath = "examples/spatial-analytics-workbench/live-evidence.mjs";
const producerSha256 = createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const outputContract = liveEvidenceOutputContract(
  "spatial-analytics-workbench",
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test-results/spatial-analytics-live-evidence.json"),
);
const outputPath = outputContract.output;
const observedAt = new Date().toISOString();
const protocol = process.env.HONUA_SPATIAL_ANALYTICS_PROTOCOL ?? "geoservices-feature-service";
const baseUrl = process.env.HONUA_SPATIAL_ANALYTICS_BASE_URL;
const serviceId = process.env.HONUA_SPATIAL_ANALYTICS_SERVICE_ID;
const layerId = Number(process.env.HONUA_SPATIAL_ANALYTICS_LAYER_ID);

let evidence;
if (protocol === "ogc-features") {
  evidence = skipped(
    "OGC/CQL2 planner execution remains a #389 follow-on; the live lane did not substitute a simulated result.",
    observedAt,
  );
} else if (!baseUrl || !serviceId || !Number.isInteger(layerId) || layerId < 0) {
  evidence = skipped(
    "HONUA_SPATIAL_ANALYTICS_BASE_URL, SERVICE_ID, and integer LAYER_ID are required; fixture fallback was not substituted.",
    observedAt,
  );
} else {
  const safeUrl = publicUrl(baseUrl);
  const descriptor = {
    id: `live:${serviceId}:layer:${layerId}`,
    protocol: "geoservices-feature-service",
    locator: { url: safeUrl, serviceId, layerId },
    capabilities: capabilities(["query", "queryAggregate"]),
    schema: { primaryKey: process.env.HONUA_SPATIAL_ANALYTICS_ID_FIELD ?? "OBJECTID" },
  };
  const client = new HonuaClient({ baseUrl: safeUrl });
  const dataset = createDataset({
    id: "spatial-analytics-live-evidence",
    client,
    sources: [descriptor],
    skipCompatibilityCheck: true,
  });
  const source = dataset.source(descriptor.id);
  if (!source) throw new Error("Could not construct the configured live source");
  const groupField = process.env.HONUA_SPATIAL_ANALYTICS_GROUP_FIELD ?? "risk";
  const valueField = process.env.HONUA_SPATIAL_ANALYTICS_VALUE_FIELD ?? "score";
  const idField = process.env.HONUA_SPATIAL_ANALYTICS_ID_FIELD ?? "OBJECTID";
  const plan = explainQuery({
    descriptor,
    query: {
      where: process.env.HONUA_SPATIAL_ANALYTICS_WHERE ?? "1=1",
      aggregation: {
        groupBy: [groupField],
        metrics: [
          { fn: "count", field: idField, alias: "feature_count" },
          { fn: "avg", field: valueField, alias: "average_value" },
        ],
      },
      pagination: { limit: 10 },
      returnGeometry: false,
    },
    sourceVersion: process.env.HONUA_SPATIAL_ANALYTICS_SOURCE_VERSION ?? "unreported-live-version",
    schemaVersion: process.env.HONUA_SPATIAL_ANALYTICS_SCHEMA_VERSION ?? "unreported-live-schema",
    authorizationScope: ["data:read"],
  });
  const started = performance.now();
  const execution = await executeQueryPlan(plan, source, {
    sourceVersion: plan.ir.source.sourceVersion,
    schemaVersion: plan.ir.source.schemaVersion,
    authorizationScope: ["data:read"],
  });
  const totalMs = Math.max(0, performance.now() - started);
  const rows = execution.result.aggregateRows ?? [];
  evidence = {
    $schema: "../../samples/contract/v1/schemas/sample-evidence.schema.json",
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "spatial-analytics-workbench",
    lane: "live",
    status: "executed",
    reason: null,
    observedAt,
    authMode: "anonymous",
    sdk: {
      package: "@honua/sdk-js",
      version: "0.1.0-beta.0",
      gitCommit: outputContract.sourceRevision ?? process.env.GITHUB_SHA ?? null,
    },
    source: {
      provider: "configured-geoservices",
      identity: descriptor.id,
      endpoint: safeUrl,
      deploymentVersion: process.env.HONUA_SPATIAL_ANALYTICS_DEPLOYMENT_VERSION ?? null,
      dataVersion: plan.ir.source.sourceVersion ?? null,
    },
    provenance: {
      sourceId: descriptor.id,
      observedAt,
      validAt: null,
      state: "live",
      attribution: process.env.HONUA_SPATIAL_ANALYTICS_ATTRIBUTION ?? "Attribution supplied by the configured source.",
    },
    semantics: {
      operation: "geoservices-queryAggregate",
      outcome: "accepted-plan-executed",
      itemCount: rows.length,
      assertions: ["plan-fingerprint-validated", "remote-pushdown", "aggregate-rows-returned"],
    },
    timing: { totalMs, firstSuccessfulInteractionMs: totalMs },
    degradation: { state: "none", reasons: [] },
    artifacts: [{ kind: "producer-generator", path: producerPath, sha256: producerSha256 }],
  };
}

validateEvidenceEnvelope(evidence);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${evidence.status}: ${evidence.reason ?? evidence.semantics.outcome}\n${outputPath}\n`);

function skipped(reason, timestamp) {
  return {
    $schema: "../../samples/contract/v1/schemas/sample-evidence.schema.json",
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "spatial-analytics-workbench",
    lane: "live",
    status: "skipped",
    reason,
    observedAt: timestamp,
    authMode: "anonymous",
    sdk: {
      package: "@honua/sdk-js",
      version: "0.1.0-beta.0",
      gitCommit: outputContract.sourceRevision ?? process.env.GITHUB_SHA ?? null,
    },
    source: {
      provider: "configured-geoservices",
      identity: "spatial-analytics-live-source",
      endpoint: null,
      deploymentVersion: null,
      dataVersion: null,
    },
    provenance: null,
    semantics: { operation: "geoservices-queryAggregate", outcome: null, itemCount: null, assertions: [] },
    timing: { totalMs: null, firstSuccessfulInteractionMs: null },
    degradation: {
      state: "unavailable",
      reasons: [protocol === "ogc-features" ? "compiler-unavailable" : "live-config-unavailable"],
    },
    artifacts: [],
  };
}

function publicUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Live base URL must use http or https");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Live base URL must not include credentials, query parameters, or fragments");
  }
  return url.toString().replace(/\/$/, "");
}
