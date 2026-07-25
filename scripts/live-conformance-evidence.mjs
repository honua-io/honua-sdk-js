#!/usr/bin/env node
/**
 * Live SDK-journey conformance runner (issue #535).
 *
 * Drives the *public* SDK surface — `connect()` -> `HonuaConnection.inspection`
 * -> `Source.query()` / `projectRasterSourceToMapLibre()` — against the
 * reviewed public reference services in
 * `config/live-conformance-endpoints.v1.json`, and emits one redacted,
 * machine-readable evidence artifact
 * (`honua.sdk.live-conformance-evidence.v1`).
 *
 * Contrast with its sibling lanes:
 *   - `npm run test:conformance` round-trips pinned fixtures through a pinned
 *     honua-server. Deterministic, versioned, offline-friendly.
 *   - this lane observes third-party servers nobody here operates. It is
 *     therefore scheduled/manual only (`HONUA_LIVE_CONFORMANCE_ENABLED`), and
 *     it separates *availability* problems (degraded, typed reason + owner +
 *     expiry) from *semantic* problems (failed: a parser, serializer, or
 *     capability regression, even when the raw HTTP status is 200).
 *
 * Every network interaction is bounded: same-origin GET only, no redirects, no
 * credentials, per-request timeout, per-target request ceiling, per-response
 * and per-run byte ceilings, one bounded page (`limit=1`) and one bounded tile.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LIVE_CONFORMANCE_EVIDENCE_FORMAT = "honua.sdk.live-conformance-evidence.v1";
export const LIVE_CONFORMANCE_ENDPOINT_MANIFEST_FORMAT = "honua.sdk.live-conformance-endpoints.v1";
export const LIVE_CONFORMANCE_RUNNER_PATH = "scripts/live-conformance-evidence.mjs";
export const LIVE_CONFORMANCE_ENDPOINT_MANIFEST_PATH = "config/live-conformance-endpoints.v1.json";
export const LIVE_CONFORMANCE_EVIDENCE_SCHEMA_PATH = "schemas/live-conformance-evidence.v1.json";
export const LIVE_CONFORMANCE_NETWORK_GATES = Object.freeze(["HONUA_LIVE_CONFORMANCE_ENABLED"]);

/** Journey identities this runner knows how to drive through the public SDK. */
export const LIVE_CONFORMANCE_JOURNEYS = Object.freeze(["query", "raster-tiles"]);

/** Availability problems: the upstream service, not the SDK, is at fault. */
const AVAILABILITY_CODES = Object.freeze([
  "endpoint-unreachable",
  "endpoint-timeout",
  "endpoint-server-error",
  "endpoint-rate-limited",
  "endpoint-redirect-refused",
  "budget-exceeded",
]);

/** Semantic problems: a parser, serializer, or capability regression. */
const SEMANTIC_CODES = Object.freeze([
  "endpoint-client-error",
  "capability-regression",
  "semantic-assertion-failed",
  "unexpected-error",
]);

const ALLOWED_REQUEST_HEADERS = new Set(["accept", "accept-encoding", "accept-language", "content-type", "user-agent"]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-authorization",
  "x-esri-authorization",
]);

/**
 * Query parameter names whose *values* may be retained in the evidence
 * ledger. Everything outside this allowlist is recorded by name only, so a
 * future protocol adapter cannot leak a token into a published artifact.
 */
const SAFE_QUERY_PARAMETER_VALUES = new Set([
  "acceptversions",
  "bbox",
  "collections",
  "count",
  "crs",
  "datetime",
  "f",
  "filter",
  "filter-lang",
  "format",
  "height",
  "ids",
  "infoformat",
  "layer",
  "layers",
  "limit",
  "offset",
  "orderby",
  "orderbyfields",
  "outfields",
  "outputformat",
  "properties",
  "request",
  "resultoffset",
  "resultrecordcount",
  "resulttype",
  "returngeometry",
  "select",
  "service",
  "skip",
  "skipgeometry",
  "sortby",
  "srs",
  "srsname",
  "startindex",
  "style",
  "styles",
  "tilecol",
  "tilematrix",
  "tilematrixset",
  "tilerow",
  "top",
  "transparent",
  "typename",
  "typenames",
  "version",
  "where",
  "width",
]);

const CREDENTIAL_QUERY_PARAMETERS = new Set([
  "access_key",
  "access_key_id",
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authorization",
  "aws_access_key_id",
  "awsaccesskeyid",
  "bearer_token",
  "client_secret",
  "code",
  "credential",
  "id_token",
  "jwt",
  "key",
  "password",
  "private_key",
  "pwd",
  "refresh_token",
  "sas",
  "secret",
  "session",
  "sig",
  "signature",
  "subscription_key",
  "token",
  "x_amz_credential",
  "x_amz_signature",
  "x_api_key",
  "x_goog_signature",
]);

const METADATA_MEDIA_TYPES = new Set([
  "application/json",
  "application/geo+json",
  "application/xml",
  "text/xml",
  "text/plain",
  "application/atom+xml",
  "application/vnd.ogc.wms_xml",
]);

const IMAGE_SIGNATURES = Object.freeze([
  { signature: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { signature: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { signature: "webp", bytes: [0x52, 0x49, 0x46, 0x46] },
]);

class LiveConformanceAssertionError extends Error {
  constructor(assertionId, message) {
    super(message);
    this.name = "LiveConformanceAssertionError";
    this.assertionId = assertionId;
    this.reasonCode = "semantic-assertion-failed";
  }
}

class LiveConformanceCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveConformanceCapabilityError";
    this.reasonCode = "capability-regression";
  }
}

class LiveConformanceBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveConformanceBudgetError";
    this.reasonCode = "budget-exceeded";
  }
}

class LiveConformanceTransportError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "LiveConformanceTransportError";
    this.reasonCode = reasonCode;
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readProjectFile(relativePath, projectRoot = PROJECT_ROOT) {
  return fs.readFileSync(path.join(projectRoot, relativePath));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isIsoDateTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/** Scheduled/manual gate. The lane never runs from a pull request. */
export function isLiveConformanceEnabled(env = process.env) {
  return LIVE_CONFORMANCE_NETWORK_GATES.some((name) => /^(?:1|true)$/i.test(env[name] ?? ""));
}

export function liveConformanceSourceRevision(env = process.env, projectRoot = PROJECT_ROOT) {
  const supplied = env.HONUA_SAMPLE_SOURCE_REVISION;
  if (/^[a-f0-9]{40}$/.test(supplied ?? "")) return supplied;
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

/**
 * Validate a reviewed public endpoint. Public targets must be credential-free
 * HTTPS DNS names on the default port with no query string or fragment; the
 * offline unit lane may opt into loopback HTTP so the runner logic itself can
 * be proven without network access.
 */
export function validateLiveConformanceEndpoint(value, options = {}) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Live-conformance endpoints must be absolute URLs");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Live-conformance endpoints cannot carry credentials, query strings, or fragments");
  }
  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (options.allowLoopback === true && endpoint.protocol === "http:" && isLoopbackHostname(hostname)) {
    return trimTrailingSlash(endpoint.toString());
  }
  if (endpoint.protocol !== "https:") throw new Error("Live-conformance public endpoints must use HTTPS");
  if (endpoint.port && endpoint.port !== "443") {
    throw new Error("Live-conformance public endpoints cannot select a non-default port");
  }
  if (
    isIP(hostname) !== 0 ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Live-conformance public endpoints must use a public DNS hostname");
  }
  return trimTrailingSlash(endpoint.toString());
}

