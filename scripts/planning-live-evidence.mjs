#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCER_PATH = "scripts/planning-live-evidence.mjs";
const DEFAULT_OUTPUT = "test-results/planning-live-evidence.json";
const NOMINATIM_ORIGIN = "https://nominatim.openstreetmap.org";
const HAWAII_ARCGIS_ORIGIN = "https://geodata.hawaii.gov";
const HAWAII_ARCGIS_BASE_URL = `${HAWAII_ARCGIS_ORIGIN}/arcgis`;
const HAWAII_ZONING_ENDPOINT = `${HAWAII_ARCGIS_BASE_URL}/rest/services/ParcelsZoning/MapServer/3`;
const HAWAII_ZONING_PATH = "/arcgis/rest/services/ParcelsZoning/MapServer/3";
const SEARCH_TEXT = "Honolulu Hale, Honolulu";
const USER_AGENT = "honua-sdk-js-planning-evidence/0.1 (+https://github.com/honua-io/honua-sdk-js; mike@honua.io)";
const SERVICE_ID = "ParcelsZoning";
const LAYER_ID = 3;
const NETWORK_GATES = ["HONUA_PLANNING_LIVE_ENABLED", "HONUA_SAMPLE_LIVE_ENABLED"];
const DEFAULT_LIMITS = Object.freeze({
  maxRequests: 3,
  maxResponseBytes: 512 * 1024,
  maxTotalBytes: 1024 * 1024,
  requestTimeoutMs: 8_000,
  overallTimeoutMs: 25_000,
});
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_QUERY_PATTERN = /(?:^|_)(?:access_key|access_token|api_key|apikey|auth_token|authorization|client_secret|credential|key|password|private_key|refresh_token|sas|secret|sig|signature|subscription_key|token)(?:_|$)/u;

