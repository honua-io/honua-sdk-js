#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createHonua, executeQueryPlan, explainQuery } from "../../dist/src/index.js";
import { liveEvidenceOutputContract } from "../../scripts/lib/live-evidence-output.mjs";
import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

const SAMPLE_ID = "service-explorer";
const PRODUCER_PATH = "examples/service-explorer/live-evidence.mjs";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_GEOSERVICES_URL =
  "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/CitizenRequests/FeatureServer/0";
const DEFAULT_GEOSERVICES_SOURCE_ID = "0";
const DEFAULT_OGC_URL = "https://demo.pygeoapi.io/master";
const DEFAULT_OGC_SOURCE_ID = "lakes";
const outputContract = liveEvidenceOutputContract(SAMPLE_ID, "test-results/service-explorer-live-evidence.json");
const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const producerSha256 = createHash("sha256")
  .update(await readFile(new URL("./live-evidence.mjs", import.meta.url)))
  .digest("hex");
const producerArtifact = Object.freeze({
  kind: "producer-generator",
  path: PRODUCER_PATH,
  sha256: producerSha256,
});
const observedAt = new Date().toISOString();
const sourceIdentity = "configured-geoservices+configured-ogc-features";
const liveEnabled = process.env.HONUA_SERVICE_EXPLORER_LIVE_ENABLED === "true";

let evidence;
let failure;
if (!liveEnabled) {
  evidence = nonExecutedEvidence(
    "skipped",
    "HONUA_SERVICE_EXPLORER_LIVE_ENABLED is not true; no public endpoint was contacted.",
    "live-execution-not-enabled",
    [],
  );
} else {
  try {
    evidence = await collectLiveEvidence();
  } catch (error) {
    failure = error;
    evidence = nonExecutedEvidence(
      "failed",
      "The bounded dual-protocol live smoke failed; fixture data was not substituted.",
      "dual-protocol-live-smoke-failed",
      [producerArtifact],
    );
  }
}