function isLoopbackHostname(hostname) {
  if (hostname === "::1") return true;
  if (isIP(hostname) !== 4) return false;
  return Number(hostname.split(".", 1)[0]) === 127;
}

function trimTrailingSlash(value) {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Endpoint identity for the artifact: origin + path only, never a query. */
export function redactLiveConformanceEndpoint(value) {
  const url = new URL(value);
  const endpointPath = trimTrailingSlash(url.pathname);
  return Object.freeze({
    identity: `${url.host.toLowerCase()}${endpointPath === "/" ? "" : endpointPath}`,
    origin: url.origin,
    path: endpointPath,
  });
}

function normalizeParameterName(name) {
  return name
    .normalize("NFKC")
    .replace(/^\$/u, "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export function isCredentialQueryParameter(name) {
  const normalized = normalizeParameterName(name);
  const compact = normalized.replaceAll("_", "");
  return [...CREDENTIAL_QUERY_PARAMETERS].some((candidate) => {
    const compactCandidate = candidate.replaceAll("_", "");
    return (
      normalized === candidate ||
      normalized.endsWith(`_${candidate}`) ||
      compact === compactCandidate ||
      compact.endsWith(compactCandidate)
    );
  });
}

/** Names always; values only for the reviewed non-sensitive allowlist. */
export function redactQueryParameters(searchParams) {
  const parameters = [];
  for (const [name, value] of searchParams) {
    const normalized = normalizeParameterName(name);
    const allowed =
      SAFE_QUERY_PARAMETER_VALUES.has(normalized) || SAFE_QUERY_PARAMETER_VALUES.has(normalized.replaceAll("_", ""));
    const safe = allowed && !isCredentialQueryParameter(name) && value.length <= 128;
    parameters.push(Object.freeze({ name, value: safe ? value : null }));
  }
  return Object.freeze(parameters);
}

/**
 * Fail closed on anything that looks like a credential in the published
 * artifact. Complements per-field redaction: this is the whole-document sweep.
 */
export function assertLiveConformanceEvidenceRedacted(evidence) {
  const serialized = JSON.stringify(evidence);
  for (const pattern of [
    /"authorization"\s*:/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/,
    /\baws_?access_?key/i,
    /\bx-api-key\b/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ]) {
    invariant(!pattern.test(serialized), `live-conformance evidence matched a credential pattern: ${pattern}`);
  }
  for (const target of evidence.targets ?? []) {
    invariant(
      !target.endpoint.identity.includes("?") && !target.endpoint.identity.includes("#"),
      `live-conformance evidence retained a query or fragment for ${target.id}`,
    );
    for (const entry of target.traffic.ledger) {
      invariant(!entry.path.includes("?"), `live-conformance ledger retained a query string for ${target.id}`);
      for (const parameter of entry.parameters) {
        invariant(
          !isCredentialQueryParameter(parameter.name),
          `live-conformance ledger retained a credential parameter for ${target.id}`,
        );
      }
    }
  }
  return evidence;
}

export function normalizeLiveConformanceBudgets(value) {
  const budgets = { ...value };
  const required = [
    "runTimeoutMs",
    "targetTimeoutMs",
    "requestTimeoutMs",
    "maxRequestsPerTarget",
    "maxResponseBytes",
    "maxTotalResponseBytes",
    "maxRetriesPerRequest",
    "maxPageSize",
  ];
  for (const name of required) {
    const limit = budgets[name];
    invariant(
      Number.isSafeInteger(limit) && (name === "maxRetriesPerRequest" ? limit >= 0 : limit > 0),
      `live-conformance budget ${name} must be a non-negative safe integer`,
    );
  }
  invariant(
    budgets.maxResponseBytes <= budgets.maxTotalResponseBytes,
    "live-conformance per-response budget cannot exceed the total response budget",
  );
  invariant(
    budgets.requestTimeoutMs <= budgets.targetTimeoutMs && budgets.targetTimeoutMs <= budgets.runTimeoutMs,
    "live-conformance timeouts must nest request <= target <= run",
  );
  return Object.freeze(budgets);
}

export function loadLiveConformanceEndpointManifest(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const bytes = readProjectFile(LIVE_CONFORMANCE_ENDPOINT_MANIFEST_PATH, projectRoot);
  const manifest = JSON.parse(bytes.toString("utf8"));
  return Object.freeze({
    manifest: validateLiveConformanceEndpointManifest(manifest, options),
    sha256: sha256(bytes),
    path: LIVE_CONFORMANCE_ENDPOINT_MANIFEST_PATH,
  });
}

/**
 * Structural + policy validation of the versioned endpoint manifest. This runs
 * before any network access so a malformed or unreviewed manifest can never
 * produce a green lane.
 */
export function validateLiveConformanceEndpointManifest(manifest, options = {}) {
  invariant(manifest?.format === LIVE_CONFORMANCE_ENDPOINT_MANIFEST_FORMAT, "endpoint manifest format drift");
  invariant(manifest.schemaVersion === 1, "endpoint manifest schemaVersion drift");
  invariant(isIsoDate(manifest.revision), "endpoint manifest revision must be an ISO date");
  invariant(/^[a-z0-9][a-z0-9-]*$/.test(manifest.manifestEvidenceId ?? ""), "endpoint manifest evidence id is invalid");
  invariant(manifest.artifact?.format === LIVE_CONFORMANCE_EVIDENCE_FORMAT, "endpoint manifest artifact format drift");
  invariant(
    manifest.artifact?.schema === LIVE_CONFORMANCE_EVIDENCE_SCHEMA_PATH,
    "endpoint manifest artifact schema drift",
  );
  invariant(typeof manifest.artifact?.defaultPath === "string", "endpoint manifest artifact defaultPath is required");
  invariant(manifest.defaults?.authMode === "anonymous", "live-conformance targets must be anonymous");
  invariant(
    Number.isSafeInteger(manifest.defaults?.reviewCadenceDays) && manifest.defaults.reviewCadenceDays >= 7,
    "endpoint manifest review cadence is invalid",
  );
  normalizeLiveConformanceBudgets(manifest.budgets);
  invariant(Array.isArray(manifest.targets) && manifest.targets.length > 0, "endpoint manifest lists no targets");

  const seen = new Set();
  const protocols = new Set();
  for (const target of manifest.targets) {
    invariant(/^[a-z0-9][a-z0-9-]*$/.test(target.id ?? ""), "endpoint manifest target id is invalid");
    invariant(!seen.has(target.id), `endpoint manifest target ${target.id} is duplicated`);
    seen.add(target.id);
    protocols.add(target.protocol);
    invariant(typeof target.protocol === "string" && target.protocol.length > 0, `${target.id} declares no protocol`);
    validateLiveConformanceEndpoint(target.endpoint, options);
    invariant(typeof target.provider === "string" && target.provider.length > 1, `${target.id} declares no provider`);
    invariant(
      typeof target.attribution === "string" && target.attribution.length > 1,
      `${target.id} declares no attribution`,
    );
    invariant(typeof target.owner === "string" && target.owner.length > 2, `${target.id} declares no owner`);
    invariant(isIsoDate(target.reviewedAt), `${target.id} reviewedAt must be an ISO date`);
    invariant(isIsoDate(target.reviewExpiresAt), `${target.id} reviewExpiresAt must be an ISO date`);
    invariant(
      Date.parse(target.reviewExpiresAt) > Date.parse(target.reviewedAt),
      `${target.id} review expiry must follow its review`,
    );
    invariant(
      Date.parse(target.reviewExpiresAt) - Date.parse(target.reviewedAt) <=
        manifest.defaults.reviewCadenceDays * 86_400_000,
      `${target.id} review window exceeds the manifest cadence`,
    );
    invariant(LIVE_CONFORMANCE_JOURNEYS.includes(target.journey), `${target.id} declares an unknown journey`);
    invariant(typeof target.sourceId === "string" && target.sourceId.length > 0, `${target.id} declares no sourceId`);
    invariant(
      Array.isArray(target.expect?.capabilities) && target.expect.capabilities.length > 0,
      `${target.id} declares no expected capabilities`,
    );
    invariant(typeof target.expect?.conformanceEvidence === "string", `${target.id} declares no conformance evidence`);
    invariant(typeof target.notes === "string" && target.notes.length >= 10, `${target.id} carries no reviewer notes`);
    if (target.journey === "raster-tiles") {
      invariant(
        Array.isArray(target.expect.tileFormats) && target.expect.tileFormats.length > 0,
        `${target.id} raster journey declares no accepted tile formats`,
      );
      invariant(target.expect.tile !== undefined, `${target.id} raster journey declares no bounded tile`);
    }
    if (target.enabled === false) {
      invariant(target.skip !== undefined, `${target.id} is disabled without typed skip metadata`);
      invariant(typeof target.skip.reasonCode === "string", `${target.id} skip metadata declares no reason code`);
      invariant(typeof target.skip.reason === "string" && target.skip.reason.length >= 10, `${target.id} skip reason`);
      invariant(typeof target.skip.owner === "string" && target.skip.owner.length > 2, `${target.id} skip owner`);
      invariant(isIsoDate(target.skip.expiresAt), `${target.id} skip metadata must expire on an ISO date`);
    } else {
      invariant(target.skip === undefined, `${target.id} carries skip metadata while enabled`);
    }
  }
  // REQ-001: the lane is only meaningful while it spans the protocol families.
  for (const family of [
    ["geoservices-feature-service", "geoservices-map-service"],
    ["ogc-features"],
    ["wfs"],
    ["wms"],
    ["wmts"],
    ["stac"],
    ["odata"],
  ]) {
    invariant(
      family.some((protocol) => protocols.has(protocol)),
      `endpoint manifest covers no target for the ${family.join("/")} family`,
    );
  }
  return manifest;
}

function combineSignals(...signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function mediaTypeOf(response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function isAllowedMediaType(mediaType, allowImages) {
  if (mediaType === null) return true;
  if (METADATA_MEDIA_TYPES.has(mediaType) || mediaType.endsWith("+json") || mediaType.endsWith("+xml")) return true;
  return allowImages === true && mediaType.startsWith("image/");
}

export function imageSignatureOf(bytes) {
  for (const candidate of IMAGE_SIGNATURES) {
    if (candidate.bytes.every((byte, index) => bytes[index] === byte)) return candidate.signature;
  }
  return "unknown";
}

/**
 * Bounded, redacting fetch seam handed to the SDK client. Enforces REQ-004
 * (timeouts, response size, request count, no redirects) and the credential
 * policy, and records the redacted request ledger the artifact publishes.
 */
export function createBoundedLiveConformanceFetch(options) {
  const targetUrl = new URL(
    validateLiveConformanceEndpoint(options.targetUrl, { allowLoopback: options.allowLoopback === true }),
  );
  const budgets = normalizeLiveConformanceBudgets(options.budgets);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const allowImages = options.allowImages === true;
  const ledger = options.ledger ?? [];
  const state = options.state ?? { requests: 0, responseBytes: 0 };

  return async (input, init) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new LiveConformanceTransportError("unexpected-error", "live-conformance permits only GET/HEAD requests");
    }
    if (requestUrl.origin !== targetUrl.origin || requestUrl.username || requestUrl.password || requestUrl.hash) {
      throw new LiveConformanceTransportError(
        "unexpected-error",
        `live-conformance requests must stay same-origin and credential-free (${requestUrl.origin})`,
      );
    }
    for (const name of requestUrl.searchParams.keys()) {
      if (isCredentialQueryParameter(name)) {
        throw new LiveConformanceTransportError(
          "unexpected-error",
          "live-conformance requests cannot carry credential query parameters",
        );
      }
    }
    for (const name of FORBIDDEN_REQUEST_HEADERS) {
      if (request.headers.has(name)) {
        throw new LiveConformanceTransportError(
          "unexpected-error",
          "live-conformance requests cannot carry credential headers",
        );
      }
    }
    for (const [name] of request.headers) {
      if (!ALLOWED_REQUEST_HEADERS.has(name)) {
        throw new LiveConformanceTransportError(
          "unexpected-error",
          `live-conformance requests cannot set the ${name} header`,
        );
      }
    }

    state.requests += 1;
    if (state.requests > budgets.maxRequestsPerTarget) {
      throw new LiveConformanceBudgetError(
        `live-conformance exceeded its ${budgets.maxRequestsPerTarget}-request per-target budget`,
      );
    }
    const entry = {
      method: request.method,
      path: requestUrl.pathname,
      status: null,
      bytes: 0,
      mediaType: null,
      parameters: redactQueryParameters(requestUrl.searchParams),
    };
    ledger.push(entry);

    const signal = combineSignals(
      request.signal,
      options.producerSignal,
      AbortSignal.timeout(budgets.requestTimeoutMs),
    );
    let response;
    try {
      response = await fetchFn(request, { credentials: "omit", redirect: "manual", signal });
    } catch (error) {
      throw toTransportError(error);
    }
    entry.status = response.status;
    entry.mediaType = mediaTypeOf(response);
    if (response.status >= 300 && response.status < 400) {
      throw new LiveConformanceTransportError(
        "endpoint-redirect-refused",
        `live-conformance does not follow redirects (HTTP ${response.status})`,
      );
    }
    if (response.redirected) {
      throw new LiveConformanceTransportError(
        "endpoint-redirect-refused",
        "live-conformance does not accept followed responses",
      );
    }
    if (!isAllowedMediaType(entry.mediaType, allowImages)) {
      throw new LiveConformanceTransportError(
        "unexpected-error",
        `live-conformance refused an unreviewed ${entry.mediaType} response`,
      );
    }

    const remaining = budgets.maxTotalResponseBytes - state.responseBytes;
    if (remaining <= 0) {
      throw new LiveConformanceBudgetError("live-conformance exceeded its total response budget");
    }
    const copied = await copyBoundedResponse(response, Math.min(budgets.maxResponseBytes, remaining), signal);
    entry.bytes = copied.bytes;
    state.responseBytes += copied.bytes;
    return copied.response;
  };
}

async function copyBoundedResponse(response, maxBytes, signal) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new LiveConformanceBudgetError(`live-conformance response exceeded its ${maxBytes}-byte budget`);
    }
  }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    const abort = () => void reader.cancel().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel("live-conformance response budget exceeded").catch(() => undefined);
          throw new LiveConformanceBudgetError(`live-conformance response exceeded its ${maxBytes}-byte budget`);
        }
        chunks.push(next.value);
      }
    } catch (error) {
      throw toTransportError(error);
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  }
  const body = bytes === 0 ? null : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    bytes,
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

