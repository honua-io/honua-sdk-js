#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createHonua, executeQueryPlan, explainQuery } from "../../dist/src/index.js";
import { liveEvidenceOutputContract } from "../../scripts/lib/live-evidence-output.mjs";
import { validateEvidenceEnvelope } from "../../scripts/sample-contract.mjs";

const SAMPLE_ID = "service-explorer";
const PRODUCER_PATH = "examples/service-explorer/live-evidence.mjs";
const DEFAULT_OUTPUT = "test-results/service-explorer-live-evidence.json";
const SOURCE_IDENTITY = "canonical-anonymous-geoservices+canonical-anonymous-ogc-features";
const SOURCE_PROVIDER = "esri-sampleserver6-and-pygeoapi-demo";
const ATTRIBUTION = "Esri sample services and the pygeoapi development team.";
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-authorization",
]);
const CREDENTIAL_QUERY_PARAMETERS = new Set([
  "access_key",
  "access_key_id",
  "access_token",
  "api_key",
  "apikey",
  "auth_token",
  "authorization",
  "aws_access_key_id",
  "awsaccesskeyid",
  "bearer_token",
  "client_secret",
  "credential",
  "id_token",
  "key",
  "password",
  "private_key",
  "refresh_token",
  "sas",
  "secret",
  "sig",
  "signature",
  "subscription_key",
  "token",
  "x_amz_credential",
  "x_amz_signature",
  "x_api_key",
  "x_goog_signature",
]);

export const SERVICE_EXPLORER_LIVE_BUDGETS = Object.freeze({
  requestTimeoutMs: 20_000,
  maxRequestsPerTarget: 12,
  maxResponseBytes: 512 * 1024,
  maxTotalResponseBytes: 2 * 1024 * 1024,
});

export const CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS = Object.freeze({
  geoservices:
    "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/CitizenRequests/FeatureServer/0",
  ogc: "https://demo.pygeoapi.io/master",
});

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const producerArtifact = Object.freeze({
  kind: "producer-generator",
  path: PRODUCER_PATH,
  sha256: createHash("sha256")
    .update(await readFile(new URL("./live-evidence.mjs", import.meta.url)))
    .digest("hex"),
});

export function createServiceExplorerLiveTargets(options = {}) {
  const allowLoopback = options.allowLoopback === true;
  const ogcSourceId = structuralSourceId(options.ogcSourceId ?? "lakes", "OGC Features");
  const geoservicesUrl = validateServiceExplorerLiveEndpoint(
    options.geoservicesUrl ?? CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS.geoservices,
    { allowLoopback },
  );
  const ogcUrl = validateServiceExplorerLiveEndpoint(options.ogcUrl ?? CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS.ogc, {
    allowLoopback,
  });
  return Object.freeze([
    Object.freeze({
      id: "geoservices",
      protocol: "geoservices-feature-service",
      url: geoservicesUrl,
      sourceId: "0",
    }),
    Object.freeze({
      id: "ogc",
      protocol: "ogc-features",
      url: ogcUrl,
      sourceId: ogcSourceId,
      collectionId: ogcSourceId,
    }),
  ]);
}

export function validateServiceExplorerLiveEndpoint(value, options = {}) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Service Explorer evidence endpoints must be absolute URLs");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Service Explorer evidence endpoints cannot contain credentials, queries, or fragments");
  }

  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const allowLoopback = options.allowLoopback === true;
  if (allowLoopback && endpoint.protocol === "http:" && isLoopbackHostname(hostname)) {
    return endpoint.toString().replace(/\/$/u, "");
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("Service Explorer public evidence endpoints must use HTTPS");
  }
  if (endpoint.port && endpoint.port !== "443") {
    throw new Error("Service Explorer public evidence endpoints cannot select a non-default port");
  }
  if (
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Service Explorer public evidence endpoints must use a public DNS hostname");
  }
  return endpoint.toString().replace(/\/$/u, "");
}