evidence = validateEvidenceEnvelope(evidence);
await mkdir(path.dirname(outputContract.output), { recursive: true });
await writeFile(outputContract.output, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(
  `${evidence.status}: ${evidence.reason ?? evidence.semantics.outcome}\n${outputContract.output}\n`,
);
if (failure) {
  const failureName = failure instanceof Error ? failure.name : "UnknownError";
  process.stderr.write(`service explorer live evidence failed (${failureName})\n`);
  process.exitCode = 1;
}

async function collectLiveEvidence() {
  const targets = [
    {
      id: "geoservices",
      protocol: "geoservices-feature-service",
      url: publicUrl(process.env.HONUA_SERVICE_EXPLORER_GEOSERVICES_URL ?? DEFAULT_GEOSERVICES_URL),
      sourceId: sourceId(
        process.env.HONUA_SERVICE_EXPLORER_GEOSERVICES_SOURCE_ID ?? DEFAULT_GEOSERVICES_SOURCE_ID,
        "GeoServices",
      ),
    },
    {
      id: "ogc",
      protocol: "ogc-features",
      url: publicUrl(process.env.HONUA_SERVICE_EXPLORER_OGC_URL ?? DEFAULT_OGC_URL),
      sourceId: sourceId(process.env.HONUA_SERVICE_EXPLORER_OGC_SOURCE_ID ?? DEFAULT_OGC_SOURCE_ID, "OGC Features"),
      collectionId: sourceId(process.env.HONUA_SERVICE_EXPLORER_OGC_SOURCE_ID ?? DEFAULT_OGC_SOURCE_ID, "OGC Features"),
    },
  ];
  const startedAt = performance.now();
  const honua = createHonua({ discoveryCacheMaxEntries: 2 });
  const observations = [];
  try {
    for (const target of targets) observations.push(await inspectAndQuery(honua, target));
  } finally {
    await honua.dispose();
  }
  const totalMs = Math.max(0, performance.now() - startedAt);
  return {
    $schema: "../../samples/contract/v1/schemas/sample-evidence.schema.json",
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: SAMPLE_ID,
    lane: "live",
    status: "executed",
    reason: null,
    observedAt,
    authMode: "anonymous",
    sdk: {
      package: packageJson.name,
      version: packageJson.version,
      gitCommit: gitCommit(),
    },
    source: {
      provider: "esri-sampleserver6-and-pygeoapi-demo",
      identity: sourceIdentity,
      endpoint: null,
      deploymentVersion: null,
      dataVersion: null,
    },
    provenance: {
      sourceId: sourceIdentity,
      observedAt,
      validAt: null,
      state: "live",
      attribution: "Esri sample services and the pygeoapi development team.",
    },
    semantics: {
      operation: "dual-protocol-inspect-plan-query",
      outcome: "geoservices-and-ogc-plans-executed",
      itemCount: observations.reduce((count, observation) => count + observation.itemCount, 0),
      assertions: [
        "credential-free-https-endpoints",
        "geoservices-feature-service-inspected",
        "ogc-features-conformance-inspected",
        "strict-query-plans-accepted",
        "bounded-live-results-returned",
      ],
    },
    timing: {
      totalMs,
      firstSuccessfulInteractionMs: observations[0]?.elapsedMs ?? totalMs,
    },
    degradation: { state: "none", reasons: [] },
    artifacts: [producerArtifact],
  };
}

async function inspectAndQuery(honua, target) {
  const startedAt = performance.now();
  const connection = await honua.connect(
    {
      url: target.url,
      protocol: target.protocol,
      sourceId: target.sourceId,
      ...(target.collectionId ? { collectionId: target.collectionId } : {}),
    },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  try {
    const inspection = await connection.inspect({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (inspection.protocol !== target.protocol) {
      throw new Error(`${target.id} inspection resolved an unexpected protocol`);
    }
    if (!inspection.sources.some((source) => source.descriptor.id === target.sourceId)) {
      throw new Error(`${target.id} inspection did not retain the configured source identity`);
    }
    const source = connection.source(target.sourceId);
    const plan = explainQuery({
      descriptor: source.descriptor,
      query: { pagination: { limit: 1 } },
      capabilityPolicy: "strict",
    });
    const execution = await executeQueryPlan(plan, source, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const itemCount = execution.result.features?.length ?? execution.result.aggregateRows?.length ?? 0;
    if (itemCount !== 1) {
      throw new Error(`${target.id} did not return exactly one bounded result`);
    }
    return { id: target.id, itemCount, elapsedMs: Math.max(0, performance.now() - startedAt) };
  } finally {
    await connection.dispose();
  }
}

function nonExecutedEvidence(status, reason, degradationReason, artifacts) {
  return {
    $schema: "../../samples/contract/v1/schemas/sample-evidence.schema.json",
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: SAMPLE_ID,
    lane: "live",
    status,
    reason,
    observedAt,
    authMode: "anonymous",
    sdk: {
      package: packageJson.name,
      version: packageJson.version,
      gitCommit: gitCommit(),
    },
    source: {
      provider: "esri-sampleserver6-and-pygeoapi-demo",
      identity: sourceIdentity,
      endpoint: null,
      deploymentVersion: null,
      dataVersion: null,
    },
    provenance: null,
    semantics: {
      operation: "dual-protocol-inspect-plan-query",
      outcome: null,
      itemCount: null,
      assertions: [],
    },
    timing: { totalMs: null, firstSuccessfulInteractionMs: null },
    degradation: { state: "unavailable", reasons: [degradationReason] },
    artifacts,
  };
}

function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Live endpoints must be credential-free HTTPS URLs without query strings or fragments");
  }
  return url.toString().replace(/\/$/, "");
}

function sourceId(value, label) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error(`${label} source id must be a bounded structural identifier`);
  }
  return value;
}

function gitCommit() {
  const configured = outputContract.sourceRevision ?? process.env.GITHUB_SHA;
  if (/^[a-f0-9]{40}$/.test(configured ?? "")) return configured;
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
}