function toTransportError(error) {
  if (error instanceof LiveConformanceBudgetError || error instanceof LiveConformanceTransportError) return error;
  const name = error?.name ?? "";
  if (name === "TimeoutError") return new LiveConformanceTransportError("endpoint-timeout", errorMessage(error));
  if (name === "AbortError") return new LiveConformanceTransportError("run-cancelled", errorMessage(error));
  return new LiveConformanceTransportError("endpoint-unreachable", errorMessage(error));
}

function errorMessage(error) {
  const message = error?.message ?? String(error);
  return message.length > 400 ? `${message.slice(0, 397)}...` : message;
}

/**
 * Map any thrown value onto the typed degradation vocabulary. Availability
 * problems degrade; anything semantic fails, including HTTP 4xx, because a
 * 4xx to an SDK-serialized request is a serializer or manifest defect.
 */
export function classifyLiveConformanceFailure(error) {
  if (typeof error?.reasonCode === "string") {
    return { code: error.reasonCode, message: errorMessage(error) };
  }
  const name = error?.name ?? "";
  const sdkCode = typeof error?.sdkCode === "string" ? error.sdkCode : null;
  const status = Number.isSafeInteger(error?.status) ? error.status : null;
  if (name === "HonuaTimeoutError" || name === "TimeoutError") {
    return { code: "endpoint-timeout", message: errorMessage(error) };
  }
  if (name === "HonuaAbortError" || name === "AbortError") {
    return { code: "run-cancelled", message: errorMessage(error) };
  }
  if (name === "HonuaNetworkError") return { code: "endpoint-unreachable", message: errorMessage(error) };
  if (name === "HonuaCapabilityNotSupportedError" || sdkCode === "core.capability-not-supported") {
    return { code: "capability-regression", message: errorMessage(error) };
  }
  if (name === "HonuaHttpError" || status !== null) {
    const httpStatus = status ?? Number(/HTTP (\d{3})/.exec(error?.message ?? "")?.[1] ?? Number.NaN);
    if (httpStatus === 429) return { code: "endpoint-rate-limited", message: errorMessage(error) };
    if (httpStatus === 408) return { code: "endpoint-timeout", message: errorMessage(error) };
    if (httpStatus >= 500) return { code: "endpoint-server-error", message: errorMessage(error) };
    if (httpStatus >= 400) return { code: "endpoint-client-error", message: errorMessage(error) };
    return { code: "endpoint-unreachable", message: errorMessage(error) };
  }
  return { code: "unexpected-error", message: errorMessage(error) };
}