export function createBoundedServiceExplorerFetch(options) {
  const targetUrl = new URL(
    validateServiceExplorerLiveEndpoint(options.targetUrl, { allowLoopback: options.allowLoopback === true }),
  );
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const budgets = normalizeBudgets(options.budgets);
  let requestCount = 0;
  let totalResponseBytes = 0;

  return async (input, init) => {
    requestCount += 1;
    if (requestCount > budgets.maxRequestsPerTarget) {
      throw new Error("Service Explorer evidence exceeded its per-target request budget");
    }

    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    validateDerivedRequest(request, requestUrl, targetUrl);
    const deadline = AbortSignal.timeout(budgets.requestTimeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const response = await fetchFn(request, {
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Service Explorer evidence does not follow redirects");
    }

    const remainingTotalBytes = budgets.maxTotalResponseBytes - totalResponseBytes;
    if (remainingTotalBytes <= 0) {
      throw new Error("Service Explorer evidence exceeded its total response budget");
    }
    const copied = await copyBoundedJsonResponse(response, Math.min(budgets.maxResponseBytes, remainingTotalBytes));
    totalResponseBytes += copied.bodyBytes;
    return copied.response;
  };
}

export async function collectServiceExplorerLiveEvidence(options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const targets = options.targets ?? createServiceExplorerLiveTargets();
  validateTargetMatrix(targets);
  const sourceRevision = options.sourceRevision ?? null;
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) {
    throw new Error("Executed Service Explorer live evidence requires a full lowercase source revision");
  }

  const startedAt = performance.now();
  const honua = createHonua({ discoveryCacheMaxEntries: 2 });
  const observations = [];
  try {
    for (const target of targets) {
      observations.push(
        await inspectAndQueryTarget(honua, target, {
          allowLoopback: options.allowLoopback === true,
          budgets: options.budgets,
          fetchFn: options.fetchFn,
        }),
      );
    }
  } finally {
    await honua.dispose();
  }

  const totalMs = Math.max(0, performance.now() - startedAt);
  return validateEvidenceEnvelope(
    {
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
        version: options.sdkVersion ?? packageJson.version,
        gitCommit: sourceRevision,
      },
      source: {
        provider: SOURCE_PROVIDER,
        identity: SOURCE_IDENTITY,
        endpoint: targets.find((target) => target.id === "ogc")?.url ?? null,
        deploymentVersion: null,
        dataVersion: null,
      },
      provenance: {
        sourceId: SOURCE_IDENTITY,
        observedAt,
        validAt: null,
        state: "live",
        attribution: ATTRIBUTION,
      },
      semantics: {
        operation: "dual-protocol-inspect-plan-query",
        outcome: "geoservices-and-ogc-plans-executed",
        itemCount: observations.reduce((count, observation) => count + observation.itemCount, 0),
        assertions: [
          "credential-free-fixed-https-endpoints",
          "same-origin-path-confined-requests",
          "bounded-request-and-response-budgets",
          "geoservices-feature-service-inspected",
          "ogc-features-conformance-inspected",
          "strict-query-plans-accepted",
          "one-result-per-protocol-returned",
        ],
      },
      timing: {
        totalMs,
        firstSuccessfulInteractionMs: observations[0]?.elapsedMs ?? totalMs,
      },
      degradation: { state: "none", reasons: [] },
      artifacts: [producerArtifact],
    },
    { now: observedAt },
  );
}

export function createNonExecutedServiceExplorerEvidence(options) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  return validateEvidenceEnvelope(
    {
      $schema: "../../samples/contract/v1/schemas/sample-evidence.schema.json",
      format: "honua.sdk.sample-evidence.v1",
      schemaVersion: 1,
      sampleId: SAMPLE_ID,
      lane: "live",
      status: options.status,
      reason: options.reason,
      observedAt,
      authMode: "anonymous",
      sdk: {
        package: packageJson.name,
        version: options.sdkVersion ?? packageJson.version,
        gitCommit: options.sourceRevision ?? null,
      },
      source: {
        provider: SOURCE_PROVIDER,
        identity: SOURCE_IDENTITY,
        endpoint: CANONICAL_SERVICE_EXPLORER_LIVE_ENDPOINTS.ogc,
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
      degradation: { state: "unavailable", reasons: [options.degradationReason] },
      artifacts: options.includeProducerArtifact ? [producerArtifact] : [],
    },
    { now: observedAt },
  );
}

async function inspectAndQueryTarget(honua, target, options) {
  const budgets = normalizeBudgets(options.budgets);
  const fetchFn = createBoundedServiceExplorerFetch({
    targetUrl: target.url,
    allowLoopback: options.allowLoopback,
    fetchFn: options.fetchFn,
    budgets,
  });
  const startedAt = performance.now();
  const connection = await honua.connect(
    {
      url: target.url,
      protocol: target.protocol,
      sourceId: target.sourceId,
      ...(target.collectionId ? { collectionId: target.collectionId } : {}),
    },
    {
      signal: AbortSignal.timeout(budgets.requestTimeoutMs),
      authorizationScopeFingerprint: "service-explorer-public-evidence:v1",
      clientOptions: { fetchFn, retry: { maxRetries: 0 } },
    },
  );
  try {
    const inspection = await connection.inspect({ signal: AbortSignal.timeout(budgets.requestTimeoutMs) });
    if (inspection.protocol !== target.protocol) {
      throw new Error(`${target.id} inspection resolved an unexpected protocol`);
    }
    if (!inspection.sources.some((source) => source.descriptor.id === target.sourceId)) {
      throw new Error(`${target.id} inspection did not retain the reviewed source identity`);
    }
    const source = connection.source(target.sourceId);
    const plan = explainQuery({
      descriptor: source.descriptor,
      query: { pagination: { limit: 1 } },
      capabilityPolicy: "strict",
    });
    const execution = await executeQueryPlan(plan, source, {
      signal: AbortSignal.timeout(budgets.requestTimeoutMs),
    });
    const itemCount = execution.result.features?.length ?? execution.result.aggregateRows?.length ?? 0;
    if (itemCount !== 1) {
      throw new Error(`${target.id} did not return exactly one bounded result`);
    }
    return Object.freeze({
      id: target.id,
      itemCount,
      elapsedMs: Math.max(0, performance.now() - startedAt),
    });
  } finally {
    await connection.dispose();
  }
}

