#!/usr/bin/env node

/**
 * Opt-in evidence probe for the canonical Honua demo and AWS-hosted STAC data.
 * It is scheduled/manual only: default PR and local validation never contact it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const TIMEOUT_MS = 30_000;
const INCIDENT_OBSERVATION_WINDOW_MS = 12_000;
const PRODUCER_PATH = "scripts/live-benchmark-evidence.mjs";

/**
 * Machine-readable skip taxonomy for the live lane.
 *
 * A skip is only honest when the probe positively established that the live
 * environment cannot demonstrate the journey. Every other outcome - transport
 * failure, non-2xx response, timeout, or a response whose shape does not match
 * the protocol - stays `failed` so an attestation never masks a regression.
 */
export const LIVE_SKIP_REASON_CODES = Object.freeze({
  liveProbesDisabled: "live-probes-disabled",
  operatorRequested: "operator-requested-skip",
  realtimeCapabilityProbeUnavailable: "realtime-capability-probe-unavailable",
  realtimeCapabilityDisabled: "realtime-capability-disabled",
  incidentDemoDatasetEmpty: "incident-demo-dataset-empty",
  incidentDemoServiceMissing: "incident-demo-service-missing",
});

/**
 * Reconnect outcomes carried by the incident sample evidence envelope when the
 * journey is skipped. The envelope has no free-form code field, so the outcome
 * string is the machine-readable discriminator a consumer can branch on.
 *
 * Every skip code must appear here. A code that falls through to the default
 * would publish a vaguer outcome than the producer actually knows, and mapping
 * one onto another condition's outcome would state something untrue.
 */
export const INCIDENT_SKIP_RECONNECT_OUTCOMES = Object.freeze({
  [LIVE_SKIP_REASON_CODES.liveProbesDisabled]: "not-attempted-live-probes-disabled",
  [LIVE_SKIP_REASON_CODES.operatorRequested]: "not-attempted-operator-skip",
  [LIVE_SKIP_REASON_CODES.realtimeCapabilityProbeUnavailable]: "not-attempted-capability-unavailable",
  [LIVE_SKIP_REASON_CODES.realtimeCapabilityDisabled]: "not-attempted-capability-unavailable",
  [LIVE_SKIP_REASON_CODES.incidentDemoDatasetEmpty]: "not-attempted-demo-dataset-empty",
  [LIVE_SKIP_REASON_CODES.incidentDemoServiceMissing]: "not-attempted-demo-service-missing",
});

/** Only reachable if a new skip code is added without mapping it; says no more than it knows. */
const INCIDENT_DEFAULT_SKIP_RECONNECT_OUTCOME = "not-attempted";

class SkipTargetError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "SkipTargetError";
    this.reasonCode = reasonCode;
  }
}

class HttpStatusError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

function parseArgs(argv) {
  const options = { output: "test-results/live-benchmark-evidence.json", strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") options.output = argv[++index] ?? "";
    else if (arg === "--strict") options.strict = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.output) throw new Error("--output must not be empty");
  return options;
}