function degradationStateFor(code) {
  if (code === "live-lane-disabled" || code === "target-muted") return "muted";
  if (AVAILABILITY_CODES.includes(code) || code === "run-cancelled") return "unavailable";
  if (code === "capability-regression") return "capability-gap";
  if (code === "semantic-assertion-failed") return "semantic-regression";
  if (SEMANTIC_CODES.includes(code)) return "unexpected";
  return "unexpected";
}

function targetStatusFor(code) {
  if (code === "live-lane-disabled" || code === "target-muted") return "skipped";
  if (AVAILABILITY_CODES.includes(code) || code === "run-cancelled") return "degraded";
  return "failed";
}

async function loadDefaultSdk() {
  const [root, map] = await Promise.all([import("../dist/src/index.js"), import("../dist/src/map/index.js")]);
  return {
    connect: root.connect,
    explainQuery: root.explainQuery,
    HonuaClient: root.HonuaClient,
    projectRasterSourceToMapLibre: map.projectRasterSourceToMapLibre,
  };
}

class AssertionLedger {
  constructor() {
    this.entries = [];
  }

  pass(id, detail) {
    this.entries.push({ id, outcome: "pass", ...(detail ? { detail } : {}) });
  }

  require(id, condition, detail) {
    if (condition) {
      this.pass(id);
      return;
    }
    this.entries.push({ id, outcome: "fail", detail: detail ?? null });
    throw new LiveConformanceAssertionError(id, `${id}: ${detail ?? "semantic assertion failed"}`);
  }
}

function projectCapabilityDecisions(decisions) {
  return decisions.map((decision) => ({
    capability: decision.capability,
    effective: decision.effective === true,
    code: decision.code,
    evidenceKinds: [...new Set((decision.evidence ?? []).map((entry) => entry.kind))],
  }));
}

async function collectConformanceEvidence(kind, context) {
  const { target, selected, sdk, fetchFn, signal } = context;
  if (kind === "ogc-features-conformance-classes" || kind === "stac-landing-conformance-classes") {
    const client = new sdk.HonuaClient({
      baseUrl: target.endpoint,
      fetchFn,
      retry: { maxRetries: context.maxRetries },
    });
    if (kind === "stac-landing-conformance-classes") {
      const landing = await client.getStacLanding({ stacBasePath: "", ...(signal ? { signal } : {}) });
      return { kind, classes: [...(landing.conformsTo ?? [])], operations: [] };
    }
    const layout = await client.resolveOgcFeaturesLayout("ogc-api");
    const conformance = await client.getOgcFeaturesConformance({ layout, ...(signal ? { signal } : {}) });
    return { kind, classes: [...(conformance.conformsTo ?? [])], operations: [] };
  }
  if (kind === "capabilities-document-operations") {
    const advertised = Object.entries(selected?.metadata?.operations ?? {}).map(([name, operation]) => ({
      name,
      available: operation?.available === true,
      formats: [...(operation?.formats ?? [])],
      reason: operation?.reason ?? null,
    }));
    // WFS capabilities carry their operation truth in the capability decisions
    // rather than a metadata operations map; record whichever the adapter
    // exposes so the artifact is never operation-blind.
    const operations = advertised.length > 0 ? advertised : metadataDecisionOperations(selected);
    return { kind, classes: [], operations };
  }
  return { kind: "service-metadata-operations", classes: [], operations: metadataDecisionOperations(selected) };
}

function metadataDecisionOperations(selected) {
  return projectCapabilityDecisions(selected?.capabilityDecisions ?? [])
    .filter((decision) => decision.evidenceKinds.length > 0)
    .map((decision) => ({ name: decision.capability, available: decision.effective }));
}

function pickCapabilityGuard(decisions, preferred) {
  // Prefer a read-only, side-effect-free operation the endpoint does not
  // advertise. The SDK must throw before it touches the network.
  const unavailable = new Set(decisions.filter((decision) => !decision.effective).map((d) => d.capability));
  return preferred.find((capability) => unavailable.has(capability)) ?? null;
}

const QUERY_JOURNEY_GUARDS = Object.freeze([
  "queryAggregate",
  "queryExtent",
  "queryRelated",
  "queryObjectIds",
  "attachments",
]);
const RASTER_JOURNEY_GUARDS = Object.freeze(["query", "queryExtent", "queryObjectIds"]);

async function runCapabilityGuard(source, capability) {
  try {
    if (capability === "queryAggregate") {
      await source.queryAggregate({ aggregation: { aggregates: [{ kind: "count", alias: "n" }] } });
    } else if (capability === "queryExtent") await source.queryExtent({});
    else if (capability === "queryRelated") await source.queryRelated({ relationshipId: 0 });
    else if (capability === "queryObjectIds") await source.queryObjectIds({});
    else if (capability === "query") await source.query({ pagination: { limit: 1 } });
    else await source.attachments({ objectIds: [1] });
  } catch (error) {
    return {
      capability,
      errorName: error?.name ?? "UnknownError",
      sdkCode: typeof error?.sdkCode === "string" ? error.sdkCode : "unknown",
    };
  }
  return null;
}

