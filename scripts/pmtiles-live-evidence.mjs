import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST_URL = "https://demo.honua.io/demo-services.v1.json";
const DEFAULT_SERVICE_ID = "maui-basemap";
const DEFAULT_OUTPUT = "test-results/pmtiles-live-evidence.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RANGE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const NETWORK_GATES = ["HONUA_PMTILES_LIVE_ENABLED"];
const SDK_PACKAGE = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function credentialFreeUrl(value, label) {
  const url = new URL(value);
  invariant(url.protocol === "https:", `${label} must use HTTPS`);
  invariant(!url.username && !url.password && !url.hash, `${label} must not contain credentials or fragments`);
  for (const name of url.searchParams.keys()) {
    invariant(!/(?:token|signature|credential|api[-_]?key|sig|secret)/i.test(name), `${label} contains a credential query`);
  }
  return url;
}

function assertCredentialFreeHeaders(headers, label) {
  for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) {
    invariant(!headers.has(name), `${label} unexpectedly carried ${name}`);
  }
}

async function readBoundedBody(response, maximumBytes, signal) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    invariant(Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximumBytes, "Manifest Content-Length is invalid or oversized");
  }
  invariant(response.body, "Manifest response has no readable body");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      invariant(!signal?.aborted, "Manifest read was aborted");
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Manifest response exceeded its ${maximumBytes}-byte ceiling`);
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function isPmtilesLiveEvidenceEnabled(env = process.env) {
  return NETWORK_GATES.some((name) => /^(?:1|true)$/i.test(env[name] ?? ""));
}

export function resolvePmtilesArchive(manifest, manifestUrl, serviceId = DEFAULT_SERVICE_ID) {
  invariant(isPlainObject(manifest), "Demo service manifest must be an object");
  invariant(manifest.format === "honua.demo-services.v1", "Demo service manifest format drift");
  invariant(typeof manifest.schemaVersion === "string" && /^1\./.test(manifest.schemaVersion), "Demo service manifest schema drift");
  const requestedManifest = credentialFreeUrl(manifestUrl, "Manifest URL");
  const publishedManifest = credentialFreeUrl(manifest.publishUrl, "Manifest publishUrl");
  const baseUrl = credentialFreeUrl(manifest.baseUrl, "Manifest baseUrl");
  invariant(publishedManifest.href === requestedManifest.href, "Manifest publishUrl does not bind to the requested document");
  invariant(baseUrl.origin === requestedManifest.origin, "Manifest baseUrl must stay on the manifest origin");
  invariant(Array.isArray(manifest.services) && manifest.services.length <= 1000, "Demo service manifest services are invalid");
  const matches = manifest.services.filter((service) => isPlainObject(service) && service.id === serviceId);
  invariant(matches.length === 1, `Demo service manifest must advertise exactly one ${serviceId} service`);
  const pmtiles = matches[0].protocols?.pmtiles;
  invariant(isPlainObject(pmtiles), `${serviceId} does not advertise PMTiles`);
  invariant(typeof pmtiles.path === "string" && pmtiles.path.startsWith("/"), "PMTiles manifest path must be root-relative");
  invariant(!pmtiles.path.includes("?") && !pmtiles.path.includes("#"), "PMTiles manifest path must not contain query or fragment data");
  const archiveUrl = credentialFreeUrl(new URL(pmtiles.path, baseUrl).href, "PMTiles archive URL");
  invariant(archiveUrl.origin === requestedManifest.origin, "PMTiles archive URL escaped the manifest origin");
  return Object.freeze({
    manifestUrl: requestedManifest.href,
    manifestFormat: manifest.format,
    manifestSchemaVersion: manifest.schemaVersion,
    serviceId,
    archiveId: typeof pmtiles.archiveId === "string" ? pmtiles.archiveId : null,
    archiveUrl: archiveUrl.href,
  });
}

async function fetchManifest(fetchFn, manifestUrl, signal) {
  const url = credentialFreeUrl(manifestUrl, "Manifest URL");
  const headers = new Headers({ accept: "application/json" });
  assertCredentialFreeHeaders(headers, "Manifest request");
  const response = await fetchFn(url, { headers, credentials: "omit", redirect: "error", signal });
  invariant(response.status === 200, `Demo service manifest returned HTTP ${response.status}`);
  invariant(response.headers.get("content-type")?.toLowerCase().includes("application/json"), "Demo service manifest is not JSON");
  const bytes = await readBoundedBody(response, MAX_MANIFEST_BYTES, signal);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Demo service manifest is not valid UTF-8 JSON");
  }
  return { manifest, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function parseRequestedRange(value) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value ?? "");
  invariant(match, "PMTiles SDK request did not use one explicit byte range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start, "PMTiles SDK range is invalid");
  invariant(end - start + 1 <= MAX_RANGE_BYTES, "PMTiles SDK range exceeded the canary ceiling");
  return { start, end, length: end - start + 1 };
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  invariant(match, "PMTiles response did not carry an exact Content-Range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  invariant([start, end, total].every(Number.isSafeInteger) && start >= 0 && end >= start && total > end, "PMTiles Content-Range is invalid");
  return { start, end, total };
}

function strongEtag(value) {
  return typeof value === "string" && !value.startsWith("W/") && /^"(?:[^"\\]|\\.)+"$/.test(value);
}

function sdkEvidence(sourceRevision) {
  let gitCommit = sourceRevision ?? process.env.HONUA_SAMPLE_SOURCE_REVISION ?? process.env.GITHUB_SHA;
  if (gitCommit === undefined) {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  }
  invariant(/^[a-f0-9]{40}$/.test(gitCommit), "PMTiles live evidence requires a full 40-character SDK revision");
  return Object.freeze({ package: SDK_PACKAGE.name, version: SDK_PACKAGE.version, gitCommit });
}

function skippedEvidence(observedAt, manifestUrl, reason, sdk) {
  return Object.freeze({
    format: "honua.sdk.pmtiles-direct-live-evidence.v1",
    schemaVersion: 1,
    status: "skipped",
    reason,
    observedAt,
    lane: "scheduled-only",
    authMode: "anonymous",
    sdk,
    manifest: { url: manifestUrl },
    scope: { directInspection: true, managedPublicationLifecycle: false },
    networkGates: NETWORK_GATES,
  });
}

export async function runPmtilesLiveEvidence(options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  const sdk = sdkEvidence(options.sourceRevision);
  const enabled = options.enabled ?? isPmtilesLiveEvidenceEnabled();
  if (!enabled) {
    return skippedEvidence(
      observedAt,
      manifestUrl,
      "Live PMTiles evidence is disabled outside its scheduled/manual lane.",
      sdk,
    );
  }

  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  const started = performance.now();
  let resolved;
  try {
    const fetched = await fetchManifest(fetchFn, manifestUrl, controller.signal);
    resolved = resolvePmtilesArchive(fetched.manifest, manifestUrl, options.serviceId ?? DEFAULT_SERVICE_ID);
    const requests = [];
    const archiveFetch = async (input, init = {}) => {
      invariant(requests.length < 2, "PMTiles inspection attempted more than two physical requests");
      const requestUrl = credentialFreeUrl(input.toString(), "PMTiles request URL");
      invariant(requestUrl.href === resolved.archiveUrl, "PMTiles inspection requested an unexpected URL");
      const headers = new Headers(init.headers);
      assertCredentialFreeHeaders(headers, "PMTiles request");
      const requested = parseRequestedRange(headers.get("range"));
      const response = await fetchFn(requestUrl, { ...init, credentials: "omit", redirect: "error", headers });
      invariant(response.status === 206, `PMTiles range returned HTTP ${response.status}`);
      invariant(response.headers.get("content-type")?.toLowerCase().startsWith("application/vnd.pmtiles"), "PMTiles range media type drift");
      const contentRange = parseContentRange(response.headers.get("content-range"));
      invariant(contentRange.start === requested.start && contentRange.end === requested.end, "PMTiles response range does not match its request");
      invariant(Number(response.headers.get("content-length")) === requested.length, "PMTiles response Content-Length drift");
      const etag = response.headers.get("etag");
      invariant(strongEtag(etag), "PMTiles range requires a strong ETag");
      requests.push(Object.freeze({ ...requested, total: contentRange.total, status: response.status, etag, credentialFree: true }));
      return response;
    };

    const { inspectPmtilesArchive } = await import("../dist/src/pmtiles/index.js");
    const inspection = await inspectPmtilesArchive({
      endpoint: resolved.archiveUrl,
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn: archiveFetch },
      limits: {
        maxRequests: 2,
        maxRangeBytes: MAX_RANGE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        maxDecompressedBytes: 4 * 1024 * 1024,
      },
      signal: controller.signal,
    });
    const metadata = inspection.metadata;
    const transfer = metadata.transfer;
    invariant(metadata.specVersion === 3, "Live PMTiles archive is not specification version 3");
    invariant(metadata.tileKind !== "unknown", "Live PMTiles archive has an unsupported tile kind");
    invariant(metadata.bounds.length === 4 && metadata.bounds.every(Number.isFinite), "Live PMTiles bounds are invalid");
    invariant(metadata.minZoom <= metadata.maxZoom, "Live PMTiles zoom bounds are invalid");
    invariant(transfer.requests === requests.length && transfer.requests > 0, "PMTiles request ledger drift");
    invariant(transfer.bytesFetched > 0 && transfer.bytesFetched <= MAX_TOTAL_BYTES, "PMTiles inspection byte total is unbounded");
    const totals = new Set(requests.map((request) => request.total));
    invariant(totals.size === 1, "PMTiles responses disagree on archive length");
    const archiveLength = requests[0].total;
    invariant(transfer.bytesFetched < archiveLength, "PMTiles inspection fetched the complete archive");
    invariant(transfer.ranges[0]?.offset === 0 && transfer.ranges[0]?.length === 16_384, "PMTiles inspection lost its exact header range");
    invariant(transfer.ranges.every((range) => range.status === 206 && range.bytesReceived === range.length), "PMTiles range ledger is not exact partial content");
    invariant(metadata.validator === `etag:${requests[0].etag}`, "PMTiles metadata validator drift");

    return Object.freeze({
      format: "honua.sdk.pmtiles-direct-live-evidence.v1",
      schemaVersion: 1,
      status: "executed",
      reason: null,
      observedAt,
      lane: "scheduled-only",
      authMode: "anonymous",
      sdk,
      timing: { totalMs: performance.now() - started },
      manifest: { url: resolved.manifestUrl, sha256: fetched.sha256, bytes: fetched.bytes, format: resolved.manifestFormat, schemaVersion: resolved.manifestSchemaVersion },
      service: { id: resolved.serviceId, archiveId: resolved.archiveId, archiveUrl: resolved.archiveUrl },
      inspection: {
        specVersion: metadata.specVersion,
        tileKind: metadata.tileKind,
        bounds: metadata.bounds,
        minZoom: metadata.minZoom,
        maxZoom: metadata.maxZoom,
        vectorLayerIds: metadata.vectorLayers.map((layer) => layer.id),
        validator: metadata.validator,
        archiveLength,
        transfer,
        requests,
      },
      assertions: [
        "manifest-resolved-public-pmtiles-service",
        "public-api-inspected-version-3-metadata",
        "all-archive-responses-are-exact-206-ranges",
        "strong-etag-binds-range-and-metadata-evidence",
        "inspection-did-not-fetch-complete-archive",
        "no-request-carried-credentials",
      ],
      scope: { directInspection: true, managedPublicationLifecycle: false },
    });
  } catch (error) {
    const message = error?.message ?? String(error);
    const evidence = Object.freeze({
      format: "honua.sdk.pmtiles-direct-live-evidence.v1",
      schemaVersion: 1,
      status: "failed",
      reason: message,
      observedAt,
      lane: "scheduled-only",
      authMode: "anonymous",
      sdk,
      timing: { totalMs: performance.now() - started },
      manifest: { url: manifestUrl },
      ...(resolved ? { service: { id: resolved.serviceId, archiveId: resolved.archiveId, archiveUrl: resolved.archiveUrl } } : {}),
      scope: { directInspection: true, managedPublicationLifecycle: false },
    });
    throw Object.assign(error instanceof Error ? error : new Error(message), { evidence });
  } finally {
    clearTimeout(timeout);
  }
}

function parseArguments(argv) {
  let output = DEFAULT_OUTPUT;
  let strict = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--strict") strict = true;
    else if (argv[index] === "--output") output = argv[++index];
    else throw new Error(`Unknown PMTiles live-evidence argument: ${argv[index]}`);
  }
  return { output, strict };
}

function writeEvidence(output, evidence) {
  const outputPath = path.resolve(PROJECT_ROOT, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function main() {
  const { output, strict } = parseArguments(process.argv.slice(2));
  try {
    const evidence = await runPmtilesLiveEvidence();
    writeEvidence(output, evidence);
    if (strict && evidence.status !== "executed") throw Object.assign(new Error(evidence.reason), { evidence });
    process.stdout.write(`${evidence.status}: ${output}\n`);
  } catch (error) {
    if (error?.evidence) writeEvidence(output, error.evidence);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`PMTiles live evidence failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
