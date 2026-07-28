#!/usr/bin/env node
/**
 * Retained fixture and scheduled-live evidence producer for issue #818.
 *
 * Fixture mode executes the complete versioned corpus through the installed
 * `@honua/sdk-js/realtime` entrypoint. Live mode first probes honua-server's
 * advertised transports, then executes only those transports and records
 * `unsupported`, `degraded`, and `failed` separately from `executed`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_PATH = "test/fixtures/realtime/cross-transport-conformance.v1.json";
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const evidenceAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(evidenceAjv);
const validateEvidenceSchema = evidenceAjv.compile(
  JSON.parse(readProjectBytes("schemas/realtime-conformance-evidence.v1.json").toString("utf8")),
);

export const REALTIME_CONFORMANCE_EVIDENCE_FORMAT = "honua.sdk.realtime-conformance-evidence.v1";
export const REALTIME_CONFORMANCE_EVIDENCE_SCHEMA = "schemas/realtime-conformance-evidence.v1.json";
export const REALTIME_LIVE_ENABLE_ENV = "HONUA_REALTIME_LIVE_CONFORMANCE_ENABLED";
export const REALTIME_TRANSPORTS = Object.freeze(["sse", "websocket", "odata"]);
export const REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES = 1_048_576;
export const REALTIME_SSE_EVENT_MAX_BYTES = 262_144;
export const REALTIME_SSE_BUFFER_MAX_BYTES = 262_144;
export const REALTIME_LIVE_SEMANTIC_LIMITS = Object.freeze({
  maxEvents: 64,
  maxFeaturesPerEvent: 10_000,
  maxRecords: 10_000,
  maxDepth: 16,
  maxNodes: 500_000,
  maxObjectKeys: 512,
  maxArrayItems: 100_000,
  maxStringBytes: 65_536,
  maxGeometryPositions: 25_000,
  maxHistoryBytes: 16_777_216,
});

const DEFAULT_LIVE_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const IMMUTABLE_SERVER_REVISION = /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/u;

class LiveDegradedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveDegradedError";
    this.code = code;
  }
}

class LiveSemanticError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveSemanticError";
    this.code = code;
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readProjectBytes(relativePath, projectRoot = PROJECT_ROOT) {
  return fs.readFileSync(path.join(projectRoot, relativePath));
}

function packageIdentity(projectRoot = PROJECT_ROOT) {
  const packageJson = JSON.parse(readProjectBytes("package.json", projectRoot).toString("utf8"));
  return { package: packageJson.name, version: packageJson.version };
}

export function realtimeSourceRevision(env = process.env, projectRoot = PROJECT_ROOT) {
  const supplied = env.HONUA_SAMPLE_SOURCE_REVISION ?? env.GITHUB_SHA;
  if (/^[a-f0-9]{40}$/u.test(supplied ?? "")) return supplied;
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
    if (/^[a-f0-9]{40}$/u.test(revision)) return revision;
  } catch {
    // The caller receives a precise revision error below.
  }
  throw new Error("Realtime conformance evidence requires a full 40-character SDK revision.");
}

export function isRealtimeLiveEnabled(env = process.env) {
  return /^(?:1|true)$/iu.test(env[REALTIME_LIVE_ENABLE_ENV] ?? "");
}

export async function collectFixtureRealtimeConformanceEvidence(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const corpusBytes = options.corpusBytes ?? readProjectBytes(CORPUS_PATH, projectRoot);
  const corpus = options.corpus ?? JSON.parse(corpusBytes.toString("utf8"));
  const sdk = options.sdk ?? (await import("@honua/sdk-js/realtime"));
  const runMatrix =
    options.runMatrix ??
    (
      await import(
        new URL("../dist/test/helpers/realtime-cross-transport-matrix.js", import.meta.url).href
      )
    ).runRealtimeCrossTransportMatrix;
  const matrix = await runMatrix({ sdk, corpus });
  invariant(matrix.scenarioCount === corpus.scenarios.length, "Fixture evidence did not execute the full corpus.");
  invariant(matrix.transportCount === 3, "Fixture evidence did not execute all three transports.");
  invariant(
    matrix.persistedReplay?.sameScopeCompatible === true &&
      matrix.persistedReplay.cursorReplayed === true &&
      matrix.persistedReplay.watermarkReplayed === true &&
      matrix.persistedReplay.checkpointLoads >= 2 &&
      matrix.persistedReplay.connectionAttempts >= 2 &&
      matrix.persistedReplay.resumedSequence === corpus.positions.snapshot.sequence &&
      matrix.persistedReplay.acceptedSequence === corpus.positions.delta.sequence,
    "Fixture evidence did not prove same-scope persisted checkpoint replay.",
  );

  const transports = REALTIME_TRANSPORTS.map((id) => {
    const scenarios = matrix.scenarios.map((scenario) => {
      const result = scenario.transports.find((transport) => transport.transport === id);
      invariant(result?.result === "passed", `${id}/${scenario.id} did not pass fixture conformance.`);
      return { id: scenario.id, result: "passed" };
    });
    return {
      id,
      freshness: id === "odata" ? "poll" : "push",
      advertised: true,
      status: "executed",
      scenarioCounts: { total: scenarios.length, passed: scenarios.length, failed: 0 },
      scenarios,
      diagnostics: [],
    };
  });
  return validateRealtimeConformanceEvidence(
    assembleEvidence({
      lane: "fixture",
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      sdk: {
        ...packageIdentity(projectRoot),
        revision: options.sourceRevision ?? realtimeSourceRevision(options.env, projectRoot),
      },
      server: {
        version: "fixture-v1",
        revision: `sha256:${sha256(corpusBytes)}`,
        capabilities: { sse: true, websocket: true, odata: true },
      },
      corpusBytes,
      scenarioCount: matrix.scenarioCount,
      executionCount: matrix.executionCount,
      transports,
    }),
  );
}

export async function collectLiveRealtimeConformanceEvidence(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const env = options.env ?? process.env;
  const corpusBytes = options.corpusBytes ?? readProjectBytes(CORPUS_PATH, projectRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sdkIdentity = {
    ...packageIdentity(projectRoot),
    revision: options.sourceRevision ?? realtimeSourceRevision(env, projectRoot),
  };
  if (!(options.enabled ?? isRealtimeLiveEnabled(env))) {
    const transports = REALTIME_TRANSPORTS.map((id) =>
      nonExecutedTransport(id, false, "degraded", "live-lane-disabled", `${REALTIME_LIVE_ENABLE_ENV} is not true.`),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: {
          version: null,
          revision: null,
          capabilities: { sse: false, websocket: false, odata: false },
        },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
      }),
    );
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  invariant(typeof fetchFn === "function", "Live realtime conformance requires fetch.");
  const baseUrl = sanitizeBaseUrl(
    options.baseUrl ?? env.HONUA_REALTIME_LIVE_BASE_URL ?? env.HONUA_BENCH_LIVE_BASE_URL ?? "https://demo.honua.io",
  );
  const apiKey = options.apiKey ?? env.HONUA_REALTIME_LIVE_API_KEY ?? env.HONUA_BENCH_LIVE_API_KEY;
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS, "live timeout");
  const capabilitiesUrl = `${baseUrl}/api/v1/streaming/features/capabilities`;
  let capabilityResponse;
  try {
    capabilityResponse = await requestJson(capabilitiesUrl, fetchFn, headers, timeoutMs);
  } catch (error) {
    const unavailable = classifyCapabilityProbeFailure(error);
    const transports = REALTIME_TRANSPORTS.map((id) =>
      nonExecutedTransport(id, false, unavailable.status, unavailable.code, unavailable.message),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: {
          version: null,
          revision: null,
          capabilities: { sse: false, websocket: false, odata: false },
        },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
      }),
    );
  }

  let descriptors;
  try {
    descriptors = normalizeLiveCapabilities(capabilityResponse.body, baseUrl);
  } catch {
    const transports = REALTIME_TRANSPORTS.map((id) =>
      nonExecutedTransport(
        id,
        false,
        "failed",
        "capability-contract-invalid",
        "Realtime capability response failed contract validation.",
      ),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: {
          version: null,
          revision: null,
          capabilities: { sse: false, websocket: false, odata: false },
        },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
      }),
    );
  }
  const capabilities = Object.fromEntries(
    REALTIME_TRANSPORTS.map((id) => [id, descriptors[id].advertised]),
  );
  const configuredServerRevision = immutableServerRevisionOrNull(
    options.serverRevision ?? env.HONUA_REALTIME_LIVE_SERVER_REVISION,
  );
  const configuredServerVersion = textOrNull(
    options.serverVersion ?? env.HONUA_REALTIME_LIVE_SERVER_VERSION,
  );
  const probedIdentity =
    descriptors.serverRevision !== null && descriptors.serverVersion !== null
      ? { version: null, revision: null }
      : await probeServerIdentity(baseUrl, fetchFn, headers, timeoutMs);
  const observedServerRevision = descriptors.serverRevision ?? probedIdentity.revision;
  const serverRevision = observedServerRevision;
  const serverVersion = descriptors.serverVersion ?? probedIdentity.version ?? configuredServerVersion;
  if (
    configuredServerRevision !== null &&
    observedServerRevision !== null &&
    configuredServerRevision !== observedServerRevision
  ) {
    const transports = REALTIME_TRANSPORTS.map((id) =>
      descriptors[id].advertised
        ? nonExecutedTransport(
            id,
            true,
            "failed",
            "server-revision-mismatch",
            "Advertised realtime transport belongs to a different immutable server revision.",
          )
        : nonExecutedTransport(
            id,
            false,
            "unsupported",
            "transport-not-advertised",
            `honua-server did not advertise ${id}.`,
          ),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: { version: serverVersion, revision: observedServerRevision, capabilities },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
      }),
    );
  }
  if (
    serverRevision === null &&
    REALTIME_TRANSPORTS.some((id) => descriptors[id].advertised)
  ) {
    const transports = REALTIME_TRANSPORTS.map((id) =>
      descriptors[id].advertised
        ? nonExecutedTransport(
            id,
            true,
            "failed",
            "server-revision-missing",
            "Advertised realtime transport cannot be certified without an exact server revision.",
          )
        : nonExecutedTransport(
            id,
            false,
            "unsupported",
            "transport-not-advertised",
            `honua-server did not advertise ${id}.`,
          ),
    );
    return validateRealtimeConformanceEvidence(
      assembleEvidence({
        lane: "live",
        generatedAt,
        sdk: sdkIdentity,
        server: { version: serverVersion, revision: null, capabilities },
        corpusBytes,
        scenarioCount: 0,
        executionCount: 0,
        transports,
      }),
    );
  }
  const sdk = options.sdk ?? (await import("@honua/sdk-js/realtime"));
  const context = liveResumeContext(options.sourceId ?? env.HONUA_REALTIME_LIVE_SOURCE_ID ?? "maui-parcels");
  const request = {
    sourceId: context.sourceId,
    layerId: nonNegativeInteger(
      options.layerId ?? Number(env.HONUA_REALTIME_LIVE_LAYER_ID ?? "1"),
      "live layer id",
    ),
    mode: "snapshot-then-delta",
  };
  const executionOptions = {
    sdk,
    fetchFn,
    headers,
    timeoutMs,
    context,
    request,
    eventSourceFactory: options.eventSourceFactory,
    webSocketFactory: options.webSocketFactory,
  };
  const executions = [];
  for (const id of REALTIME_TRANSPORTS) {
    const descriptor = descriptors[id];
    if (!descriptor.advertised) {
      executions.push({
        transport: nonExecutedTransport(
          id,
          false,
          "unsupported",
          "transport-not-advertised",
          `honua-server did not advertise ${id}.`,
        ),
      });
      continue;
    }
    if (!descriptor.url) {
      executions.push({
        transport: nonExecutedTransport(
          id,
          true,
          "failed",
          "advertised-transport-missing-endpoint",
          `honua-server advertised ${id} without a usable endpoint.`,
        ),
      });
      continue;
    }
    executions.push(await executeAdvertisedTransport(id, descriptor, executionOptions));
  }
  const transports = reconcileExecutedTransportStates(executions);
  const attemptedScenarios = transports.flatMap((transport) => transport.scenarios);
  const executionCount = attemptedScenarios.length;
  const scenarioCount = new Set(attemptedScenarios.map((scenario) => scenario.id)).size;
  return validateRealtimeConformanceEvidence(
    assembleEvidence({
      lane: "live",
      generatedAt,
      sdk: sdkIdentity,
      server: {
        version: serverVersion,
        revision: serverRevision,
        capabilities,
      },
      corpusBytes,
      scenarioCount,
      executionCount,
      transports,
    }),
  );
}

async function probeServerIdentity(baseUrl, fetchFn, headers, timeoutMs) {
  try {
    const response = await requestJson(
      `${baseUrl}/api/v1/capabilities/manifest`,
      fetchFn,
      headers,
      timeoutMs,
    );
    const server = isRecord(response.body?.server) ? response.body.server : {};
    return {
      version: textOrNull(server.serverVersion ?? server.version),
      revision: immutableServerRevisionOrNull(
        server.serverRevision ?? server.gitRevision ?? server.commitSha ?? server.imageDigest ?? server.revision,
      ),
    };
  } catch {
    // Older deployments may not expose the public manifest. A null immutable
    // revision prevents advertised transports from being certified.
    return { version: null, revision: null };
  }
}

class HttpStatusError extends Error {
  constructor(status) {
    super(`HTTP ${String(status)}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

function classifyCapabilityProbeFailure(error) {
  if (error instanceof HttpStatusError) {
    if (error.status === 404 || error.status === 405) {
      return {
        status: "unsupported",
        code: "capability-endpoint-unavailable",
        message: "Realtime capability endpoint is not available on this server.",
      };
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return {
        status: "degraded",
        code: "capability-probe-degraded",
        message: "Realtime capability endpoint was temporarily unavailable.",
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        status: "failed",
        code: "capability-access-failed",
        message: "Realtime capability endpoint denied the conformance probe.",
      };
    }
    return {
      status: "failed",
      code: "capability-probe-http-failed",
      message: "Realtime capability endpoint rejected the conformance probe.",
    };
  }
  if (error instanceof LiveDegradedError) {
    return {
      status: "degraded",
      code: error.code,
      message: "Realtime capability probe was temporarily unavailable.",
    };
  }
  if (error instanceof LiveSemanticError) {
    return {
      status: "failed",
      code: error.code,
      message:
        error.code === "capability-json-invalid"
          ? "Realtime capability endpoint returned invalid JSON."
          : "Realtime capability response failed semantic validation.",
    };
  }
  return {
    status: "degraded",
    code: "capability-probe-degraded",
    message: "Realtime capability probe was unavailable because of a network failure.",
  };
}

async function requestJson(url, fetchFn, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("realtime capability timeout"), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new HttpStatusError(response.status);
    try {
      const text = await readBoundedResponseText(
        response,
        REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES,
        "capability-response-too-large",
        "Realtime capability response exceeded its byte ceiling.",
        controller.signal,
      );
      return { body: JSON.parse(text) };
    } catch (error) {
      if (error instanceof LiveSemanticError) throw error;
      throw new LiveSemanticError(
        "capability-json-invalid",
        "Realtime capability endpoint returned invalid JSON.",
      );
    }
  } catch (error) {
    if (controller.signal.aborted) throw new LiveDegradedError("capability-timeout", "Realtime capability probe timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(response, maxBytes, code, message, signal) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      await cancelReadableStream(response.body);
      throw new LiveSemanticError(code, message);
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  const abortReader = () => void cancelReader(reader);
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await cancelReader(reader);
        throw new LiveSemanticError(code, message);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

async function cancelReadableStream(stream) {
  if (!stream) return;
  try {
    await stream.cancel();
  } catch {
    // The semantic size failure remains the source of truth.
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // The semantic size failure remains the source of truth.
  }
}

function classifyLiveTransportFailure(error) {
  const externalCode =
    typeof error?.code === "string" &&
    ["cursor-expired", "delivery-failed", "resume-unsupported", "transport-gap"].includes(error.code)
      ? error.code
      : error?.sdkCode === "realtime.protocol.terminal"
        ? "invalid-event"
        : undefined;
  const code =
    error instanceof LiveDegradedError || error instanceof LiveSemanticError
      ? error.code
      : (externalCode ?? "live-semantic-failure");
  const degraded =
    error instanceof LiveDegradedError ||
    code === "transport-gap" ||
    code === "cursor-expired";
  return degraded
    ? {
        status: "degraded",
        code,
        message: "Advertised realtime transport was temporarily unavailable during observation.",
      }
    : {
        status: "failed",
        code,
        message: "Advertised realtime transport failed the live conformance contract.",
      };
}

export function normalizeLiveCapabilities(payload, baseUrl) {
  invariant(isRecord(payload), "Realtime capability response must be an object.");
  const body = isRecord(payload.data) ? payload.data : payload;
  invariant(!Array.isArray(body), "Realtime capability response must be an object.");
  invariant(
    !Object.hasOwn(body, "enabled") || typeof body.enabled === "boolean",
    "Realtime capability enabled must be boolean.",
  );
  invariant(
    !Object.hasOwn(body, "transports") || Array.isArray(body.transports),
    "Realtime capability transports must be an array.",
  );
  invariant(
    typeof body.enabled === "boolean" || Array.isArray(body.transports),
    "Realtime capability response must explicitly declare enabled or transports.",
  );
  const hasExplicitTransports = Array.isArray(body.transports);
  const entries = hasExplicitTransports ? body.transports : [];
  const descriptors = {
    sse: {
      // `enabled: true` is the legacy SSE-only shape. Once the server emits a
      // transport list, that list is the authority and omission means
      // unsupported even if the legacy flag remains true.
      advertised: !hasExplicitTransports && body.enabled === true,
      url: body.streamUrl ?? body.sseUrl ?? null,
      entityIdField: null,
      pollIntervalMs: null,
    },
    websocket: {
      advertised: false,
      url: body.webSocketUrl ?? body.websocketUrl ?? null,
      entityIdField: null,
      pollIntervalMs: null,
    },
    odata: {
      advertised: false,
      url: body.odataDeltaUrl ?? null,
      entityIdField: textOrNull(body.odataEntityIdField),
      pollIntervalMs: body.odataPollIntervalMs ?? null,
    },
  };
  for (const entry of entries) {
    invariant(
      typeof entry === "string" || (isRecord(entry) && !Array.isArray(entry)),
      "Realtime capability transport entries must be strings or objects.",
    );
    if (isRecord(entry) && !Array.isArray(entry)) {
      const identifier = entry.id ?? entry.kind ?? entry.transport;
      invariant(
        typeof identifier === "string" && identifier.trim().length > 0,
        "Realtime capability transport id must be a non-empty string.",
      );
      invariant(
        !Object.hasOwn(entry, "enabled") || typeof entry.enabled === "boolean",
        "Realtime capability transport enabled must be boolean.",
      );
      invariant(
        !Object.hasOwn(entry, "url") || (typeof entry.url === "string" && entry.url.length > 0),
        "Realtime capability transport URL must be a non-empty string.",
      );
    }
    const normalized =
      typeof entry === "string"
        ? {
            id: normalizeTransportId(entry),
            enabled: true,
            url: null,
            entityIdField: null,
            pollIntervalMs: null,
          }
        : isRecord(entry)
          ? {
              id: normalizeTransportId(entry.id ?? entry.kind ?? entry.transport),
              enabled: entry.enabled !== false,
              url: typeof entry.url === "string" ? entry.url : null,
              entityIdField: textOrNull(entry.entityIdField),
              pollIntervalMs: entry.pollIntervalMs ?? null,
            }
          : undefined;
    if (!normalized?.id || !normalized.enabled || body.enabled === false) continue;
    descriptors[normalized.id].advertised = true;
    if (normalized.url) descriptors[normalized.id].url = normalized.url;
    if (normalized.entityIdField) descriptors[normalized.id].entityIdField = normalized.entityIdField;
    if (normalized.pollIntervalMs !== null) {
      descriptors[normalized.id].pollIntervalMs = normalized.pollIntervalMs;
    }
  }
  if (descriptors.sse.advertised && !descriptors.sse.url) {
    descriptors.sse.url = `${baseUrl}/api/v1/streaming/features`;
  }
  if (descriptors.websocket.advertised && !descriptors.websocket.url) {
    const webSocketUrl = new URL(`${baseUrl}/api/v1/streaming/features`);
    webSocketUrl.protocol = webSocketUrl.protocol === "https:" ? "wss:" : "ws:";
    descriptors.websocket.url = webSocketUrl.toString();
  }
  for (const id of REALTIME_TRANSPORTS) {
    if (!descriptors[id].advertised) {
      descriptors[id].url = null;
      continue;
    }
    if (descriptors[id].url) descriptors[id].url = sanitizeTransportUrl(descriptors[id].url, baseUrl, id);
  }
  return {
    ...descriptors,
    serverVersion: textOrNull(body.serverVersion ?? body.version),
    serverRevision: immutableServerRevisionOrNull(
      body.serverRevision ?? body.gitRevision ?? body.commitSha ?? body.imageDigest ?? body.revision,
    ),
  };
}

function normalizeTransportId(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replaceAll("_", "-");
  if (normalized === "sse" || normalized === "server-sent-events") return "sse";
  if (normalized === "websocket" || normalized === "web-socket" || normalized === "ws") return "websocket";
  if (normalized === "odata" || normalized === "odata-delta" || normalized === "polling") return "odata";
  return undefined;
}

async function executeAdvertisedTransport(id, descriptor, options) {
  try {
    const observation =
      id === "sse"
        ? await executeLiveSse(descriptor.url, options)
        : id === "websocket"
          ? await executeLiveWebSocket(descriptor.url, options)
          : await executeLiveOdata(descriptor.url, descriptor, options);
    return {
      transport: {
        id,
        freshness: id === "odata" ? "poll" : "push",
        advertised: true,
        status: "executed",
        acceptedState: {
          eventCount: observation.acceptedEventCount,
          historySha256: observation.historySha256,
          finalStateSha256: observation.finalStateSha256,
        },
        scenarioCounts: { total: 1, passed: 1, failed: 0 },
        scenarios: [{ id: "snapshot-delta-contract", result: "passed" }],
        diagnostics: [
          {
            code: "contract-events-accepted",
            message: `${String(observation.acceptedEventCount)} snapshot-plus-mutation contract events accepted with normalized state-transition history ${observation.historySha256}, final state ${observation.finalStateSha256}, and redacted checkpoint telemetry.`,
            scenario: "snapshot-delta-contract",
          },
        ],
      },
    };
  } catch (error) {
    const failure = classifyLiveTransportFailure(error);
    return {
      transport: {
        id,
        freshness: id === "odata" ? "poll" : "push",
        advertised: true,
        status: failure.status,
        scenarioCounts: { total: 1, passed: 0, failed: 1 },
        scenarios: [{ id: "snapshot-delta-contract", result: "failed" }],
        diagnostics: [
          {
            code: failure.code,
            message: failure.message,
            scenario: "snapshot-delta-contract",
          },
        ],
      },
    };
  }
}

function reconcileExecutedTransportStates(executions) {
  const executed = executions.filter(({ transport }) => transport.status === "executed");
  if (
    executed.length <= 1 ||
    executed.every(
      ({ transport }) =>
        transport.acceptedState?.eventCount === executed[0]?.transport.acceptedState?.eventCount &&
        transport.acceptedState?.historySha256 === executed[0]?.transport.acceptedState?.historySha256 &&
        transport.acceptedState?.finalStateSha256 === executed[0]?.transport.acceptedState?.finalStateSha256,
    )
  ) {
    return executions.map(({ transport }) => transport);
  }
  return executions.map(({ transport }) =>
    transport.status === "executed"
      ? {
          ...transport,
          status: "failed",
          scenarioCounts: { total: 1, passed: 0, failed: 1 },
          scenarios: [{ id: "snapshot-delta-contract", result: "failed" }],
          diagnostics: [
            {
              code: "cross-transport-state-divergence",
              message:
                "Advertised realtime transports accepted different snapshot-plus-mutation histories or normalized final states.",
              scenario: "snapshot-delta-contract",
            },
          ],
        }
      : transport,
  );
}

async function executeLiveSse(url, options) {
  const eventSourceFactory =
    options.eventSourceFactory ??
    ((sourceUrl) => new FetchEventSource(sourceUrl, options.fetchFn, options.headers));
  return observeLiveTransport(
    (runtime) =>
      options.sdk.createResumableServerSentEventsTransport(
        {
          url,
          ...options.sdk.honuaServerRealtimePreset(),
          eventSourceFactory,
        },
        liveResumableOptions(options, runtime),
      ),
    options,
  );
}

async function executeLiveWebSocket(url, options) {
  let webSocketFactory = options.webSocketFactory;
  if (!webSocketFactory) {
    try {
      const ws = await import("ws");
      webSocketFactory = (socketUrl, protocols) =>
        new ws.WebSocket(socketUrl, protocols ?? [], { headers: options.headers });
    } catch {
      throw new LiveSemanticError(
        "websocket-client-unavailable",
        "The scheduled Node runtime could not load its evidence-only WebSocket client.",
      );
    }
  }
  return observeLiveTransport(
    (runtime) =>
      options.sdk.createResumableWebSocketTransport(
        {
          url,
          ...options.sdk.honuaServerRealtimePreset(),
          webSocketFactory,
        },
        liveResumableOptions(options, runtime),
      ),
    options,
  );
}

async function executeLiveOdata(url, descriptor, options) {
  const idField = descriptor.entityIdField ?? "Id";
  const fetchImpl = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(options.headers)) headers.set(name, value);
    return options.fetchFn(input, { ...init, headers, redirect: "error" });
  };
  const raw = options.sdk.createOdataDeltaTransport({
    url,
    pollIntervalMs: positiveInteger(descriptor.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "OData poll interval"),
    entityId(entity) {
      const id = entity?.[idField];
      if (typeof id !== "string" && typeof id !== "number") {
        throw new LiveSemanticError("odata-entity-id-missing", `OData delta entity is missing ${idField}.`);
      }
      return id;
    },
    toFeature(entity) {
      return entity;
    },
    fetchImpl,
  });
  return observeLiveTransport(
    (runtime) =>
      options.sdk.createResumableRealtimeTransport(raw, liveResumableOptions(options, runtime)),
    options,
  );
}

function liveResumableOptions(options, runtime) {
  return {
    context: options.context,
    reconnect: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 100 },
    checkpointStore: runtime.checkpointStore,
    onTelemetry: runtime.onTelemetry,
  };
}

async function observeLiveTransport(buildTransport, options) {
  const controller = new AbortController();
  const checkpointStore = createMemoryCheckpointStore();
  const telemetry = [];
  const accepted = [];
  const dataReady = deferred();
  let completed = 0;
  let terminalError;
  const checkDataReady = () => {
    if (
      hasSnapshotThenMutation(accepted) &&
      telemetry.some((event) => event.acceptedEventCount >= accepted.length && event.checkpoint)
    ) {
      dataReady.resolve();
    }
  };
  const transport = await buildTransport({
    checkpointStore: checkpointStore.store,
    onTelemetry: (event) => {
      telemetry.push(event);
      checkDataReady();
    },
  });
  const observer = {
    next(event) {
      if (isDataEvent(event)) accepted.push(event);
      checkDataReady();
    },
    error(error) {
      terminalError = error;
      dataReady.reject(error);
    },
    complete() {
      completed += 1;
      if (!hasSnapshotThenMutation(accepted)) {
        dataReady.reject(
          new LiveSemanticError(
            "transport-completed-before-history",
            "Live transport completed before snapshot-plus-delta history was accepted.",
          ),
        );
      }
    },
  };
  const handle = transport.subscribe({ ...options.request, signal: controller.signal }, observer);
  try {
    try {
      await withTimeout(
        dataReady.promise,
        options.timeoutMs,
        "No snapshot-plus-delta contract history was observed within the bounded live window.",
      );
    } catch (error) {
      if (accepted.length === 0 && isLiveAvailabilityFailure(error)) {
        if (error instanceof LiveDegradedError) throw error;
        throw new LiveDegradedError(
          "transport-unavailable",
          "Advertised realtime transport was unavailable during the bounded observation.",
        );
      }
      if (!hasSnapshotThenMutation(accepted) && isContractHistoryMissing(error)) {
        throw new LiveSemanticError(
          "contract-history-missing",
          "The advertised transport produced no accepted snapshot-plus-delta history within the bounded observation.",
        );
      }
      throw error;
    }
  } finally {
    controller.abort("live evidence complete");
    handle.close();
    handle.close();
    await Promise.resolve();
  }
  if (terminalError) throw terminalError;
  if (completed !== 1) {
    throw new LiveSemanticError(
      "terminal-disposal-drift",
      `Repeated live disposal completed the observer ${String(completed)} times instead of once.`,
    );
  }
  const checkpoint = checkpointStore.checkpoints.at(-1);
  const checkpointSamples = telemetry.flatMap((event) => (event.checkpoint ? [event.checkpoint] : []));
  if (!checkpoint || checkpointSamples.length === 0) {
    throw new LiveSemanticError("checkpoint-evidence-missing", "Live transport produced no durable/redacted checkpoint evidence.");
  }
  assertCheckpointTelemetryRedacted(checkpointStore.checkpoints, checkpointSamples);
  const normalizedHistory = verifyNormalizedLiveHistory(options.sdk, accepted);
  return {
    acceptedEventCount: accepted.length,
    ...normalizedHistory,
  };
}

function assertCheckpointTelemetryRedacted(checkpoints, checkpointSamples) {
  for (const sample of checkpointSamples) {
    const checkpoint = checkpoints.find(
      (candidate) =>
        candidate.savedAt === sample.savedAt &&
        candidate.resume.sequence === sample.resume?.sequence,
    );
    if (!checkpoint) {
      throw new LiveSemanticError(
        "checkpoint-telemetry-leak",
        "Live checkpoint telemetry could not be bound to a durable checkpoint.",
      );
    }
    for (const field of ["cursor", "watermark", "deltaToken"]) {
      const raw = checkpoint.resume[field];
      const redacted = sample.resume?.[field];
      if (raw === undefined) {
        if (redacted !== undefined) {
          throw new LiveSemanticError(
            "checkpoint-telemetry-leak",
            "Live checkpoint telemetry invented a redacted resume position.",
          );
        }
        continue;
      }
      if (typeof raw !== "string") {
        throw new LiveSemanticError(
          "checkpoint-telemetry-leak",
          "Live durable checkpoint retained an invalid resume-position type.",
        );
      }
      const expected = `sha256:${sha256(`honua-realtime-checkpoint-redaction:v1:${field}:${raw}`)}`;
      if (redacted !== expected) {
        throw new LiveSemanticError(
          "checkpoint-telemetry-leak",
          "Live checkpoint telemetry retained an invalidly hashed or raw resume position.",
        );
      }
    }
  }
}

function isLiveAvailabilityFailure(error) {
  if (error instanceof LiveDegradedError) return true;
  if (error?.code === "transport-gap" || error?.code === "cursor-expired") return true;
  return (
    error?.code === "delivery-failed" &&
    /reconnect attempts exhausted.*(?:closed unexpectedly|transport gap)/iu.test(errorMessage(error))
  );
}

function isContractHistoryMissing(error) {
  if (error instanceof LiveDegradedError) return true;
  if (error instanceof LiveSemanticError && error.code === "transport-completed-before-history") return true;
  return (
    error?.code === "delivery-failed" &&
    /snapshot-required|replacement snapshot|snapshot baseline|reconnect attempts exhausted.*closed unexpectedly/i.test(
      errorMessage(error),
    )
  );
}

function createMemoryCheckpointStore() {
  const checkpoints = [];
  return {
    checkpoints,
    store: {
      load: () => Promise.resolve(undefined),
      save(checkpoint) {
        checkpoints.push(checkpoint);
        return Promise.resolve();
      },
    },
  };
}

function liveResumeContext(sourceId) {
  return {
    kind: "honua.realtime-resume-context",
    version: 1,
    sourceId,
    queryFingerprint: "sha256:scheduled-live-realtime-conformance-v1",
    sourceVersion: "scheduled-live",
    schemaVersion: "scheduled-live-v1",
    authorizationScopeFingerprint: "sha256:scheduled-live-observer",
  };
}

function createRawSseEventByteTracker() {
  // Count the bytes as received, before TextDecoder or newline normalization.
  // The event delimiter is not part of the event body, while line endings
  // between non-empty lines are. A line ending remains pending until the next
  // byte proves whether it is an interior line ending or the start of the
  // blank-line delimiter.
  let eventBytes = 0;
  let lineHasBytes = false;
  let pendingLineEndingBytes = 0;
  let pendingCarriageReturn = false;

  const addEventBytes = (count) => {
    eventBytes += count;
    if (eventBytes > REALTIME_SSE_EVENT_MAX_BYTES) {
      throw new LiveSemanticError(
        "sse-event-too-large",
        "Advertised SSE endpoint emitted an event beyond its byte ceiling.",
      );
    }
    if (eventBytes > REALTIME_SSE_BUFFER_MAX_BYTES) {
      throw new LiveSemanticError(
        "sse-buffer-too-large",
        "Advertised SSE endpoint exceeded its pending-event buffer ceiling.",
      );
    }
  };

  const consumeContentByte = () => {
    if (pendingLineEndingBytes > 0) {
      addEventBytes(pendingLineEndingBytes);
      pendingLineEndingBytes = 0;
    }
    addEventBytes(1);
    lineHasBytes = true;
  };

  const consumeLineEnding = (byteLength) => {
    if (lineHasBytes) {
      lineHasBytes = false;
      pendingLineEndingBytes = byteLength;
      return;
    }
    // A blank line dispatches the event. Neither the final content-line
    // terminator nor the blank-line terminator belongs to the event payload.
    eventBytes = 0;
    pendingLineEndingBytes = 0;
  };

  const consumeByte = (byte) => {
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      if (byte === 0x0a) {
        consumeLineEnding(2);
        return;
      }
      consumeLineEnding(1);
    }
    if (byte === 0x0d) pendingCarriageReturn = true;
    else if (byte === 0x0a) consumeLineEnding(1);
    else consumeContentByte();
  };

  return {
    push(bytes) {
      for (const byte of bytes) consumeByte(byte);
    },
    finish() {
      if (!pendingCarriageReturn) return;
      pendingCarriageReturn = false;
      consumeLineEnding(1);
    },
  };
}

class FetchEventSource {
  constructor(url, fetchFn, headers) {
    this.url = url;
    this.fetchFn = fetchFn;
    this.headers = headers;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.controller = new AbortController();
    this.reader = null;
    queueMicrotask(() => void this.start());
  }

  addEventListener() {}

  removeEventListener() {}

  close() {
    this.readyState = 2;
    if (!this.controller.signal.aborted) this.controller.abort("SSE evidence source closed");
    if (this.reader) void cancelReader(this.reader);
  }

  async start() {
    let reader;
    try {
      const response = await this.fetchFn(this.url, {
        headers: { accept: "text/event-stream", ...this.headers },
        redirect: "error",
        signal: this.controller.signal,
      });
      if (!response.ok) throw new HttpStatusError(response.status);
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
        throw new LiveSemanticError("sse-media-type-mismatch", "Advertised SSE endpoint did not return text/event-stream.");
      }
      if (!response.body) throw new LiveSemanticError("sse-body-missing", "Advertised SSE endpoint returned no body.");
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      reader = response.body.getReader();
      this.reader = reader;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const rawByteTracker = createRawSseEventByteTracker();
      let buffer = "";
      let undecidedLineEnding = "";
      const emitCompleteBlocks = () => {
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (encoder.encode(block).byteLength > REALTIME_SSE_EVENT_MAX_BYTES) {
            throw new LiveSemanticError(
              "sse-event-too-large",
              "Advertised SSE endpoint emitted an event beyond its byte ceiling.",
            );
          }
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) this.onmessage?.({ data });
        }
        return blocks.length;
      };
      while (!this.controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (value) rawByteTracker.push(value);
        if (done) rawByteTracker.finish();
        undecidedLineEnding += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const trailingCarriageReturn = !done && undecidedLineEnding.endsWith("\r");
        const decided = trailingCarriageReturn ? undecidedLineEnding.slice(0, -1) : undecidedLineEnding;
        undecidedLineEnding = trailingCarriageReturn ? "\r" : "";
        buffer += decided.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        emitCompleteBlocks();
        if (done) {
          break;
        }
      }
      if (!this.controller.signal.aborted) {
        this.readyState = 2;
        this.onerror?.(new Event("error"));
      }
    } catch (error) {
      if (reader) await cancelReader(reader);
      if (this.controller.signal.aborted) return;
      this.readyState = 2;
      if (error instanceof LiveSemanticError) {
        this.onmessage?.({
          data: JSON.stringify({
            type: "error",
            terminal: true,
            code: "invalid-event",
            error: {},
          }),
        });
        return;
      }
      this.onerror?.(Object.assign(new Event("error"), { cause: error }));
    } finally {
      if (reader) {
        if (this.controller.signal.aborted) await cancelReader(reader);
        try {
          reader.releaseLock();
        } catch {
          // A released/cancelled reader has no remaining resource to clean.
        }
        if (this.reader === reader) this.reader = null;
      }
    }
  }
}

function nonExecutedTransport(id, advertised, status, code, message) {
  return {
    id,
    freshness: id === "odata" ? "poll" : "push",
    advertised,
    status,
    scenarioCounts: { total: 0, passed: 0, failed: 0 },
    scenarios: [],
    diagnostics: [{ code, message, scenario: null }],
  };
}

function assembleEvidence(options) {
  const counts = Object.fromEntries(
    ["executed", "unsupported", "degraded", "failed"].map((status) => [
      status,
      options.transports.filter((transport) => transport.status === status).length,
    ]),
  );
  const status = derivedEvidenceStatus(counts);
  return {
    format: REALTIME_CONFORMANCE_EVIDENCE_FORMAT,
    schemaVersion: 1,
    lane: options.lane,
    generatedAt: options.generatedAt,
    sdk: options.sdk,
    server: options.server,
    corpus: {
      kind: "honua.realtime-cross-transport-conformance",
      version: 1,
      sha256: sha256(options.corpusBytes),
    },
    summary: {
      status,
      transportCount: 3,
      scenarioCount: options.scenarioCount,
      executionCount: options.executionCount,
      ...counts,
    },
    transports: options.transports,
  };
}

function derivedEvidenceStatus(counts) {
  if (counts.failed > 0) return "failed";
  if (counts.degraded > 0) return "degraded";
  if (counts.executed > 0) return "executed";
  return "unsupported";
}

export function validateRealtimeConformanceEvidence(evidence) {
  invariant(
    validateEvidenceSchema(evidence),
    `Realtime evidence violates ${REALTIME_CONFORMANCE_EVIDENCE_SCHEMA}: ${evidenceAjv.errorsText(
      validateEvidenceSchema.errors,
      { separator: "; " },
    )}`,
  );
  invariant(evidence?.format === REALTIME_CONFORMANCE_EVIDENCE_FORMAT, "Realtime evidence format drift.");
  invariant(evidence.schemaVersion === 1, "Realtime evidence schema version drift.");
  invariant(evidence.lane === "fixture" || evidence.lane === "live", "Realtime evidence lane is invalid.");
  invariant(!Number.isNaN(Date.parse(evidence.generatedAt)), "Realtime evidence timestamp is invalid.");
  invariant(evidence.sdk?.package === "@honua/sdk-js", "Realtime evidence package identity drift.");
  invariant(/^[a-f0-9]{40}$/u.test(evidence.sdk?.revision ?? ""), "Realtime evidence SDK revision is invalid.");
  invariant(/^[a-f0-9]{64}$/u.test(evidence.corpus?.sha256 ?? ""), "Realtime evidence corpus digest is invalid.");
  invariant(Array.isArray(evidence.transports) && evidence.transports.length === 3, "Realtime evidence needs three transports.");
  invariant(
    JSON.stringify(evidence.transports.map((transport) => transport.id)) === JSON.stringify(REALTIME_TRANSPORTS),
    "Realtime evidence transport identities/order drifted.",
  );
  const statusCounts = { executed: 0, unsupported: 0, degraded: 0, failed: 0 };
  for (const transport of evidence.transports) {
    invariant(
      evidence.server.capabilities[transport.id] === transport.advertised,
      `${transport.id} advertisement contradicts server capabilities.`,
    );
    invariant(Object.hasOwn(statusCounts, transport.status), `${transport.id} has an invalid status.`);
    statusCounts[transport.status] += 1;
    invariant(
      transport.freshness === (transport.id === "odata" ? "poll" : "push"),
      `${transport.id} freshness is untruthful.`,
    );
    invariant(
      transport.scenarioCounts.total === transport.scenarios.length,
      `${transport.id} scenario totals drifted.`,
    );
    const passed = transport.scenarios.filter((scenario) => scenario.result === "passed").length;
    const failed = transport.scenarios.filter((scenario) => scenario.result === "failed").length;
    invariant(
      transport.scenarioCounts.passed === passed && transport.scenarioCounts.failed === failed,
      `${transport.id} scenario result counts drifted.`,
    );
    invariant(
      transport.scenarioCounts.total === passed + failed,
      `${transport.id} scenario counts do not partition the total.`,
    );
    if (!transport.advertised) {
      invariant(transport.scenarios.length === 0, `${transport.id} executed scenarios without advertisement.`);
      invariant(transport.status !== "executed", `${transport.id} executed without advertisement.`);
    }
    if (transport.status === "executed") {
      invariant(transport.advertised, `${transport.id} execution lacks advertisement.`);
      invariant(
        transport.scenarios.length > 0 && failed === 0 && passed === transport.scenarios.length,
        `${transport.id} executed status contradicts its scenario results.`,
      );
      if (evidence.lane === "live") {
        invariant(
          transport.acceptedState?.eventCount >= 2 &&
            /^sha256:[a-f0-9]{64}$/u.test(transport.acceptedState?.historySha256 ?? "") &&
            /^sha256:[a-f0-9]{64}$/u.test(transport.acceptedState?.finalStateSha256 ?? ""),
          `${transport.id} live execution lacks a bounded accepted-state fingerprint.`,
        );
      }
    } else if (transport.status === "unsupported") {
      invariant(
        !transport.advertised && transport.scenarios.length === 0,
        `${transport.id} unsupported status contradicts advertisement or execution.`,
      );
    } else if (transport.scenarios.length > 0) {
      invariant(
        transport.advertised && failed > 0,
        `${transport.id} ${transport.status} status contradicts its scenario results.`,
      );
    }
    if (transport.status !== "executed") {
      invariant(transport.diagnostics.length > 0, `${transport.id} non-execution lacks diagnostics.`);
    }
    if (evidence.lane === "fixture") {
      invariant(transport.acceptedState === undefined, `${transport.id} fixture evidence invented a live state.`);
    }
  }
  for (const [status, count] of Object.entries(statusCounts)) {
    invariant(evidence.summary[status] === count, `Realtime evidence ${status} count drifted.`);
  }
  invariant(
    evidence.summary.status === derivedEvidenceStatus(statusCounts),
    "Realtime evidence summary status contradicts transport outcomes.",
  );
  if (statusCounts.executed > 0) {
    invariant(
      immutableServerRevisionOrNull(evidence.server?.revision) !== null,
      "Executed realtime evidence requires an immutable server revision.",
    );
  }
  if (evidence.lane === "live") {
    const executedStates = evidence.transports
      .filter((transport) => transport.status === "executed")
      .map(
        (transport) =>
          `${String(transport.acceptedState.eventCount)}:${transport.acceptedState.historySha256}:${transport.acceptedState.finalStateSha256}`,
      );
    invariant(
      new Set(executedStates).size <= 1,
      "Executed realtime transports accepted divergent histories or final states.",
    );
  }
  const scenarioIds = new Set(evidence.transports.flatMap((transport) => transport.scenarios.map((scenario) => scenario.id)));
  const executionCount = evidence.transports.reduce(
    (total, transport) => total + transport.scenarioCounts.total,
    0,
  );
  invariant(evidence.summary.scenarioCount === scenarioIds.size, "Realtime evidence scenario count drifted.");
  invariant(evidence.summary.executionCount === executionCount, "Realtime evidence execution count drifted.");
  const serialized = JSON.stringify(evidence);
  invariant(!/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/u.test(serialized), "Realtime evidence retained a bearer token.");
  invariant(
    !/"(?:cursor|watermark|deltaToken)"\s*:/u.test(serialized),
    "Realtime evidence retained a raw resume-position field.",
  );
  return evidence;
}

export function summarizeRealtimeConformanceEvidence(evidence) {
  validateRealtimeConformanceEvidence(evidence);
  return [
    `lane=${evidence.lane} status=${evidence.summary.status} revision=${evidence.sdk.revision}`,
    ...evidence.transports.map(
      (transport) =>
        `${transport.id}: ${transport.status} (${String(transport.scenarioCounts.passed)}/${String(
          transport.scenarioCounts.total,
        )} scenarios, freshness=${transport.freshness})`,
    ),
  ];
}

function sanitizeBaseUrl(value) {
  const url = new URL(value);
  invariant(url.protocol === "https:" || isLoopback(url), "Live realtime base URL must use HTTPS.");
  invariant(!url.username && !url.password && !url.search && !url.hash, "Live realtime base URL cannot carry secrets.");
  return url.toString().replace(/\/$/u, "");
}

function sanitizeTransportUrl(value, baseUrl, id) {
  const url = new URL(value, `${baseUrl}/`);
  const base = new URL(baseUrl);
  invariant(sameServerAuthority(url, base), `${id} capability URL must remain on the reviewed server origin.`);
  invariant(!url.username && !url.password && !url.hash, `${id} capability URL cannot carry credentials.`);
  if (id === "websocket") {
    invariant(
      url.protocol === "wss:" || (isLoopbackHost(base) && url.protocol === "ws:"),
      "WebSocket capability must use WSS.",
    );
  } else {
    invariant(url.protocol === "https:" || isLoopback(url), `${id} capability URL must use HTTPS.`);
  }
  return url.toString();
}

function isLoopback(url) {
  return (
    url.protocol === "http:" &&
    isLoopbackHost(url)
  );
}

function isLoopbackHost(url) {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function sameServerAuthority(transportUrl, baseUrl) {
  if (transportUrl.hostname !== baseUrl.hostname) return false;
  const transportPort =
    transportUrl.port || (transportUrl.protocol === "https:" || transportUrl.protocol === "wss:" ? "443" : "80");
  const basePort = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
  return transportPort === basePort;
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer.`);
  return value;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function immutableServerRevisionOrNull(value) {
  if (value === undefined || value === null) return null;
  invariant(
    typeof value === "string" && value.trim().length > 0,
    "Realtime server revision must be a non-empty string when provided.",
  );
  const revision = value.trim();
  invariant(
    IMMUTABLE_SERVER_REVISION.test(revision),
    "Realtime server revision must be a full commit SHA or sha256 image digest.",
  );
  return revision;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isDataEvent(event) {
  return ["snapshot", "upsert", "delete", "delta"].includes(event?.type);
}

function hasSnapshotThenMutation(events) {
  let snapshotAccepted = false;
  for (const event of events) {
    if (event.type === "snapshot") {
      snapshotAccepted = true;
      continue;
    }
    if (snapshotAccepted && eventCarriesMutation(event)) return true;
  }
  return false;
}

function eventCarriesMutation(event) {
  if (event.type === "upsert" || event.type === "delete") return true;
  return event.type === "delta" && ((event.upserts?.length ?? 0) > 0 || (event.deletes?.length ?? 0) > 0);
}

function verifyNormalizedLiveHistory(sdk, events) {
  if (events.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxEvents) {
    throw liveSemanticBoundaryError();
  }
  let reduced = sdk.emptyRealtimeFeatureState();
  let independent = { records: new Map(), tombstones: new Map() };
  const eventBudget = createLiveSemanticBudget();
  const history = createHash("sha256");
  let historyBytes = 0;
  for (const [index, event] of events.entries()) {
    const semanticEvent = normalizeLiveSemanticEvent(event, eventBudget);
    reduced = sdk.reduceRealtimeFeatureState(reduced, event);
    const actual = normalizedLiveFeatureState(reduced, createLiveSemanticBudget());
    independent = reduceNormalizedLiveEvent(independent, semanticEvent);
    const expected = normalizedIndependentLiveState(independent);
    const actualJson = canonicalJson(actual);
    const expectedJson = canonicalJson(expected);
    if (actualJson !== expectedJson) {
      throw new LiveSemanticError(
        "normalized-final-state-mismatch",
        "Accepted live history did not reconcile at every independently normalized state transition.",
      );
    }
    const transition = canonicalJson({
      ordinal: index,
      event: semanticEvent,
      state: actual,
    });
    historyBytes += Buffer.byteLength(transition, "utf8");
    if (historyBytes > REALTIME_LIVE_SEMANTIC_LIMITS.maxHistoryBytes) {
      throw liveSemanticBoundaryError();
    }
    history.update(`${String(Buffer.byteLength(transition, "utf8"))}:`);
    history.update(transition);
  }
  const finalState = normalizedIndependentLiveState(independent);
  invariant(finalState !== undefined, "Accepted live history cannot be empty.");
  return {
    historySha256: `sha256:${history.digest("hex")}`,
    finalStateSha256: `sha256:${sha256(canonicalJson(finalState))}`,
  };
}

function normalizedLiveFeatureState(state, budget) {
  const records = new Map();
  for (const record of Object.values(state.records)) {
    const normalized = normalizeLiveSemanticUpsert(record, budget);
    addUniqueLiveSemanticIdentity(records, normalized.id, normalized);
  }
  const tombstones = new Map();
  for (const tombstone of Object.values(state.tombstones)) {
    const normalized = normalizeLiveSemanticDelete(tombstone, budget);
    addUniqueLiveSemanticIdentity(tombstones, normalized.id, normalized);
  }
  if (
    records.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords ||
    tombstones.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords
  ) {
    throw liveSemanticBoundaryError();
  }
  return {
    records: [...records.entries()].sort(([left], [right]) => left.localeCompare(right)),
    tombstones: [...tombstones.entries()].sort(([left], [right]) => left.localeCompare(right)),
  };
}

function normalizeLiveSemanticEvent(event, budget) {
  if (!isRecord(event)) throw liveSemanticBoundaryError();
  const upserts =
    event.type === "snapshot"
      ? normalizeLiveSemanticPatchList(event.features, normalizeLiveSemanticUpsert, budget)
      : event.type === "upsert"
        ? [normalizeLiveSemanticUpsert(event.feature, budget)]
        : event.type === "delta"
          ? normalizeLiveSemanticPatchList(event.upserts ?? [], normalizeLiveSemanticUpsert, budget)
          : [];
  const deletes =
    event.type === "delete"
      ? [normalizeLiveSemanticDelete(event, budget)]
      : event.type === "delta"
        ? normalizeLiveSemanticPatchList(event.deletes ?? [], normalizeLiveSemanticDelete, budget)
        : [];
  if (!["snapshot", "upsert", "delete", "delta"].includes(event.type)) throw liveSemanticBoundaryError();
  const identities = new Set();
  for (const patch of [...upserts, ...deletes]) {
    if (identities.has(patch.id)) throw liveSemanticBoundaryError();
    identities.add(patch.id);
  }
  return {
    kind: event.type === "snapshot" ? "snapshot" : "mutation",
    ...(event.type === "snapshot" ? { replace: event.replace !== false } : {}),
    upserts: upserts.sort((left, right) => left.id.localeCompare(right.id)),
    deletes: deletes.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function normalizeLiveSemanticPatchList(value, normalize, budget) {
  if (!Array.isArray(value) || value.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxFeaturesPerEvent) {
    throw liveSemanticBoundaryError();
  }
  return value.map((patch) => normalize(patch, budget));
}

function normalizeLiveSemanticUpsert(patch, budget) {
  if (!isRecord(patch) || !Object.hasOwn(patch, "feature")) throw liveSemanticBoundaryError();
  const id = normalizeLiveSemanticFeatureId(patch.id);
  return {
    id,
    feature: normalizeLiveSemanticFeature(patch.feature, id, budget),
  };
}

function normalizeLiveSemanticDelete(patch, budget) {
  if (!isRecord(patch)) throw liveSemanticBoundaryError();
  return {
    id: normalizeLiveSemanticFeatureId(patch.id),
  };
}

function normalizeLiveSemanticFeature(feature, patchId, budget) {
  if (!isRecord(feature) || Array.isArray(feature)) throw liveSemanticBoundaryError();
  if (feature.type === "Feature") {
    if (!Object.hasOwn(feature, "geometry") || !Object.hasOwn(feature, "properties")) {
      throw liveSemanticBoundaryError();
    }
    if (Object.hasOwn(feature, "id") && normalizeLiveSemanticFeatureId(feature.id) !== patchId) {
      throw liveSemanticBoundaryError();
    }
    const properties = feature.properties === null ? {} : feature.properties;
    if (!isRecord(properties) || Array.isArray(properties)) throw liveSemanticBoundaryError();
    const metadata = Object.fromEntries(
      Object.entries(feature).filter(([key]) => !["type", "id", "geometry", "properties"].includes(key)),
    );
    return {
      geometry: normalizeLiveSemanticGeometry(feature.geometry, budget),
      properties: boundedLiveSemanticJson(properties, budget, 0),
      metadata: boundedLiveSemanticJson(metadata, budget, 0),
    };
  }
  const geometryEntries = Object.entries(feature).filter(([key]) => key.toLowerCase() === "geometry");
  if (geometryEntries.length > 1) throw liveSemanticBoundaryError();
  const geometryKey = geometryEntries[0]?.[0];
  const properties = Object.fromEntries(
    Object.entries(feature).filter(
      ([key]) =>
        key !== geometryKey &&
        key !== "@removed" &&
        key !== "@odata.removed" &&
        !key.toLowerCase().startsWith("@odata."),
    ),
  );
  return {
    geometry: normalizeLiveSemanticGeometry(geometryKey === undefined ? null : feature[geometryKey], budget),
    properties: boundedLiveSemanticJson(properties, budget, 0),
    metadata: {},
  };
}

function normalizeLiveSemanticGeometry(value, budget) {
  if (value !== null && (!isRecord(value) || Array.isArray(value))) throw liveSemanticBoundaryError();
  const normalized = boundedLiveSemanticJson(value, budget, 0);
  if (normalized !== null) assertLiveSemanticGeometry(normalized, budget);
  return normalized;
}

function assertLiveSemanticGeometry(value, budget) {
  if (!isRecord(value) || Array.isArray(value) || typeof value.type !== "string") {
    throw liveSemanticBoundaryError();
  }
  switch (value.type) {
    case "Point":
      assertLiveSemanticPosition(value.coordinates, budget);
      return;
    case "MultiPoint":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticPosition, 1);
      return;
    case "LineString":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticPosition, 2);
      return;
    case "MultiLineString":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticLineString, 1);
      return;
    case "Polygon":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticLinearRing, 1);
      return;
    case "MultiPolygon":
      assertLiveSemanticCoordinateList(value.coordinates, budget, assertLiveSemanticPolygon, 1);
      return;
    case "GeometryCollection":
      if (Object.hasOwn(value, "coordinates")) throw liveSemanticBoundaryError();
      assertLiveSemanticCoordinateList(value.geometries, budget, assertLiveSemanticGeometry, 0);
      return;
    default:
      throw liveSemanticBoundaryError();
  }
}

function assertLiveSemanticLineString(value, budget) {
  assertLiveSemanticCoordinateList(value, budget, assertLiveSemanticPosition, 2);
}

function assertLiveSemanticLinearRing(value, budget) {
  assertLiveSemanticCoordinateList(value, budget, assertLiveSemanticPosition, 4);
  if (!sameLiveSemanticPosition(value[0], value.at(-1))) throw liveSemanticBoundaryError();
}

function assertLiveSemanticPolygon(value, budget) {
  assertLiveSemanticCoordinateList(value, budget, assertLiveSemanticLinearRing, 1);
}

function assertLiveSemanticCoordinateList(value, budget, validate, minimumLength) {
  if (!Array.isArray(value) || value.length < minimumLength) throw liveSemanticBoundaryError();
  for (const entry of value) validate(entry, budget);
}

function assertLiveSemanticPosition(value, budget) {
  if (!Array.isArray(value) || value.length < 2 || !value.every((entry) => typeof entry === "number")) {
    throw liveSemanticBoundaryError();
  }
  budget.geometryPositions += 1;
  if (budget.geometryPositions > REALTIME_LIVE_SEMANTIC_LIMITS.maxGeometryPositions) {
    throw liveSemanticBoundaryError();
  }
}

function sameLiveSemanticPosition(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((entry, index) => Object.is(entry, right[index]))
  );
}

function normalizeLiveSemanticFeatureId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return `integer:${String(value)}`;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1_024) {
    throw liveSemanticBoundaryError();
  }
  if (/^(?:0|-?[1-9][0-9]*)$/u.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && String(numeric) === value) return `integer:${value}`;
  }
  return `string:${value}`;
}

function createLiveSemanticBudget() {
  return { nodes: 0, geometryPositions: 0 };
}

function boundedLiveSemanticJson(value, budget, depth) {
  budget.nodes += 1;
  if (budget.nodes > REALTIME_LIVE_SEMANTIC_LIMITS.maxNodes || depth > REALTIME_LIVE_SEMANTIC_LIMITS.maxDepth) {
    throw liveSemanticBoundaryError();
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw liveSemanticBoundaryError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > REALTIME_LIVE_SEMANTIC_LIMITS.maxStringBytes) {
      throw liveSemanticBoundaryError();
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxArrayItems) throw liveSemanticBoundaryError();
    return value.map((entry) => boundedLiveSemanticJson(entry, budget, depth + 1));
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw liveSemanticBoundaryError();
  const keys = Object.keys(value);
  if (keys.length > REALTIME_LIVE_SEMANTIC_LIMITS.maxObjectKeys) throw liveSemanticBoundaryError();
  return Object.fromEntries(
    keys
      .sort()
      .map((key) => [
        boundedLiveSemanticJson(key, budget, depth + 1),
        boundedLiveSemanticJson(value[key], budget, depth + 1),
      ]),
  );
}

function reduceNormalizedLiveEvent(state, event) {
  const records = new Map(state.records);
  const tombstones = new Map(state.tombstones);
  if (event.kind === "snapshot" && event.replace) {
    records.clear();
    tombstones.clear();
  }
  for (const patch of event.upserts) {
    records.set(patch.id, patch);
    tombstones.delete(patch.id);
  }
  for (const patch of event.deletes) {
    records.delete(patch.id);
    tombstones.set(patch.id, patch);
  }
  if (
    records.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords ||
    tombstones.size > REALTIME_LIVE_SEMANTIC_LIMITS.maxRecords
  ) {
    throw liveSemanticBoundaryError();
  }
  return { records, tombstones };
}

function normalizedIndependentLiveState(state) {
  return {
    records: [...state.records.entries()].sort(([left], [right]) => left.localeCompare(right)),
    tombstones: [...state.tombstones.entries()].sort(([left], [right]) => left.localeCompare(right)),
  };
}

function addUniqueLiveSemanticIdentity(target, id, value) {
  if (target.has(id)) throw liveSemanticBoundaryError();
  target.set(id, value);
}

function liveSemanticBoundaryError() {
  return new LiveSemanticError(
    "semantic-normalization-invalid",
    "Accepted live data exceeded or violated the bounded transport-neutral semantic feature contract.",
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LiveDegradedError("observation-timeout", message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseArgs(argv) {
  const options = {
    lane: "fixture",
    output: "test-results/realtime-conformance-evidence.json",
    strict: false,
    allowDegraded: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--lane") options.lane = argv[++index] ?? "";
    else if (argument === "--output") options.output = argv[++index] ?? "";
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--allow-degraded") options.allowDegraded = true;
    else throw new Error(`Unknown realtime conformance argument: ${argument}`);
  }
  invariant(options.lane === "fixture" || options.lane === "live", "--lane must be fixture or live.");
  invariant(options.output.length > 0, "--output must not be empty.");
  return options;
}

function safeOutputPath(value) {
  const output = path.resolve(PROJECT_ROOT, value);
  invariant(output.startsWith(`${PROJECT_ROOT}${path.sep}`), "Realtime evidence output must stay inside the repository.");
  return output;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence =
    options.lane === "fixture"
      ? await collectFixtureRealtimeConformanceEvidence()
      : await collectLiveRealtimeConformanceEvidence();
  const output = safeOutputPath(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  for (const line of summarizeRealtimeConformanceEvidence(evidence)) process.stdout.write(`${line}\n`);
  if (!options.strict) return;
  if (evidence.summary.status === "failed") process.exitCode = 1;
  else if (evidence.summary.status === "degraded" && !options.allowDegraded) process.exitCode = 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`Realtime conformance evidence failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