function explainQuerySafely(sdk, descriptor, query) {
  let plan;
  try {
    plan = sdk.explainQuery({ descriptor, query, capabilityPolicy: "strict" });
  } catch (error) {
    // Not every protocol has a deterministic compiler (STAC does not). That is
    // recorded; any other planning failure is a real regression and rethrows.
    if (error?.code !== "unsupported-compiler") throw error;
    return {
      available: false,
      capabilityPolicy: "strict",
      fidelity: null,
      lossCount: null,
      requestUpperBound: null,
      pushdown: [],
      reason: errorMessage(error),
    };
  }
  return {
    available: true,
    capabilityPolicy: plan.capabilityPolicy ?? "strict",
    fidelity: plan.fidelity ?? null,
    lossCount: Array.isArray(plan.losses) ? plan.losses.length : null,
    requestUpperBound: Number.isSafeInteger(plan.bounds?.requests?.upper) ? plan.bounds.requests.upper : null,
    pushdown: [...new Set((plan.steps ?? []).map((step) => step.pushdown).filter(Boolean))],
    reason: null,
  };
}

/**
 * Drive one reviewed target end to end. Throws only for programming errors;
 * every observed problem is returned as a typed target record.
 */
export async function runLiveConformanceTarget(context) {
  const { target, budgets, sdk, now } = context;
  const observedAt = context.observedAt ?? new Date().toISOString();
  const endpoint = redactLiveConformanceEndpoint(
    validateLiveConformanceEndpoint(target.endpoint, { allowLoopback: context.allowLoopback === true }),
  );
  const base = {
    id: target.id,
    protocol: target.protocol,
    status: "executed",
    journey: target.journey,
    endpoint,
    provider: target.provider,
    attribution: target.attribution,
    reliability: target.reliability,
    owner: target.owner,
    reviewedAt: target.reviewedAt,
    reviewExpiresAt: target.reviewExpiresAt,
    observedAt,
  };
  const emptyTiming = { totalMs: null, discoveryMs: null, operationMs: null };
  const emptyTraffic = { requests: 0, responseBytes: 0, ledger: [] };

  if (target.enabled === false) {
    const expired = Date.parse(`${target.skip.expiresAt}T00:00:00Z`) < Date.parse(now);
    const code = expired ? "mute-metadata-expired" : "target-muted";
    return {
      ...base,
      status: expired ? "failed" : "skipped",
      timing: emptyTiming,
      traffic: emptyTraffic,
      discovery: null,
      operation: null,
      assertions: [],
      degradation: {
        state: expired ? "unexpected" : "muted",
        reasons: [
          {
            code,
            message: expired
              ? `The mute for ${target.id} expired on ${target.skip.expiresAt} and was not renewed.`
              : target.skip.reason,
            owner: target.skip.owner,
            expiresAt: target.skip.expiresAt,
            tracking: target.skip.tracking ?? null,
          },
        ],
      },
    };
  }

  if (Date.parse(`${target.reviewExpiresAt}T00:00:00Z`) < Date.parse(now)) {
    return {
      ...base,
      status: "failed",
      timing: emptyTiming,
      traffic: emptyTraffic,
      discovery: null,
      operation: null,
      assertions: [],
      degradation: {
        state: "unexpected",
        reasons: [
          {
            code: "endpoint-review-expired",
            message: `The endpoint review for ${target.id} expired on ${target.reviewExpiresAt}; re-review it before trusting this lane.`,
            owner: target.owner,
            expiresAt: target.reviewExpiresAt,
            tracking: null,
          },
        ],
      },
    };
  }

  const ledger = [];
  const state = { requests: 0, responseBytes: 0 };
  const fetchFn = createBoundedLiveConformanceFetch({
    targetUrl: target.endpoint,
    allowLoopback: context.allowLoopback === true,
    budgets,
    fetchFn: context.fetchFn,
    producerSignal: context.producerSignal,
    allowImages: target.journey === "raster-tiles",
    ledger,
    state,
  });
  const targetController = new AbortController();
  const targetTimer = setTimeout(() => targetController.abort(), budgets.targetTimeoutMs);
  const signal = combineSignals(context.producerSignal, targetController.signal);
  const assertions = new AssertionLedger();
  const startedAt = performance.now();
  let discoveryMs = null;
  let operationMs = null;
  let discovery = null;
  let operation = null;

  try {
    const connection = await sdk.connect({
      endpoint: target.endpoint,
      protocol: target.protocol,
      authorizationScopeFingerprint: "honua-live-conformance:v1",
      ...(target.discovery?.collectionId ? { collectionId: target.discovery.collectionId } : {}),
      ...(target.discovery?.typeName ? { typeName: target.discovery.typeName } : {}),
      ...(target.discovery?.styleId ? { styleId: target.discovery.styleId } : {}),
      ...(target.discovery?.tileMatrixSetId ? { tileMatrixSetId: target.discovery.tileMatrixSetId } : {}),
      clientOptions: { fetchFn, retry: { maxRetries: budgets.maxRetriesPerRequest } },
      ...(signal ? { signal } : {}),
    });
    discoveryMs = Math.max(0, performance.now() - startedAt);
    const inspection = connection.inspection;
    assertions.require(
      "discovery-resolves-declared-protocol",
      inspection.protocol === target.protocol,
      `discovery resolved ${inspection.protocol}`,
    );
    const selected = inspection.sources.find((source) => source.descriptor.id === target.sourceId);
    assertions.require(
      "discovery-retains-reviewed-source-identity",
      selected !== undefined,
      `discovered sources ${inspection.sources
        .slice(0, 8)
        .map((source) => source.descriptor.id)
        .join(",")}`,
    );
    const decisions = projectCapabilityDecisions(selected.capabilityDecisions ?? []);
    assertions.require("discovery-records-capability-decisions", decisions.length > 0, "no capability decisions");

    const conformance = await collectConformanceEvidence(target.expect.conformanceEvidence, {
      target,
      selected,
      sdk,
      fetchFn,
      signal,
      maxRetries: budgets.maxRetriesPerRequest,
    });
    discovery = {
      protocol: inspection.protocol,
      cacheStatus: inspection.cacheStatus,
      sourceId: selected.descriptor.id,
      sourceCount: inspection.sources.length,
      discoveryState: selected.discovery,
      protocolVersion: selected.metadata?.protocolVersion ?? null,
      capabilities: [...selected.descriptor.capabilities],
      capabilityDecisions: decisions,
      conformance,
      diagnostics: (inspection.diagnostics ?? []).map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        ...(diagnostic.capabilities ? { capabilities: [...diagnostic.capabilities] } : {}),
      })),
      ...(selected.metadata?.partialReasons ? { partialReasons: [...selected.metadata.partialReasons] } : {}),
    };

    // REQ-002: every target must publish operation-level or conformance-class
    // evidence, never a bare protocol boolean.
    assertions.require(
      "discovery-records-operation-or-conformance-class-evidence",
      conformance.classes.length + conformance.operations.length > 0,
      `${conformance.kind} produced no classes or operations`,
    );

    for (const expected of target.expect.conformanceClasses ?? []) {
      if (!conformance.classes.includes(expected)) {
        throw new LiveConformanceCapabilityError(
          `${target.id} no longer advertises the required conformance class ${expected}`,
        );
      }
    }
    assertions.pass("required-conformance-classes-still-advertised");

    for (const capability of target.expect.capabilities) {
      const decision = decisions.find((entry) => entry.capability === capability);
      if (!decision?.effective) {
        throw new LiveConformanceCapabilityError(
          `${target.id} no longer resolves the ${capability} capability (${decision?.code ?? "absent"})`,
        );
      }
    }
    assertions.pass("expected-operations-resolve-as-effective");

    if (target.expect.protocolVersion !== undefined) {
      assertions.require(
        "advertised-protocol-version-matches-review",
        discovery.protocolVersion === target.expect.protocolVersion,
        `advertised ${discovery.protocolVersion ?? "none"}`,
      );
    }

    const operationStartedAt = performance.now();
    operation =
      target.journey === "query"
        ? await runQueryJourney({ connection, selected, target, budgets, sdk, signal, assertions })
        : await runRasterJourney({ selected, target, budgets, sdk, fetchFn, signal, assertions });
    operationMs = Math.max(0, performance.now() - operationStartedAt);

    return {
      ...base,
      status: "executed",
      timing: { totalMs: Math.max(0, performance.now() - startedAt), discoveryMs, operationMs },
      traffic: { requests: state.requests, responseBytes: state.responseBytes, ledger },
      discovery,
      operation,
      assertions: assertions.entries,
      degradation: { state: "none", reasons: [] },
    };
  } catch (error) {
    const classified = classifyLiveConformanceFailure(error);
    return {
      ...base,
      status: targetStatusFor(classified.code),
      timing: { totalMs: Math.max(0, performance.now() - startedAt), discoveryMs, operationMs },
      traffic: { requests: state.requests, responseBytes: state.responseBytes, ledger },
      discovery,
      operation,
      assertions: assertions.entries,
      degradation: {
        state: degradationStateFor(classified.code),
        reasons: [
          {
            code: classified.code,
            message: classified.message,
            owner: target.owner,
            expiresAt: target.reviewExpiresAt,
            tracking: null,
          },
        ],
      },
    };
  } finally {
    clearTimeout(targetTimer);
  }
}