function gitCommit() {
  if (/^[a-f0-9]{40}$/.test(process.env.HONUA_SAMPLE_SOURCE_REVISION ?? "")) {
    return process.env.HONUA_SAMPLE_SOURCE_REVISION;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function contentBoundProducerArtifact() {
  const bytes = await readFile(fileURLToPath(import.meta.url));
  return {
    kind: "producer-generator",
    path: PRODUCER_PATH,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sanitizedBaseUrl(value) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Live base URL must use HTTP(S)");
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

async function requestJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = new Date();
  const timerStartedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw new HttpStatusError(response.status);
    return {
      body,
      latencyMs: performance.now() - timerStartedAt,
      observedAt: startedAt.toISOString(),
      serverDate: response.headers.get("date"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function observeIncidentDelta(url, headers = {}, observationWindowMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), observationWindowMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "text/event-stream", ...headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("SSE response did not expose a readable body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const payload = JSON.parse(data);
        const kind = payload.type ?? payload.kind ?? payload.op;
        const hasChanges = Array.isArray(payload.changes) && payload.changes.length > 0;
        if (!["change", "feature-change", "delta", "upsert", "delete", "insert", "update"].includes(kind) && !hasChanges) {
          continue;
        }
        return {
          kind: String(kind ?? "change"),
          cursor: typeof payload.cursor === "string" && payload.cursor.length > 0 ? payload.cursor : null,
          sequence: typeof payload.sequence === "number" ? payload.sequence : null,
          timestamp: typeof payload.timestamp === "string" ? payload.timestamp : null,
          latencyMs: performance.now() - startedAt,
        };
      }
    }
    throw new Error("SSE stream closed before a feature delta was observed");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`No feature delta was observed within ${observationWindowMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Realtime block published when the incident journey never started. */
function incidentSkipRealtime(reasonCode) {
  return {
    snapshotAt: null,
    cursor: null,
    lagMs: null,
    observationWindowMs: INCIDENT_OBSERVATION_WINDOW_MS,
    reconnectOutcome: INCIDENT_SKIP_RECONNECT_OUTCOMES[reasonCode] ?? INCIDENT_DEFAULT_SKIP_RECONNECT_OUTCOME,
  };
}

/**
 * Realtime block for a skipped target. The fallback may be a function so a
 * target can report a reconnect outcome that matches why it was skipped.
 */
function skippedRealtime(definition, reasonCode) {
  const fallback = definition.realtimeFallback;
  if (!fallback) return {};
  return { realtime: typeof fallback === "function" ? fallback(reasonCode) : fallback };
}

async function probeTarget(definition) {
  if (definition.skipReason) {
    const reasonCode = definition.skipReasonCode ?? LIVE_SKIP_REASON_CODES.operatorRequested;
    return {
      id: definition.id,
      sampleId: definition.sampleId,
      journeyId: definition.journeyId,
      status: "skipped",
      provider: definition.provider,
      endpoint: definition.endpoint,
      authMode: definition.authMode,
      attribution: definition.attribution,
      skipReason: definition.skipReason,
      skipReasonCode: reasonCode,
      ...skippedRealtime(definition, reasonCode),
    };
  }

  const startedAt = new Date().toISOString();
  try {
    const evidence = await definition.run();
    return {
      id: definition.id,
      sampleId: definition.sampleId,
      journeyId: definition.journeyId,
      status: "passed",
      provider: definition.provider,
      endpoint: definition.endpoint,
      authMode: definition.authMode,
      attribution: definition.attribution,
      startedAt,
      completedAt: new Date().toISOString(),
      ...evidence,
    };
  } catch (error) {
    if (error instanceof SkipTargetError) {
      return {
        id: definition.id,
        sampleId: definition.sampleId,
        journeyId: definition.journeyId,
        status: "skipped",
        provider: definition.provider,
        endpoint: definition.endpoint,
        authMode: definition.authMode,
        attribution: definition.attribution,
        startedAt,
        completedAt: new Date().toISOString(),
        skipReason: error.message,
        skipReasonCode: error.reasonCode,
        ...skippedRealtime(definition, error.reasonCode),
      };
    }
    return {
      id: definition.id,
      sampleId: definition.sampleId,
      journeyId: definition.journeyId,
      status: "failed",
      provider: definition.provider,
      endpoint: definition.endpoint,
      authMode: definition.authMode,
      attribution: definition.attribution,
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertionStrings(checks) {
  return Object.entries(checks ?? {}).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
}

export function toSampleEvidence(target, sdk, generatedAt, producerArtifact) {
  const executed = target.status === "passed";
  const failed = target.status === "failed";
  const observedAt = target.freshness?.observedAt ?? target.completedAt ?? generatedAt;
  const nonExecutedReason = target.error ?? target.skipReason ?? "Live target did not execute.";
  // The shared envelope has no free-form code field, so the typed skip code is
  // published as an additional machine-readable degradation reason.
  const degradationReasons = executed
    ? []
    : target.skipReasonCode
      ? [nonExecutedReason, target.skipReasonCode]
      : [nonExecutedReason];
  return validateEvidenceEnvelope({
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: target.sampleId,
    lane: "live",
    status: executed ? "executed" : failed ? "failed" : "skipped",
    reason: executed ? null : nonExecutedReason,
    observedAt,
    authMode: target.authMode,
    sdk,
    source: {
      provider: target.provider,
      identity: target.provenance?.source ?? target.id,
      endpoint: target.endpoint,
      deploymentVersion: target.endpointVersion ?? null,
      dataVersion: target.freshness?.sourceDataTimestamp ?? null,
    },
    provenance: executed
      ? {
          sourceId: target.provenance.source,
          observedAt,
          validAt: target.freshness?.sourceDataTimestamp ?? null,
          state: "live",
          attribution: target.attribution,
        }
      : null,
    semantics: {
      operation: target.journeyId,
      outcome: executed ? target.journey?.visibleOutcome.kind ?? "live-check-passed" : null,
      itemCount: executed ? target.journey?.visibleOutcome.itemCount ?? null : null,
      assertions: executed ? assertionStrings(target.checks) : [],
    },
    timing: {
      totalMs: executed ? target.latencyMs : null,
      firstSuccessfulInteractionMs: executed ? target.journey?.timeToFirstSuccessfulInteractionMs ?? null : null,
    },
    degradation: {
      state: executed ? "none" : failed ? "unexpected" : "unavailable",
      reasons: degradationReasons,
    },
    ...(target.realtime ? { realtime: target.realtime } : {}),
    artifacts: producerArtifact ? [producerArtifact] : [],
  });
}

export async function collectLiveEvidence(env = process.env) {
  const generatedAt = new Date().toISOString();
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const producerArtifact = await contentBoundProducerArtifact();
  const enabled =
    env.HONUA_SAMPLE_LIVE_ENABLED === "true" || env.HONUA_BENCH_LIVE_ENABLED === "true";
  if (!enabled) {
    const sdk = { package: packageJson.name, version: packageJson.version, gitCommit: gitCommit() };
    const reason = "Live benchmark enablement is not true; live probes are opt-in";
    const disabledTargets = [
      {
        id: "honua-demo-maplibre-quickstart",
        sampleId: "maplibre-quickstart",
        journeyId: "compatibility-layer-query-renderable-geometry",
        status: "skipped",
        provider: "honua-demo",
        endpoint: "https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1",
        authMode: "anonymous",
        attribution: "Honua canonical demo data",
        skipReason: reason,
        skipReasonCode: LIVE_SKIP_REASON_CODES.liveProbesDisabled,
      },
      {
        id: "honua-demo-incident-realtime",
        sampleId: "realtime-incident-dashboard",
        journeyId: "snapshot-observe-and-reconnect-delta",
        status: "skipped",
        provider: "honua-demo",
        endpoint: "https://demo.honua.io/api/v1/streaming/features",
        authMode: "anonymous",
        attribution: "Honua demo synthetic incident operations data",
        skipReason: reason,
        skipReasonCode: LIVE_SKIP_REASON_CODES.liveProbesDisabled,
        realtime: incidentSkipRealtime(LIVE_SKIP_REASON_CODES.liveProbesDisabled),
      },
    ];
    return {
      format: "honua.sdk.benchmark-live-evidence.v1",
      schemaVersion: 1,
      generatedAt,
      contract: {
        producerIssue: "https://github.com/honua-io/honua-sdk-js/issues/401",
        consumerIssue: "https://github.com/honua-io/honua-site/issues/120",
      },
      sdk,
      run: {
        status: "skipped",
        trigger: env.GITHUB_EVENT_NAME ?? "local",
        skipReason: reason,
      },
      targets: disabledTargets.map((rawTarget) => {
        const { sampleId: _sampleId, journeyId: _journeyId, attribution: _attribution, ...target } = rawTarget;
        return { ...target, sampleEvidence: toSampleEvidence(rawTarget, sdk, generatedAt, producerArtifact) };
      }),
    };
  }

  const honuaBaseUrl = sanitizedBaseUrl(env.HONUA_BENCH_LIVE_BASE_URL ?? "https://demo.honua.io");
  const apiKey = env.HONUA_BENCH_LIVE_API_KEY;
  const authMode = apiKey ? "api-key" : "anonymous";
  const authHeaders = apiKey ? { "x-api-key": apiKey } : {};
  const awsBaseUrl = "https://earth-search.aws.element84.com/v1";
  const quickstartServiceId = env.HONUA_BENCH_LIVE_QUICKSTART_SERVICE_ID ?? "maui-parcels";
  const quickstartLayerId = Number(env.HONUA_BENCH_LIVE_QUICKSTART_LAYER_ID ?? "1");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(quickstartServiceId)) {
    throw new Error("Quickstart live service id contains unsupported characters");
  }
  if (!Number.isInteger(quickstartLayerId) || quickstartLayerId < 0) {
    throw new Error("Quickstart live layer id must be a non-negative integer");
  }
  const quickstartLayerUrl = `${honuaBaseUrl}/rest/services/${quickstartServiceId
    .split("/")
    .map(encodeURIComponent)
    .join("/")}/FeatureServer/${quickstartLayerId}`;
  const sdk = { package: packageJson.name, version: packageJson.version, gitCommit: gitCommit() };
  const rawTargets = await Promise.all([
    probeTarget({
      id: "honua-demo-incident-realtime",
      sampleId: "realtime-incident-dashboard",
      journeyId: "snapshot-observe-and-reconnect-delta",
      provider: "honua-demo",
      endpoint: `${honuaBaseUrl}/api/v1/streaming/features`,
      authMode,
      attribution: "Honua demo synthetic incident operations data",
      skipReason: env.HONUA_BENCH_LIVE_SKIP_HONUA_REASON || undefined,
      realtimeFallback: incidentSkipRealtime,
      async run() {
        const capabilitiesUrl = `${honuaBaseUrl}/api/v1/streaming/features/capabilities`;
        let capabilities;
        try {
          capabilities = await requestJson(capabilitiesUrl, authHeaders);
        } catch (error) {
          if (error instanceof HttpStatusError && [403, 404].includes(error.status)) {
            throw new SkipTargetError(
              LIVE_SKIP_REASON_CODES.realtimeCapabilityProbeUnavailable,
              `Realtime capability probe is unavailable (${error.message})`,
            );
          }
          throw error;
        }
        const advertised = capabilities.body?.data ?? capabilities.body;
        if (advertised?.enabled !== true) {
          throw new SkipTargetError(
            LIVE_SKIP_REASON_CODES.realtimeCapabilityDisabled,
            `Realtime feature streams are not enabled${advertised?.minimumEdition ? `; requires ${advertised.minimumEdition}` : ""}`,
          );
        }
        const snapshotUrl = `${honuaBaseUrl}/rest/services/maui-incidents/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=10&f=json`;
        const snapshot = await requestJson(snapshotUrl, authHeaders);
        // A transport failure, non-2xx status, or timeout already threw above and
        // stays `failed`. Only the well-formed shapes are classified here: an
        // error payload or a non-array `features` member is a genuine failure,
        // while an authenticated, schema-valid, zero-feature snapshot is an
        // honest skip because there is nothing for a delta to change.
        if (snapshot.body?.error) {
          // One error payload is not a defect but an environment fact the probe
          // positively established: a GeoServices 404 says this deployment does
          // not publish the incident service at all, so no snapshot-plus-delta
          // journey exists to demonstrate. Deploying and seeding it is owned by
          // honua-demo#14. Every other error code -- an authorization refusal, a
          // malformed query, a server fault -- still describes a service that is
          // published and answering wrongly, and stays a recorded failure.
          if (snapshot.body.error.code === 404) {
            throw new SkipTargetError(
              LIVE_SKIP_REASON_CODES.incidentDemoServiceMissing,
              "Realtime feature streams are enabled, but the demo does not publish the maui-incidents " +
                `feature service (${snapshot.body.error.message ?? "not found"}); a snapshot-plus-delta ` +
                "journey cannot be demonstrated against a service that does not exist " +
                "(deployment and seeding tracked by honua-demo#14)",
            );
          }
          throw new Error(
            `Incident snapshot query returned an error payload: ${snapshot.body.error.message ?? snapshot.body.error.code ?? "unspecified"}`,
          );
        }
        if (!Array.isArray(snapshot.body?.features)) throw new Error("Incident snapshot did not contain features");
        if (snapshot.body.features.length === 0) {
          throw new SkipTargetError(
            LIVE_SKIP_REASON_CODES.incidentDemoDatasetEmpty,
            "Realtime feature streams are enabled, but the demo incident feature service returned zero features; " +
              "a snapshot-plus-delta journey cannot be demonstrated against an empty dataset " +
              "(seeding tracked by honua-sdk-js#812)",
          );
        }
        const streamUrl = new URL(`${honuaBaseUrl}/api/v1/streaming/features`);
        streamUrl.searchParams.set("serviceId", "maui-incidents");
        streamUrl.searchParams.set("layers", "0");
        streamUrl.searchParams.set("requestId", "scheduled-incident-evidence");
        streamUrl.searchParams.set("mode", "snapshot-then-delta");
        const delta = await observeIncidentDelta(streamUrl, authHeaders, INCIDENT_OBSERVATION_WINDOW_MS);
        if (!delta.cursor) throw new Error("Incident delta did not include the cursor required for resumable reconnect");
        const reconnectUrl = new URL(streamUrl);
        reconnectUrl.searchParams.set("requestId", "scheduled-incident-evidence-reconnect");
        reconnectUrl.searchParams.set("cursor", delta.cursor);
        const redactedReconnectUrl = new URL(reconnectUrl);
        redactedReconnectUrl.searchParams.set("cursor", "{redacted}");
        const resumedDelta = await observeIncidentDelta(
          reconnectUrl,
          authHeaders,
          INCIDENT_OBSERVATION_WINDOW_MS,
        );
        if (!resumedDelta.cursor) throw new Error("Reconnected incident delta did not include a cursor");
        if (delta.sequence !== null && resumedDelta.sequence !== null && resumedDelta.sequence < delta.sequence) {
          throw new Error("Reconnect returned a sequence older than the requested cursor checkpoint");
        }
        const observedAt = new Date().toISOString();
        const eventAt = delta.timestamp ? Date.parse(delta.timestamp) : Number.NaN;
        return {
          endpointVersion: advertised.serverVersion ?? null,
          protocolVersion: "honua-feature-stream-v1",
          latencyMs: capabilities.latencyMs + snapshot.latencyMs + delta.latencyMs + resumedDelta.latencyMs,
          checks: {
            capabilityEnabled: true,
            snapshotFeatureCount: snapshot.body.features.length,
            deltaKind: delta.kind,
            cursorPresent: true,
            sequencePresent: delta.sequence !== null,
            reconnectCursorPresent: true,
            reconnectSequenceMonotonic:
              delta.sequence === null || resumedDelta.sequence === null || resumedDelta.sequence >= delta.sequence,
          },
          journey: {
            id: "snapshot-observe-and-reconnect-delta",
            timeToFirstSuccessfulInteractionMs: capabilities.latencyMs + snapshot.latencyMs,
            visibleOutcome: { kind: "snapshot-and-live-delta", itemCount: snapshot.body.features.length },
            console: { applicable: false, reason: "Protocol probe has no browser console" },
            accessibility: { applicable: false, reason: "Protocol probe has no rendered user interface" },
          },
          freshness: {
            observedAt,
            serverDate: snapshot.serverDate,
            sourceDataTimestamp: delta.timestamp,
            etag: snapshot.etag,
            lastModified: snapshot.lastModified,
          },
          provenance: {
            source: "honua-demo:maui-incidents:0",
            requestedUrls: [capabilitiesUrl, snapshotUrl, streamUrl.toString(), redactedReconnectUrl.toString()],
          },
          realtime: {
            snapshotAt: snapshot.observedAt,
            cursor: "present",
            lagMs: Number.isFinite(eventAt) ? Math.max(0, Date.parse(observedAt) - eventAt) : null,
            observationWindowMs: INCIDENT_OBSERVATION_WINDOW_MS * 2,
            reconnectOutcome: "resumed-from-cursor-and-observed-delta",
          },
        };
      },
    }),
    probeTarget({
      id: "honua-demo-maplibre-quickstart",
      sampleId: "maplibre-quickstart",
      journeyId: "compatibility-layer-query-renderable-geometry",
      provider: "honua-demo",
      endpoint: quickstartLayerUrl,
      authMode,
      attribution: "Honua canonical demo data",
      skipReason: env.HONUA_BENCH_LIVE_SKIP_HONUA_REASON || undefined,
      async run() {
        const capabilitiesUrl = `${honuaBaseUrl}/api/v1/admin/capabilities`;
        const capabilities = await requestJson(capabilitiesUrl, authHeaders);
        const layerUrl = `${quickstartLayerUrl}?f=json`;
        const layer = await requestJson(layerUrl, authHeaders);
        if (layer.body?.error || layer.body?.id !== quickstartLayerId || typeof layer.body?.name !== "string") {
          throw new Error("Quickstart GeoServices layer metadata was unavailable or mismatched");
        }
        if (!(layer.body.capabilities ?? "").split(",").some((value) => value.trim().toLowerCase() === "query")) {
          throw new Error("Quickstart GeoServices layer did not advertise Query");
        }
        const queryUrl = `${quickstartLayerUrl}/query?where=1%3D1&outFields=*&resultRecordCount=1&f=json`;
        const query = await requestJson(queryUrl, authHeaders);
        if (query.body?.error || !Array.isArray(query.body?.features) || query.body.features.length < 1) {
          throw new Error("Quickstart GeoServices query did not return a bounded feature result");
        }
        const firstFeature = query.body.features[0];
        if (!firstFeature?.geometry || typeof firstFeature.geometry !== "object") {
          throw new Error("Quickstart GeoServices result did not contain renderable geometry");
        }
        return {
          endpointVersion: capabilities.body?.data?.serverVersion ?? null,
          protocolVersion: "geoservices-feature-service",
          latencyMs: capabilities.latencyMs + layer.latencyMs + query.latencyMs,
          checks: {
            compatibilityChecked: true,
            serviceId: quickstartServiceId,
            layerId: quickstartLayerId,
            layerName: layer.body.name,
            geometryType: layer.body.geometryType ?? "unreported",
            returnedFeatureCount: query.body.features.length,
            renderableGeometry: true,
          },
          journey: {
            id: "compatibility-layer-query-renderable-geometry",
            timeToFirstSuccessfulInteractionMs:
              capabilities.latencyMs + layer.latencyMs + query.latencyMs,
            visibleOutcome: {
              kind: "geoservices-renderable-feature",
              itemCount: query.body.features.length,
            },
            console: {
              applicable: false,
              reason: "Protocol probe has no browser console",
            },
            accessibility: {
              applicable: false,
              reason: "Protocol probe has no rendered user interface",
            },
          },
          freshness: {
            observedAt: query.observedAt,
            serverDate: query.serverDate,
            sourceDataTimestamp: null,
            etag: layer.etag ?? query.etag,
            lastModified: layer.lastModified ?? query.lastModified,
          },
          provenance: {
            source: `honua-demo:${quickstartServiceId}:${quickstartLayerId}`,
            requestedUrls: [capabilitiesUrl, layerUrl, queryUrl],
          },
        };
      },
    }),
    probeTarget({
      id: "aws-earth-search-stac",
      sampleId: "stac-imagery-browser",
      journeyId: "discover-and-search-first-item",
      provider: "element84-earth-search-aws",
      endpoint: awsBaseUrl,
      authMode: "anonymous",
      attribution: "Element 84 Earth Search and source collection providers",
      skipReason: env.HONUA_BENCH_LIVE_SKIP_AWS_REASON || undefined,
      async run() {
        const landing = await requestJson(awsBaseUrl);
        const searchUrl = `${awsBaseUrl}/search?collections=sentinel-2-l2a&limit=1`;
        const search = await requestJson(searchUrl);
        if (search.body?.type !== "FeatureCollection" || !Array.isArray(search.body?.features)) {
          throw new Error("STAC search response was not a FeatureCollection");
        }
        return {
          endpointVersion: landing.body?.stac_version ?? null,
          protocolVersion: landing.body?.stac_version ?? null,
          latencyMs: landing.latencyMs + search.latencyMs,
          checks: { returnedItemCount: search.body.features.length },
          journey: {
            id: "discover-and-search-first-item",
            timeToFirstSuccessfulInteractionMs: landing.latencyMs + search.latencyMs,
            visibleOutcome: {
              kind: "stac-feature-collection",
              itemCount: search.body.features.length,
            },
            console: {
              applicable: false,
              reason: "Protocol probe has no browser console",
            },
            accessibility: {
              applicable: false,
              reason: "Protocol probe has no rendered user interface",
            },
          },
          freshness: {
            observedAt: search.observedAt,
            serverDate: search.serverDate,
            sourceDataTimestamp: search.body.features[0]?.properties?.datetime ?? null,
            etag: search.etag,
            lastModified: search.lastModified,
          },
          provenance: {
            source: "earth-search-sentinel-2-l2a",
            requestedUrls: [awsBaseUrl, searchUrl],
          },
        };
      },
    }),
  ]);
  const targets = rawTargets.map((rawTarget) => {
    const { sampleId: _sampleId, journeyId: _journeyId, attribution: _attribution, ...target } = rawTarget;
    return { ...target, sampleEvidence: toSampleEvidence(rawTarget, sdk, generatedAt, producerArtifact) };
  });

  const failed = targets.filter((target) => target.status === "failed").length;
  const passed = targets.filter((target) => target.status === "passed").length;
  return {
    format: "honua.sdk.benchmark-live-evidence.v1",
    schemaVersion: 1,
    generatedAt,
    contract: {
      producerIssue: "https://github.com/honua-io/honua-sdk-js/issues/401",
      consumerIssue: "https://github.com/honua-io/honua-site/issues/120",
    },
    sdk,
    run: {
      status: failed > 0 ? "failed" : passed > 0 ? "passed" : "skipped",
      trigger: env.GITHUB_EVENT_NAME ?? "local",
      skipReason: passed === 0 && failed === 0 ? "Every configured target was skipped" : null,
    },
    targets,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await collectLiveEvidence();
  const receiptOutput = process.env.HONUA_SAMPLE_LIVE_OUTPUT;
  const receiptSampleId = process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID;
  const selectedEvidence = receiptOutput
    ? evidence.targets.find((target) => target.sampleEvidence?.sampleId === receiptSampleId)?.sampleEvidence
    : undefined;
  if (receiptOutput && !selectedEvidence) {
    throw new Error(`Live benchmark did not produce evidence for ${receiptSampleId ?? "the requested sample"}`);
  }
  const output = receiptOutput ?? options.output;
  const persisted = selectedEvidence ?? evidence;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Live benchmark evidence: ${evidence.run.status}; ${evidence.targets.length} target(s); ${output}\n`,
  );
  for (const target of evidence.targets) {
    process.stdout.write(`  ${target.id}: ${target.status}${target.skipReason ? ` (${target.skipReason})` : ""}\n`);
  }
  if (options.strict && evidence.run.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`live benchmark evidence failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