export const PLANNING_LIVE_PRODUCER_ARTIFACT = Object.freeze({
  kind: "producer-generator",
  path: PRODUCER_PATH,
  sha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeCredentialName(value) {
  return value
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function hasCredentialQuery(url) {
  return [...url.searchParams.keys()].some((name) => CREDENTIAL_QUERY_PATTERN.test(normalizeCredentialName(name)));
}

function isCredentialHeader(name) {
  const normalized = normalizeCredentialName(name);
  return (
    normalized === "cookie" ||
    normalized.endsWith("_cookie") ||
    CREDENTIAL_QUERY_PATTERN.test(normalized)
  );
}

function assertFixedPublicRequest(url, method) {
  invariant(url.protocol === "https:", "Planning live evidence permits HTTPS requests only.");
  invariant(!url.username && !url.password && !url.hash, "Planning live evidence rejects URL credentials and fragments.");
  invariant(!hasCredentialQuery(url), "Planning live evidence rejects credential-bearing query parameters.");
  invariant(method === "GET", "Planning live evidence permits read-only GET requests only.");

  if (url.origin === NOMINATIM_ORIGIN) {
    invariant(url.pathname === "/search", "Planning live evidence permits only the fixed Nominatim search path.");
    const allowed = new Set(["countrycodes", "format", "limit", "q"]);
    invariant([...url.searchParams.keys()].every((name) => allowed.has(name)), "Nominatim request contains an unreviewed parameter.");
    invariant(url.searchParams.get("q") === SEARCH_TEXT, "Nominatim request text drifted from the reviewed address.");
    invariant(url.searchParams.get("format") === "jsonv2", "Nominatim response format must remain jsonv2.");
    invariant(url.searchParams.get("limit") === "1", "Nominatim result count must remain capped at one.");
    invariant(url.searchParams.get("countrycodes") === "us", "Nominatim search must remain country-bounded.");
    return "nominatim-geocode";
  }

  invariant(url.origin === HAWAII_ARCGIS_ORIGIN, "Planning live evidence rejected an unreviewed public host.");
  invariant(
    url.pathname === HAWAII_ZONING_PATH || url.pathname === `${HAWAII_ZONING_PATH}/query`,
    "Planning live evidence permits only the reviewed Hawaii zoning layer.",
  );
  if (url.pathname === HAWAII_ZONING_PATH) {
    invariant(
      url.searchParams.size === 1 && url.searchParams.get("f") === "json",
      "Hawaii zoning metadata request drifted from its reviewed shape.",
    );
    return "hawaii-zoning-metadata";
  }

  const allowed = new Set([
    "f",
    "geometry",
    "geometryType",
    "outFields",
    "resultRecordCount",
    "returnGeometry",
    "spatialRel",
    "where",
  ]);
  invariant([...url.searchParams.keys()].every((name) => allowed.has(name)), "Hawaii zoning query contains an unreviewed parameter.");
  invariant(url.searchParams.get("f") === "json", "Hawaii zoning query must request JSON.");
  invariant(url.searchParams.get("where") === "1=1", "Hawaii zoning query predicate drifted.");
  invariant(url.searchParams.get("returnGeometry") === "false", "Hawaii zoning live evidence must not transfer polygons.");
  invariant(url.searchParams.get("resultRecordCount") === "3", "Hawaii zoning result count must remain capped at three.");
  invariant(url.searchParams.get("geometryType") === "esriGeometryPoint", "Hawaii zoning query must remain point-bounded.");
  invariant(
    url.searchParams.get("spatialRel") === "esriSpatialRelIntersects",
    "Hawaii zoning query must remain an intersection check.",
  );
  const outFields = url.searchParams.get("outFields")?.split(",") ?? [];
  invariant(
    JSON.stringify(outFields) === JSON.stringify(["objectid", "zone_class", "zoning_des", "zoning_lab", "loaddate"]),
    "Hawaii zoning field projection drifted.",
  );
  let geometry;
  try {
    geometry = JSON.parse(url.searchParams.get("geometry") ?? "null");
  } catch {
    throw new Error("Hawaii zoning query geometry is not valid JSON.");
  }
  invariant(
    Number.isFinite(geometry?.x) &&
      geometry.x >= -161 &&
      geometry.x <= -154 &&
      Number.isFinite(geometry?.y) &&
      geometry.y >= 18 &&
      geometry.y <= 23 &&
      geometry?.spatialReference?.wkid === 4326,
    "Hawaii zoning point escaped the reviewed geographic and CRS bounds.",
  );
  return "hawaii-zoning-query";
}

function composedSignal(signals, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const listeners = [];
  const abort = (signal) => controller.abort(signal.reason);
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) abort(signal);
    else {
      const listener = () => abort(signal);
      signal.addEventListener("abort", listener, { once: true });
      listeners.push([signal, listener]);
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Planning live request exceeded ${timeoutMs} ms.`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

async function readBoundedBody(response, maxBytes, signal) {
  invariant(response.body, "Planning live response has no readable body.");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      invariant(!signal.aborted, "Planning live response read was aborted.");
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel(`response exceeded ${maxBytes} bytes`).catch(() => undefined);
        throw new Error(`Planning live response exceeded its ${maxBytes}-byte ceiling.`);
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function createPlanningBoundedFetch(options = {}) {
  const fetchFn = (options.fetchFn ?? fetch).bind(globalThis);
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  invariant(Number.isSafeInteger(limits.maxRequests) && limits.maxRequests > 0, "Planning request cap is invalid.");
  invariant(Number.isSafeInteger(limits.maxResponseBytes) && limits.maxResponseBytes > 0, "Planning response cap is invalid.");
  invariant(Number.isSafeInteger(limits.maxTotalBytes) && limits.maxTotalBytes >= limits.maxResponseBytes, "Planning total byte cap is invalid.");
  invariant(Number.isSafeInteger(limits.requestTimeoutMs) && limits.requestTimeoutMs > 0, "Planning timeout is invalid.");
  const requests = [];
  let totalBytes = 0;

  const boundedFetch = async (input, init = {}) => {
    invariant(requests.length < limits.maxRequests, `Planning live evidence exceeded its ${limits.maxRequests}-request ceiling.`);
    const inputRequest = input instanceof Request ? input : undefined;
    const url = new URL(inputRequest?.url ?? String(input));
    const method = String(init.method ?? inputRequest?.method ?? "GET").toUpperCase();
    const operation = assertFixedPublicRequest(url, method);
    const headers = new Headers(init.headers ?? inputRequest?.headers);
    for (const name of headers.keys()) {
      invariant(!isCredentialHeader(name), `Planning live evidence rejected credential header ${name}.`);
    }
    const requestSignal = init.signal ?? inputRequest?.signal;
    const composed = composedSignal([requestSignal, options.signal], limits.requestTimeoutMs);
    const started = performance.now();
    try {
      const response = await fetchFn(url.href, {
        ...init,
        body: undefined,
        cache: "no-store",
        credentials: "omit",
        headers,
        method,
        redirect: "manual",
        signal: composed.signal,
      });
      if (
        response.type === "opaqueredirect" ||
        response.redirected ||
        REDIRECT_STATUSES.has(response.status) ||
        (response.url && new URL(response.url).href !== url.href)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("Planning live evidence refuses all redirects.");
      }
      const contentLength = Number(response.headers.get("content-length"));
      invariant(
        !Number.isFinite(contentLength) || contentLength <= limits.maxResponseBytes,
        `Planning live response declared more than ${limits.maxResponseBytes} bytes.`,
      );
      const body = await readBoundedBody(response, limits.maxResponseBytes, composed.signal);
      totalBytes += body.byteLength;
      invariant(totalBytes <= limits.maxTotalBytes, `Planning live evidence exceeded its ${limits.maxTotalBytes}-byte aggregate ceiling.`);
      requests.push({ operation, status: response.status, bytes: body.byteLength, durationMs: performance.now() - started });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(body, { headers: responseHeaders, status: response.status, statusText: response.statusText });
    } catch (error) {
      if (composed.timedOut()) throw new Error(`Planning live request exceeded ${limits.requestTimeoutMs} ms.`, { cause: error });
      throw error;
    } finally {
      composed.dispose();
    }
  };

  return {
    fetch: boundedFetch,
    limits: Object.freeze({ ...limits }),
    snapshot() {
      return { requests: requests.map((request) => ({ ...request })), totalBytes };
    },
  };
}

export function isPlanningLiveEvidenceEnabled(env = process.env) {
  return NETWORK_GATES.some((name) => /^(?:1|true)$/iu.test(env[name] ?? ""));
}

function gitCommit(supplied) {
  if (/^[a-f0-9]{40}$/u.test(supplied ?? "")) return supplied;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function checkedPackedEntrypoint(sdkDir, subpath) {
  invariant(typeof sdkDir === "string" && path.isAbsolute(sdkDir), "Packed planning evidence requires an absolute SDK directory.");
  const resolvedRoot = await realpath(sdkDir);
  invariant(resolvedRoot === path.resolve(sdkDir), "Packed SDK directory must be canonical and may not be a symlink.");
  const packageJson = JSON.parse(await readFile(path.join(resolvedRoot, "package.json"), "utf8"));
  invariant(packageJson.name === "@honua/sdk-js", "Packed planning evidence received the wrong package.");
  const exportTarget = packageJson.exports?.[`./${subpath}`]?.default;
  invariant(typeof exportTarget === "string" && exportTarget.startsWith("./dist/"), `Packed SDK ${subpath} export is invalid.`);
  const target = path.resolve(resolvedRoot, exportTarget);
  invariant(target.startsWith(`${resolvedRoot}${path.sep}`), `Packed SDK ${subpath} export escaped its package.`);
  const targetRealpath = await realpath(target);
  invariant(targetRealpath === target && (await lstat(target)).isFile(), `Packed SDK ${subpath} export is not a canonical file.`);
  return pathToFileURL(target).href;
}

export async function loadPlanningSdk(options = {}) {
  const mode = options.mode ?? process.env.HONUA_SAMPLE_SDK_MODE ?? "source";
  invariant(mode === "source" || mode === "packed", `Unsupported planning evidence SDK mode: ${mode}`);
  const entrypoints =
    mode === "packed"
      ? {
          geocoding: await checkedPackedEntrypoint(options.sdkDir ?? process.env.HONUA_SAMPLE_SDK_DIR, "geocoding"),
          honua: await checkedPackedEntrypoint(options.sdkDir ?? process.env.HONUA_SAMPLE_SDK_DIR, "honua"),
        }
      : {
          geocoding: new URL("../dist/src/geocoding/index.js", import.meta.url).href,
          honua: new URL("../dist/src/honua.js", import.meta.url).href,
        };
  const [geocoding, honua] = await Promise.all([import(entrypoints.geocoding), import(entrypoints.honua)]);
  invariant(typeof geocoding.nominatimGeocodingProvider === "function", "SDK geocoding entrypoint is missing Nominatim.");
  invariant(typeof honua.HonuaClient === "function", "SDK honua entrypoint is missing HonuaClient.");
  return { HonuaClient: honua.HonuaClient, nominatimGeocodingProvider: geocoding.nominatimGeocodingProvider, mode };
}

function baseEvidence({ observedAt, packageJson, revision, status, reason }) {
  return {
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "planning-permitting-workbench",
    lane: "live",
    status,
    reason,
    observedAt,
    authMode: "anonymous",
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: revision },
    source: {
      provider: "OpenStreetMap Nominatim and Hawaii Statewide GIS",
      identity: "honolulu-hale:ParcelsZoning:MapServer:3",
      endpoint: HAWAII_ZONING_ENDPOINT,
      deploymentVersion: null,
      dataVersion: null,
    },
  };
}

function skippedEvidence(context) {
  return validateEvidenceEnvelope({
    ...baseEvidence({
      ...context,
      status: "skipped",
      reason: "Planning public-live evidence is disabled outside its scheduled/manual network lane.",
    }),
    provenance: null,
    semantics: { operation: "public-address-to-zoning-read-check", outcome: null, itemCount: null, assertions: [] },
    timing: { totalMs: null, firstSuccessfulInteractionMs: null },
    degradation: { state: "unavailable", reasons: ["live-network-gate-disabled"] },
    artifacts: [],
  });
}

function failedEvidence(context, reason, totalMs) {
  return validateEvidenceEnvelope({
    ...baseEvidence({ ...context, status: "failed", reason }),
    provenance: null,
    semantics: { operation: "public-address-to-zoning-read-check", outcome: null, itemCount: null, assertions: [] },
    timing: { totalMs, firstSuccessfulInteractionMs: null },
    degradation: { state: "unexpected", reasons: ["public-read-probe-failed"] },
    artifacts: [PLANNING_LIVE_PRODUCER_ARTIFACT],
  });
}

export async function runPlanningLiveEvidence(options = {}) {
  const packageJson = options.packageJson ?? JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const observedAt = options.observedAt ?? new Date().toISOString();
  const revision = gitCommit(options.sourceRevision ?? process.env.HONUA_SAMPLE_SOURCE_REVISION);
  const context = { observedAt, packageJson, revision };
  const enabled = options.enabled ?? isPlanningLiveEvidenceEnabled();
  if (!enabled) return skippedEvidence(context);
  invariant(/^[a-f0-9]{40}$/u.test(revision ?? ""), "Executed planning evidence requires a full source revision.");

  const overallController = new AbortController();
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  invariant(
    Number.isSafeInteger(limits.overallTimeoutMs) && limits.overallTimeoutMs > 0,
    "Planning overall timeout is invalid.",
  );
  const overallTimer = setTimeout(
    () => overallController.abort(new Error(`Planning live evidence exceeded ${limits.overallTimeoutMs} ms.`)),
    limits.overallTimeoutMs,
  );
  const started = performance.now();
  try {
    const sdk = options.sdk ?? (await loadPlanningSdk(options));
    const transport = createPlanningBoundedFetch({ fetchFn: options.fetchFn, limits, signal: overallController.signal });
    const geocoder = sdk.nominatimGeocodingProvider({
      baseUrl: NOMINATIM_ORIGIN,
      fetchFn: transport.fetch,
      timeoutMs: limits.requestTimeoutMs,
      userAgent: USER_AGENT,
    });
    const matches = await geocoder.geocode(SEARCH_TEXT, { countryCodes: "us", limit: 1 });
    const firstInteractionMs = performance.now() - started;
    const match = matches[0];
    invariant(matches.length === 1, "The reviewed Nominatim search must return exactly one candidate.");
    invariant(
      Number.isFinite(match?.longitude) &&
        match.longitude >= -161 &&
        match.longitude <= -154 &&
        Number.isFinite(match?.latitude) &&
        match.latitude >= 18 &&
        match.latitude <= 23,
      "The reviewed address no longer resolves inside Hawaii.",
    );

    const client = new sdk.HonuaClient({
      baseUrl: HAWAII_ARCGIS_BASE_URL,
      fetchFn: transport.fetch,
      timeoutMs: limits.requestTimeoutMs,
    });
    const metadata = await client.getMapLayerMetadata(SERVICE_ID, LAYER_ID, { signal: overallController.signal });
    invariant(metadata.type === "Feature Layer", "The reviewed Hawaii zoning source is no longer a feature layer.");
    const capabilities = new Set(String(metadata.capabilities ?? "").split(","));
    invariant(capabilities.has("Query"), "The reviewed Hawaii zoning source no longer advertises query.");
    invariant(!capabilities.has("Create") && !capabilities.has("Update") && !capabilities.has("Delete"), "The live evidence source unexpectedly advertises mutation.");
    const fieldNames = new Set((metadata.fields ?? []).map((field) => field.name));
    for (const required of ["objectid", "zone_class", "zoning_des", "zoning_lab", "loaddate"]) {
      invariant(fieldNames.has(required), `The reviewed Hawaii zoning source lost field ${required}.`);
    }

    const query = await client.queryMapLayer({
      serviceId: SERVICE_ID,
      layerId: LAYER_ID,
      where: "1=1",
      outFields: ["objectid", "zone_class", "zoning_des", "zoning_lab", "loaddate"],
      geometry: { x: match.longitude, y: match.latitude, spatialReference: { wkid: 4326 } },
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      resultRecordCount: 3,
      returnGeometry: false,
      signal: overallController.signal,
    });
    invariant(query.features.length > 0 && query.features.length <= 3, "The bounded zoning point query returned no usable result.");
    const zoning = query.features[0]?.attributes;
    invariant(typeof zoning?.zone_class === "string" && zoning.zone_class.length > 0, "The zoning result has no zone class.");
    invariant(typeof zoning?.zoning_des === "string" && zoning.zoning_des.length > 0, "The zoning result has no description.");

    const traffic = transport.snapshot();
    invariant(traffic.requests.length === 3, "Planning live evidence must perform exactly three reviewed requests.");
    invariant(
      JSON.stringify(traffic.requests.map((request) => request.operation)) ===
        JSON.stringify(["nominatim-geocode", "hawaii-zoning-metadata", "hawaii-zoning-query"]),
      "Planning live request ordering or scope drifted.",
    );
    invariant(traffic.requests.every((request) => request.status >= 200 && request.status < 300), "Planning live request ledger contains a failed response.");
    const totalMs = performance.now() - started;
    const validAt = Number.isFinite(Number(zoning.loaddate)) ? new Date(Number(zoning.loaddate)).toISOString() : null;
    return validateEvidenceEnvelope({
      ...baseEvidence({ ...context, status: "executed", reason: null }),
      source: {
        ...baseEvidence({ ...context, status: "executed", reason: null }).source,
        deploymentVersion: metadata.currentVersion === undefined ? null : String(metadata.currentVersion),
        dataVersion: validAt,
      },
      provenance: {
        sourceId: "nominatim:honolulu-hale+hawaii-gis:ParcelsZoning:3",
        observedAt,
        validAt,
        state: "live",
        attribution: `${match.provenance.attribution}; ${metadata.copyrightText ?? "City and County of Honolulu; Hawaii Statewide GIS Program"}`,
      },
      semantics: {
        operation: "public-address-to-zoning-read-check",
        outcome: "address-resolved-and-bounded-zoning-context-returned",
        itemCount: query.features.length,
        assertions: [
          "nominatim-requests=1",
          "hawaii-zoning-metadata-query-only",
          "point-intersection-result-limit=3",
          `observed-requests=${traffic.requests.length}/${transport.limits.maxRequests}`,
          `observed-response-bytes=${traffic.totalBytes}/${transport.limits.maxTotalBytes}`,
          "credentials-sent=false",
          "redirects-followed=0",
          `sdk-mode=${sdk.mode ?? options.mode ?? "source"}`,
          "edits-attachments-conflicts-not-executed",
        ],
      },
      timing: { totalMs, firstSuccessfulInteractionMs: firstInteractionMs },
      degradation: {
        state: "expected",
        reasons: [
          "public-live-slice-is-read-only",
          "edit-attachment-conflict-and-rollback-remain-fixture-only",
          "live-result-is-context-not-a-regulatory-determination",
        ],
      },
      artifacts: [PLANNING_LIVE_PRODUCER_ARTIFACT],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const evidence = failedEvidence(context, reason, performance.now() - started);
    throw Object.assign(error instanceof Error ? error : new Error(reason), { evidence });
  } finally {
    clearTimeout(overallTimer);
  }
}

function parseArguments(argv) {
  const options = { output: DEFAULT_OUTPUT, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = argv[++index] ?? "";
    else if (argument === "--strict") options.strict = true;
    else throw new Error(`Unknown planning live-evidence argument: ${argument}`);
  }
  invariant(options.output.length > 0, "Planning live-evidence output must not be empty.");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let evidence;
  let failure;
  try {
    evidence = await runPlanningLiveEvidence();
    if (options.strict && evidence.status !== "executed") {
      failure = new Error(evidence.reason ?? "Planning live evidence did not execute.");
    }
  } catch (error) {
    evidence = error?.evidence;
    failure = error;
  }
  invariant(evidence, "Planning live evidence did not produce an envelope.");
  const output = path.resolve(PROJECT_ROOT, process.env.HONUA_SAMPLE_LIVE_OUTPUT ?? options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`Planning live evidence: ${evidence.status}; ${output}\n`);
  if (failure) throw failure;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Planning live evidence failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