async function runQueryJourney(context) {
  const { connection, selected, target, budgets, sdk, signal, assertions } = context;
  const limit = Math.max(1, Math.min(budgets.maxPageSize, target.expect.minItemCount ?? 1));
  const source = connection.source(selected.descriptor.id);
  const plan = explainQuerySafely(sdk, source.descriptor, { pagination: { limit } });
  if (plan.available) {
    assertions.require(
      "strict-query-plan-stays-exact",
      plan.fidelity === "exact" && plan.lossCount === 0,
      `fidelity ${plan.fidelity ?? "none"} with ${plan.lossCount ?? "unknown"} losses`,
    );
    assertions.require(
      "strict-query-plan-bounds-requests",
      plan.requestUpperBound !== null && plan.requestUpperBound <= budgets.maxRequestsPerTarget,
      `request upper bound ${plan.requestUpperBound ?? "unknown"}`,
    );
  }

  const result = await source.query({ pagination: { limit }, ...(signal ? { signal } : {}) });
  const features = result.features ?? [];
  assertions.require(
    "bounded-page-honours-the-requested-limit",
    features.length <= limit,
    `returned ${features.length} for limit ${limit}`,
  );
  assertions.require(
    "bounded-page-returns-parsed-features",
    features.length >= (target.expect.minItemCount ?? 1),
    `returned ${features.length}`,
  );
  const attributeCount = Object.keys(features[0]?.attributes ?? {}).length;
  assertions.require(
    "parsed-features-carry-typed-attributes",
    attributeCount > 0,
    `first feature exposed ${attributeCount} attributes`,
  );
  const geometryPresent = features[0]?.geometry !== undefined && features[0]?.geometry !== null;
  if (target.expect.geometry !== undefined) {
    assertions.require(
      "parsed-features-match-reviewed-geometry-expectation",
      geometryPresent === target.expect.geometry,
      `geometry ${geometryPresent ? "present" : "absent"}`,
    );
  }

  const degradedReasons = (result.degraded ?? []).map((entry) => `${entry.capability}:${entry.reason}`);
  assertions.require(
    "bounded-page-is-not-a-degraded-fallback",
    degradedReasons.length === 0,
    degradedReasons.join(" | "),
  );

  const capabilityGuard = await probeCapabilityGuard({
    source,
    decisions: projectCapabilityDecisions(selected.capabilityDecisions ?? []),
    preferred: QUERY_JOURNEY_GUARDS,
    assertions,
  });

  return {
    kind: "source-query",
    capability: "query",
    outcome: "bounded-page-parsed-through-the-canonical-source-contract",
    itemCount: features.length,
    attributeCount,
    geometryPresent,
    exceededTransferLimit: result.exceededTransferLimit ?? null,
    requestedLimit: limit,
    degradedReasons,
    plan,
    raster: null,
    capabilityGuard,
  };
}

/**
 * The SDK's headline contract: an operation the endpoint does not advertise
 * throws `HonuaCapabilityNotSupportedError` instead of returning empty data.
 * Costs no requests because the capability check precedes the wire.
 */
async function probeCapabilityGuard(context) {
  const { source, decisions, preferred, assertions } = context;
  const capability = source === null ? null : pickCapabilityGuard(decisions, preferred);
  if (!capability) return null;
  const guard = await runCapabilityGuard(source, capability);
  assertions.require(
    "unadvertised-operations-throw-instead-of-returning-empty-data",
    guard?.sdkCode === "core.capability-not-supported",
    `${capability} produced ${guard?.sdkCode ?? "no error"}`,
  );
  return guard;
}