function validateTargetMatrix(targets) {
  if (!Array.isArray(targets) || targets.length !== 2) {
    throw new Error("Service Explorer live evidence requires exactly two reviewed protocol targets");
  }
  const byId = new Map(targets.map((target) => [target.id, target]));
  const geoservices = byId.get("geoservices");
  const ogc = byId.get("ogc");
  if (
    geoservices?.protocol !== "geoservices-feature-service" ||
    geoservices.sourceId !== "0" ||
    ogc?.protocol !== "ogc-features" ||
    ogc.sourceId !== ogc.collectionId
  ) {
    throw new Error("Service Explorer live evidence target identities do not match the reviewed matrix");
  }
}

function validateDerivedRequest(request, requestUrl, targetUrl) {
  if (request.method !== "GET") {
    throw new Error("Service Explorer evidence permits only GET requests");
  }
  if (
    requestUrl.origin !== targetUrl.origin ||
    !isPathWithin(targetUrl.pathname, requestUrl.pathname) ||
    requestUrl.username ||
    requestUrl.password ||
    requestUrl.hash
  ) {
    throw new Error("Service Explorer evidence requests must remain under the reviewed target path");
  }
  for (const name of requestUrl.searchParams.keys()) {
    if (isCredentialQueryParameter(name)) {
      throw new Error("Service Explorer evidence requests cannot contain credential query parameters");
    }
  }
  for (const name of FORBIDDEN_REQUEST_HEADERS) {
    if (request.headers.has(name)) {
      throw new Error("Service Explorer evidence requests cannot contain credential headers");
    }
  }
}

async function copyBoundedJsonResponse(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new Error("Service Explorer evidence response exceeded its byte budget");
    }
  }

  const chunks = [];
  let bodyBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyBytes += value.byteLength;
        if (bodyBytes > maxBytes) {
          await reader.cancel("response budget exceeded");
          throw new Error("Service Explorer evidence response exceeded its byte budget");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    bodyBytes > 0 &&
    contentType !== "application/json" &&
    contentType !== "application/geo+json" &&
    !contentType?.endsWith("+json")
  ) {
    throw new Error("Service Explorer evidence responses must use a JSON media type");
  }
  const body = bodyBytes === 0 ? null : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    bodyBytes,
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

function normalizeBudgets(value = {}) {
  const budgets = { ...SERVICE_EXPLORER_LIVE_BUDGETS, ...value };
  for (const [name, limit] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`Service Explorer evidence budget ${name} must be a positive safe integer`);
    }
  }
  if (budgets.maxResponseBytes > budgets.maxTotalResponseBytes) {
    throw new Error("Service Explorer per-response budget cannot exceed its total response budget");
  }
  return Object.freeze(budgets);
}

function isCredentialQueryParameter(name) {
  const normalized = name
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return [...CREDENTIAL_QUERY_PARAMETERS].some(
    (candidate) => normalized === candidate || normalized.endsWith(`_${candidate}`),
  );
}

function isPathWithin(basePath, candidatePath) {
  const normalizedBase = basePath.replace(/\/$/u, "");
  return candidatePath === normalizedBase || candidatePath.startsWith(`${normalizedBase}/`);
}

function isLoopbackHostname(hostname) {
  if (hostname === "::1") return true;
  if (isIP(hostname) !== 4) return false;
  const first = Number(hostname.split(".", 1)[0]);
  return first === 127;
}

function structuralSourceId(value, label) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) {
    throw new Error(`${label} source id must be a bounded structural identifier`);
  }
  return value;
}

function gitCommit(sourceRevision) {
  if (/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) return sourceRevision;
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

async function main() {
  const outputContract = liveEvidenceOutputContract(SAMPLE_ID, DEFAULT_OUTPUT);
  const observedAt = new Date().toISOString();
  const sourceRevision = gitCommit(outputContract.sourceRevision);
  const liveEnabled = process.env.HONUA_SERVICE_EXPLORER_LIVE_ENABLED === "true";
  let evidence;
  let failure;

  if (!liveEnabled) {
    evidence = createNonExecutedServiceExplorerEvidence({
      status: "skipped",
      reason: "HONUA_SERVICE_EXPLORER_LIVE_ENABLED is not true; no public endpoint was contacted.",
      degradationReason: "live-execution-not-enabled",
      observedAt,
      sourceRevision,
    });
  } else {
    try {
      evidence = await collectServiceExplorerLiveEvidence({ observedAt, sourceRevision });
    } catch (error) {
      failure = error;
      evidence = createNonExecutedServiceExplorerEvidence({
        status: "failed",
        reason: "The bounded dual-protocol public smoke failed; fixture data was not substituted.",
        degradationReason: "dual-protocol-public-smoke-failed",
        observedAt,
        sourceRevision,
        includeProducerArtifact: true,
      });
    }
  }

  const outputPath = path.resolve(outputContract.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${evidence.status}: ${evidence.reason ?? evidence.semantics.outcome}\n${outputPath}\n`);
  if (failure) {
    process.stderr.write(
      `service explorer live evidence failed (${failure instanceof Error ? failure.name : "UnknownError"})\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