async function runRasterJourney(context) {
  const { connection, selected, target, sdk, fetchFn, assertions } = context;
  const tileSize = 256;
  const projection = sdk.projectRasterSourceToMapLibre(selected.descriptor, { tileSize });
  const expectedStrategy = target.protocol === "wms" ? "wms-raster" : "wmts-raster";
  assertions.require(
    "raster-projection-selects-the-protocol-strategy",
    projection.strategy === expectedStrategy,
    `selected ${projection.strategy}`,
  );
  const template = projection.source.tiles[0];
  assertions.require("raster-projection-emits-one-tile-template", typeof template === "string", "no tile template");
  assertions.require(
    "raster-tile-template-stays-credential-free-https",
    template.startsWith("https://") && !/[?&](?:api_?key|token|access_?token|signature)=/i.test(template),
    "tile template failed the credential policy",
  );

  const tile = target.expect.tile;
  const url = template
    .replace("{bbox-epsg-3857}", webMercatorTileBbox(tile))
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
  const response = await fetchFn(url, { method: "GET", headers: { accept: target.expect.tileFormats.join(",") } });
  assertions.require("bounded-tile-request-returns-200", response.status === 200, `HTTP ${response.status}`);
  const mediaType = mediaTypeOf(response) ?? "";
  assertions.require(
    "bounded-tile-media-type-matches-advertised-formats",
    target.expect.tileFormats.includes(mediaType),
    `served ${mediaType || "no media type"}`,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertions.require("bounded-tile-carries-image-bytes", bytes.byteLength > 0, "empty tile body");
  const signature = imageSignatureOf(bytes);
  assertions.require(
    "bounded-tile-bytes-match-an-image-signature",
    signature !== "unknown",
    `signature ${signature} for ${mediaType}`,
  );

  const capabilityGuard = await probeCapabilityGuard({
    source: safeSource(connection, selected.descriptor.id),
    decisions: projectCapabilityDecisions(selected.capabilityDecisions ?? []),
    preferred: RASTER_JOURNEY_GUARDS,
    assertions,
  });
  return {
    kind: "maplibre-raster-tile",
    capability: "tiles",
    outcome: "sdk-projected-tile-template-served-one-bounded-image",
    itemCount: 1,
    attributeCount: null,
    geometryPresent: null,
    exceededTransferLimit: null,
    requestedLimit: null,
    degradedReasons: [],
    plan: null,
    raster: {
      strategy: projection.strategy,
      tileSize,
      tile: { z: tile.z, x: tile.x, y: tile.y },
      mediaType,
      bytes: bytes.byteLength,
      signature,
    },
    capabilityGuard,
  };
}

/** A raster-only descriptor may have no source resolver; that is not a failure. */
function safeSource(connection, sourceId) {
  try {
    return connection.source(sourceId);
  } catch {
    return null;
  }
}

const WEB_MERCATOR_HALF_SPAN = 20_037_508.342789244;

function webMercatorTileBbox(tile) {
  const span = (2 * WEB_MERCATOR_HALF_SPAN) / 2 ** tile.z;
  const minX = -WEB_MERCATOR_HALF_SPAN + tile.x * span;
  const maxY = WEB_MERCATOR_HALF_SPAN - tile.y * span;
  return `${minX},${maxY - span},${minX + span},${maxY}`;
}

function skippedEvidence(context) {
  const { manifest, manifestSha256, observedAt, reason, packageJson, runnerSha256, sourceRevision } = context;
  return {
    $schema: `../${LIVE_CONFORMANCE_EVIDENCE_SCHEMA_PATH}`,
    format: LIVE_CONFORMANCE_EVIDENCE_FORMAT,
    schemaVersion: 1,
    manifestEvidenceId: manifest.manifestEvidenceId,
    lane: "live-conformance",
    status: "skipped",
    reason,
    observedAt,
    authMode: "anonymous",
    redacted: true,
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: sourceRevision },
    runner: { path: LIVE_CONFORMANCE_RUNNER_PATH, sha256: runnerSha256 },
    endpointManifest: {
      path: LIVE_CONFORMANCE_ENDPOINT_MANIFEST_PATH,
      format: manifest.format,
      schemaVersion: manifest.schemaVersion,
      revision: manifest.revision,
      sha256: manifestSha256,
    },
    budgets: { ...manifest.budgets },
    totals: {
      targets: manifest.targets.length,
      executed: 0,
      degraded: 0,
      failed: 0,
      skipped: manifest.targets.length,
      assertions: 0,
      requests: 0,
      responseBytes: 0,
    },
    targets: manifest.targets.map((target) => ({
      id: target.id,
      protocol: target.protocol,
      status: "skipped",
      journey: target.journey,
      endpoint: redactLiveConformanceEndpoint(target.endpoint),
      provider: target.provider,
      attribution: target.attribution,
      reliability: target.reliability,
      owner: target.owner,
      reviewedAt: target.reviewedAt,
      reviewExpiresAt: target.reviewExpiresAt,
      observedAt,
      timing: { totalMs: null, discoveryMs: null, operationMs: null },
      traffic: { requests: 0, responseBytes: 0, ledger: [] },
      discovery: null,
      operation: null,
      assertions: [],
      degradation: {
        state: "muted",
        reasons: [
          {
            code: "live-lane-disabled",
            message: `Set ${LIVE_CONFORMANCE_NETWORK_GATES[0]}=true to contact the reviewed public reference services.`,
            owner: target.owner,
            expiresAt: target.reviewExpiresAt,
            tracking: null,
          },
        ],
      },
    })),
  };
}

/**
 * Run every reviewed target and return one validated, redacted evidence
 * document. Never throws for observed upstream behaviour.
 */
export async function collectLiveConformanceEvidence(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const observedAt = options.observedAt ?? new Date().toISOString();
  invariant(isIsoDateTime(observedAt), "live-conformance observedAt must be an RFC 3339 date-time");
  const loaded =
    options.manifest !== undefined
      ? {
          manifest: validateLiveConformanceEndpointManifest(options.manifest, options),
          sha256: options.manifestSha256 ?? sha256(Buffer.from(JSON.stringify(options.manifest))),
        }
      : loadLiveConformanceEndpointManifest({ projectRoot, allowLoopback: options.allowLoopback === true });
  const manifest = loaded.manifest;
  const budgets = normalizeLiveConformanceBudgets({ ...manifest.budgets, ...(options.budgets ?? {}) });
  const packageJson = JSON.parse(readProjectFile("package.json", projectRoot).toString("utf8"));
  const runnerSha256 = sha256(readProjectFile(LIVE_CONFORMANCE_RUNNER_PATH, projectRoot));
  const sourceRevision = options.sourceRevision ?? liveConformanceSourceRevision(process.env, projectRoot);
  const enabled = options.enabled ?? isLiveConformanceEnabled();

  if (!enabled) {
    return validateLiveConformanceEvidence(
      assertLiveConformanceEvidenceRedacted(
        skippedEvidence({
          manifest,
          manifestSha256: loaded.sha256,
          observedAt,
          reason: `The live-conformance lane is scheduled/manual only; set ${LIVE_CONFORMANCE_NETWORK_GATES[0]}=true to run it.`,
          packageJson,
          runnerSha256,
          sourceRevision,
        }),
      ),
      { now: observedAt },
    );
  }

  const sdk = options.sdk ?? (await loadDefaultSdk());
  const runController = new AbortController();
  const runTimer = setTimeout(() => runController.abort(), budgets.runTimeoutMs);
  const producerSignal = combineSignals(options.signal, runController.signal);
  const targets = [];
  try {
    for (const target of manifest.targets) {
      targets.push(
        await runLiveConformanceTarget({
          target,
          budgets,
          sdk,
          now: observedAt,
          observedAt: new Date().toISOString(),
          allowLoopback: options.allowLoopback === true,
          fetchFn: options.fetchFn,
          producerSignal,
        }),
      );
    }
  } finally {
    clearTimeout(runTimer);
  }

  const totals = {
    targets: targets.length,
    executed: targets.filter((target) => target.status === "executed").length,
    degraded: targets.filter((target) => target.status === "degraded").length,
    failed: targets.filter((target) => target.status === "failed").length,
    skipped: targets.filter((target) => target.status === "skipped").length,
    assertions: targets.reduce((count, target) => count + target.assertions.length, 0),
    requests: targets.reduce((count, target) => count + target.traffic.requests, 0),
    responseBytes: targets.reduce((count, target) => count + target.traffic.responseBytes, 0),
  };
  const status = totals.failed > 0 ? "failed" : totals.degraded > 0 ? "degraded" : "executed";
  const evidence = {
    $schema: `../${LIVE_CONFORMANCE_EVIDENCE_SCHEMA_PATH}`,
    format: LIVE_CONFORMANCE_EVIDENCE_FORMAT,
    schemaVersion: 1,
    manifestEvidenceId: manifest.manifestEvidenceId,
    lane: "live-conformance",
    status,
    reason:
      status === "executed"
        ? null
        : `${totals.failed} failed and ${totals.degraded} degraded of ${totals.targets} reviewed targets.`,
    observedAt,
    authMode: "anonymous",
    redacted: true,
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: sourceRevision },
    runner: { path: LIVE_CONFORMANCE_RUNNER_PATH, sha256: runnerSha256 },
    endpointManifest: {
      path: LIVE_CONFORMANCE_ENDPOINT_MANIFEST_PATH,
      format: manifest.format,
      schemaVersion: manifest.schemaVersion,
      revision: manifest.revision,
      sha256: loaded.sha256,
    },
    budgets: { ...budgets },
    totals,
    targets,
  };
  return validateLiveConformanceEvidence(assertLiveConformanceEvidenceRedacted(evidence), { now: observedAt });
}

/**
 * Structural validation of the published artifact. Mirrors
 * `schemas/live-conformance-evidence.v1.json` so the producer cannot emit a
 * document the schema would reject.
 */
export function validateLiveConformanceEvidence(evidence, options = {}) {
  invariant(evidence?.format === LIVE_CONFORMANCE_EVIDENCE_FORMAT, "live-conformance evidence format drift");
  invariant(evidence.schemaVersion === 1, "live-conformance evidence schemaVersion drift");
  invariant(evidence.lane === "live-conformance", "live-conformance evidence lane drift");
  invariant(
    ["executed", "degraded", "failed", "skipped"].includes(evidence.status),
    "live-conformance evidence status is invalid",
  );
  invariant(evidence.authMode === "anonymous", "live-conformance evidence must stay anonymous");
  invariant(evidence.redacted === true, "live-conformance evidence must declare redaction");
  invariant(isIsoDateTime(evidence.observedAt), "live-conformance observedAt must be an RFC 3339 date-time");
  const now = options.now === undefined ? Date.now() : Date.parse(options.now);
  invariant(Date.parse(evidence.observedAt) <= now + 300_000, "live-conformance observedAt is in the future");
  invariant(evidence.sdk?.package === "@honua/sdk-js", "live-conformance evidence sdk.package drift");
  invariant(typeof evidence.sdk.version === "string", "live-conformance evidence sdk.version is required");
  invariant(
    evidence.sdk.gitCommit === null || /^[a-f0-9]{40}$/.test(evidence.sdk.gitCommit),
    "live-conformance evidence gitCommit must be null or a full Git SHA",
  );
  invariant(evidence.runner?.path === LIVE_CONFORMANCE_RUNNER_PATH, "live-conformance runner path drift");
  invariant(/^[a-f0-9]{64}$/.test(evidence.runner.sha256 ?? ""), "live-conformance runner digest is invalid");
  invariant(
    evidence.endpointManifest?.path === LIVE_CONFORMANCE_ENDPOINT_MANIFEST_PATH &&
      evidence.endpointManifest.format === LIVE_CONFORMANCE_ENDPOINT_MANIFEST_FORMAT &&
      /^[a-f0-9]{64}$/.test(evidence.endpointManifest.sha256 ?? ""),
    "live-conformance endpoint-manifest identity is invalid",
  );
  normalizeLiveConformanceBudgets(evidence.budgets);
  invariant(Array.isArray(evidence.targets) && evidence.targets.length > 0, "live-conformance evidence has no targets");
  invariant(evidence.totals?.targets === evidence.targets.length, "live-conformance totals do not match the targets");

  for (const target of evidence.targets) {
    invariant(
      ["executed", "degraded", "failed", "skipped"].includes(target.status),
      `${target.id} status is invalid`,
    );
    invariant(LIVE_CONFORMANCE_JOURNEYS.includes(target.journey), `${target.id} journey is invalid`);
    invariant(isIsoDateTime(target.observedAt), `${target.id} observedAt must be an RFC 3339 date-time`);
    invariant(isIsoDate(target.reviewExpiresAt), `${target.id} reviewExpiresAt must be an ISO date`);
    invariant(typeof target.owner === "string" && target.owner.length > 2, `${target.id} records no owner`);
    if (target.status === "executed") {
      invariant(target.degradation.state === "none", `${target.id} executed with a degradation state`);
      invariant(target.degradation.reasons.length === 0, `${target.id} executed with degradation reasons`);
      invariant(target.discovery !== null, `${target.id} executed without discovery evidence`);
      invariant(target.operation !== null, `${target.id} executed without operation evidence`);
      invariant(
        target.assertions.length > 0 && target.assertions.every((entry) => entry.outcome === "pass"),
        `${target.id} executed with a failed assertion`,
      );
      invariant(
        target.discovery.capabilityDecisions.length > 0,
        `${target.id} executed without per-operation capability evidence`,
      );
    } else {
      invariant(target.degradation.state !== "none", `${target.id} is not executed but records no degradation`);
      invariant(target.degradation.reasons.length > 0, `${target.id} is not executed but records no typed reason`);
      for (const reason of target.degradation.reasons) {
        invariant(typeof reason.code === "string" && reason.code.length > 0, `${target.id} degradation code`);
        invariant(typeof reason.message === "string" && reason.message.length > 0, `${target.id} degradation message`);
        invariant(typeof reason.owner === "string" && reason.owner.length > 2, `${target.id} degradation owner`);
        invariant(isIsoDate(reason.expiresAt), `${target.id} degradation expiry must be an ISO date`);
      }
    }
  }
  return evidence;
}

/** Human-readable lane summary plus the process exit code contract. */
export function summarizeLiveConformanceEvidence(evidence, options = {}) {
  const lines = [`live-conformance ${evidence.status}: ${describeTotals(evidence.totals)}`];
  for (const target of evidence.targets) {
    const reason = target.degradation.reasons[0];
    lines.push(
      `  ${target.status.padEnd(9)} ${target.id} (${target.protocol}/${target.journey}) ${
        reason ? `-> ${reason.code}: ${reason.message}` : `-> ${target.assertions.length} assertions`
      }`,
    );
  }
  let exitCode = 0;
  if (evidence.totals.failed > 0) exitCode = 1;
  else if (evidence.totals.degraded > 0) exitCode = options.allowDegraded === true ? 0 : 2;
  else if (evidence.status === "skipped" && options.strict === true) exitCode = 1;
  return { status: evidence.status, exitCode, lines };
}

function describeTotals(totals) {
  return `${totals.executed} executed, ${totals.degraded} degraded, ${totals.failed} failed, ${totals.skipped} skipped of ${totals.targets} targets (${totals.assertions} assertions, ${totals.requests} requests, ${totals.responseBytes} bytes)`;
}

export function parseLiveConformanceArguments(argv) {
  let output = null;
  let strict = false;
  let allowDegraded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict") strict = true;
    else if (argument === "--allow-degraded") allowDegraded = true;
    else if (argument === "--output") output = argv[++index];
    else throw new Error(`Unknown live-conformance argument: ${argument}`);
  }
  invariant(output === null || typeof output === "string", "--output requires a path");
  return { output, strict, allowDegraded };
}

async function main() {
  const { output: requestedOutput, strict, allowDegraded } = parseLiveConformanceArguments(process.argv.slice(2));
  const loaded = loadLiveConformanceEndpointManifest();
  const output = path.resolve(PROJECT_ROOT, requestedOutput ?? loaded.manifest.artifact.defaultPath);
  const evidence = await collectLiveConformanceEvidence({
    manifest: loaded.manifest,
    manifestSha256: loaded.sha256,
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  const summary = summarizeLiveConformanceEvidence(evidence, { strict, allowDegraded });
  process.stdout.write(`${summary.lines.join("\n")}\n${output}\n`);
  process.exitCode = summary.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`live-conformance evidence runner failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
