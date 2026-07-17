#!/usr/bin/env node

/**
 * Opt-in evidence probe for the canonical Honua demo and AWS-hosted STAC data.
 * It is scheduled/manual only: default PR and local validation never contact it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EvidenceMap } from "./lib/evidence-map.mjs";
import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const TIMEOUT_MS = 30_000;
const FIRST_MAP_RUNTIME_BUDGET_MS = 5_000;
const INCIDENT_OBSERVATION_WINDOW_MS = 12_000;
const PRODUCER_PATH = "scripts/live-benchmark-evidence.mjs";
const FIRST_MAP_RUNTIME_SOURCES = [
  "examples/maplibre-quickstart/src/first-map-config.ts",
  "examples/maplibre-quickstart/src/workflow.ts",
];

class SkipTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkipTargetError";
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

async function withFirstMapRuntime(callback) {
  await mkdir(path.join(process.cwd(), "test-results"), { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(process.cwd(), "test-results/.first-map-runtime-"));
  try {
    const ts = (await import("typescript")).default;
    for (const sourcePath of FIRST_MAP_RUNTIME_SOURCES) {
      const source = await readFile(sourcePath, "utf8");
      const output = ts.transpileModule(source, {
        fileName: sourcePath,
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022,
          verbatimModuleSyntax: true,
        },
      }).outputText;
      await writeFile(path.join(runtimeRoot, `${path.basename(sourcePath, ".ts")}.mjs`), output, "utf8");
    }
    const nonce = `?run=${Date.now()}-${process.pid}`;
    const config = await import(`${pathToFileURL(path.join(runtimeRoot, "first-map-config.mjs")).href}${nonce}`);
    const workflow = await import(`${pathToFileURL(path.join(runtimeRoot, "workflow.mjs")).href}${nonce}`);
    return await callback({
      resolveFirstMapConfig: config.resolveFirstMapConfig,
      runFirstMapWorkflow: workflow.runFirstMapWorkflow,
    });
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function qualifyFirstMapProtocol(runtime, configuration, deadlineMs) {
  const map = new EvidenceMap();
  const requests = [];
  const controller = new AbortController();
  const deadlineMessage = `${configuration.protocol} First Map workflow deadline exceeded after ${deadlineMs} ms`;
  const timer = setTimeout(() => controller.abort(new DOMException(deadlineMessage, "TimeoutError")), deadlineMs);
  const anonymousFetch = async (input, init) => {
    const request = new Request(input, { ...init, signal: controller.signal });
    for (const name of ["authorization", "x-api-key"]) {
      if (request.headers.has(name)) throw new Error(`First Map workflow attempted credential header ${name}`);
    }
    const url = new URL(request.url);
    if (url.username || url.password) throw new Error("First Map workflow attempted URL credentials");
    requests.push(`${url.pathname}${url.search}`);
    return fetch(request);
  };
  let result;
  const startedAt = performance.now();
  try {
    result = await runtime.runFirstMapWorkflow(runtime.resolveFirstMapConfig(configuration), {
      map,
      fetchFn: anonymousFetch,
      signal: controller.signal,
    });
    if (result.state !== "ready") {
      const reason = result.state === "source-selection-required" ? result.reason : `${result.error.code}: ${result.error.message}`;
      throw new Error(`${configuration.protocol} First Map workflow did not become ready (${reason})`);
    }
    const runtimeMs = performance.now() - startedAt;
    const diagnostics = result.mounted.diagnostics;
    if (!(diagnostics.featureCount > 0) || !(diagnostics.geometryKinds?.length > 0)) {
      throw new Error(`${configuration.protocol} First Map workflow did not mount renderable geometry`);
    }
    if (runtimeMs > FIRST_MAP_RUNTIME_BUDGET_MS) {
      throw new Error(
        `${configuration.protocol} First Map workflow exceeded its ${FIRST_MAP_RUNTIME_BUDGET_MS} ms qualification budget`,
      );
    }
    return {
      protocol: result.view.connection.protocol,
      sourceId: result.view.source.id,
      strategy: result.mounted.strategy,
      featureCount: diagnostics.featureCount,
      geometryKinds: [...diagnostics.geometryKinds],
      layerCount: result.mounted.layerIds.length,
      queryLimit: configuration.maxFeatures,
      runtimeMs,
      budgetMs: FIRST_MAP_RUNTIME_BUDGET_MS,
      withinBudget: true,
      requestCount: requests.length,
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(deadlineMessage, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    if (result?.state === "ready") await result.dispose();
    if (map.sources.size !== 0 || map.layers.size !== 0) {
      throw new Error(`${configuration.protocol} First Map workflow did not clean up its mounted map resources`);
    }
  }
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

async function probeTarget(definition) {
  if (definition.skipReason) {
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
      ...(definition.realtimeFallback ? { realtime: definition.realtimeFallback } : {}),
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
        ...(definition.realtimeFallback ? { realtime: definition.realtimeFallback } : {}),
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
  return validateEvidenceEnvelope({
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: target.sampleId,
    lane: "live",
    status: executed ? "executed" : failed ? "failed" : "skipped",
    reason: executed ? null : target.error ?? target.skipReason ?? "Live target did not execute.",
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
      reasons: executed ? [] : [target.error ?? target.skipReason ?? "Live target did not execute."],
    },
    ...(target.realtime ? { realtime: target.realtime } : {}),
    artifacts: producerArtifact ? [producerArtifact] : [],
  });
}

export async function collectLiveEvidence(env = process.env, options = {}) {
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
        journeyId: "first-map-dual-protocol-bounded-query",
        status: "skipped",
        provider: "honua-demo",
        endpoint: "https://demo.honua.io",
        authMode: "anonymous",
        attribution: "Honua canonical demo data",
        skipReason: reason,
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
        realtime: {
          snapshotAt: null,
          cursor: null,
          lagMs: null,
          observationWindowMs: INCIDENT_OBSERVATION_WINDOW_MS,
          reconnectOutcome: "not-attempted-live-probes-disabled",
        },
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
  const firstMapDeadlineMs = options.firstMapDeadlineMs ?? FIRST_MAP_RUNTIME_BUDGET_MS;
  if (!Number.isSafeInteger(firstMapDeadlineMs) || firstMapDeadlineMs < 1 || firstMapDeadlineMs > TIMEOUT_MS) {
    throw new Error(`First Map workflow deadline must be an integer between 1 and ${TIMEOUT_MS} ms`);
  }

  const honuaBaseUrl = sanitizedBaseUrl(env.HONUA_BENCH_LIVE_BASE_URL ?? "https://demo.honua.io");
  const apiKey = env.HONUA_BENCH_LIVE_API_KEY;
  const authMode = apiKey ? "api-key" : "anonymous";
  const authHeaders = apiKey ? { "x-api-key": apiKey } : {};
  const awsBaseUrl = "https://earth-search.aws.element84.com/v1";
  const quickstartServiceId = env.HONUA_BENCH_LIVE_QUICKSTART_SERVICE_ID ?? "maui-parcels";
  const quickstartLayerId = Number(env.HONUA_BENCH_LIVE_QUICKSTART_LAYER_ID ?? "1");
  const quickstartOgcCollectionId =
    env.HONUA_BENCH_LIVE_QUICKSTART_OGC_COLLECTION_ID ?? String(quickstartLayerId);
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(quickstartServiceId)) {
    throw new Error("Quickstart live service id contains unsupported characters");
  }
  if (!Number.isInteger(quickstartLayerId) || quickstartLayerId < 0) {
    throw new Error("Quickstart live layer id must be a non-negative integer");
  }
  if (!/^[a-zA-Z0-9_.~-]+$/.test(quickstartOgcCollectionId)) {
    throw new Error("Quickstart live OGC collection id contains unsupported characters");
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
      realtimeFallback: {
        snapshotAt: null,
        cursor: null,
        lagMs: null,
        observationWindowMs: INCIDENT_OBSERVATION_WINDOW_MS,
        reconnectOutcome: "not-attempted-capability-unavailable",
      },
      async run() {
        const capabilitiesUrl = `${honuaBaseUrl}/api/v1/streaming/features/capabilities`;
        let capabilities;
        try {
          capabilities = await requestJson(capabilitiesUrl, authHeaders);
        } catch (error) {
          if (error instanceof HttpStatusError && [403, 404].includes(error.status)) {
            throw new SkipTargetError(`Realtime capability probe is unavailable (${error.message})`);
          }
          throw error;
        }
        const advertised = capabilities.body?.data ?? capabilities.body;
        if (advertised?.enabled !== true) {
          throw new SkipTargetError(
            `Realtime feature streams are not enabled${advertised?.minimumEdition ? `; requires ${advertised.minimumEdition}` : ""}`,
          );
        }
        const snapshotUrl = `${honuaBaseUrl}/rest/services/maui-incidents/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=10&f=json`;
        const snapshot = await requestJson(snapshotUrl, authHeaders);
        if (!Array.isArray(snapshot.body?.features)) throw new Error("Incident snapshot did not contain features");
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
      journeyId: "first-map-dual-protocol-bounded-query",
      provider: "honua-demo",
      endpoint: honuaBaseUrl,
      authMode: "anonymous",
      attribution: "Honua canonical demo data",
      skipReason: env.HONUA_BENCH_LIVE_SKIP_HONUA_REASON || undefined,
      async run() {
        const layerUrl = `${quickstartLayerUrl}?f=json`;
        const layer = await requestJson(layerUrl);
        if (layer.body?.error || layer.body?.id !== quickstartLayerId || typeof layer.body?.name !== "string") {
          throw new Error("Quickstart GeoServices layer metadata was unavailable or mismatched");
        }
        if (!(layer.body.capabilities ?? "").split(",").some((value) => value.trim().toLowerCase() === "query")) {
          throw new Error("Quickstart GeoServices layer did not advertise Query");
        }
        const queryUrl = `${quickstartLayerUrl}/query?where=1%3D1&outFields=*&resultRecordCount=1&f=json`;
        const query = await requestJson(queryUrl);
        if (query.body?.error || !Array.isArray(query.body?.features) || query.body.features.length < 1) {
          throw new Error("Quickstart GeoServices query did not return a bounded feature result");
        }
        const firstFeature = query.body.features[0];
        if (!firstFeature?.geometry || typeof firstFeature.geometry !== "object") {
          throw new Error("Quickstart GeoServices result did not contain renderable geometry");
        }

        const ogcLandingUrl = `${honuaBaseUrl}/ogc/features`;
        const ogcLanding = await requestJson(ogcLandingUrl);
        const landingLinks = Array.isArray(ogcLanding.body?.links) ? ogcLanding.body.links : [];
        if (!landingLinks.some((link) => link?.rel === "conformance")) {
          throw new Error("Quickstart OGC Features landing page did not advertise conformance");
        }
        const ogcConformanceUrl = `${ogcLandingUrl}/conformance`;
        const ogcConformance = await requestJson(ogcConformanceUrl);
        const conformsTo = Array.isArray(ogcConformance.body?.conformsTo)
          ? ogcConformance.body.conformsTo
          : [];
        if (
          !conformsTo.includes("http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core") ||
          !conformsTo.includes("http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson")
        ) {
          throw new Error("Quickstart OGC Features endpoint did not advertise Core and GeoJSON conformance");
        }
        const ogcCollectionsUrl = `${ogcLandingUrl}/collections`;
        const ogcCollections = await requestJson(ogcCollectionsUrl);
        const collection = Array.isArray(ogcCollections.body?.collections)
          ? ogcCollections.body.collections.find(
              (candidate) => String(candidate?.id) === quickstartOgcCollectionId,
            )
          : undefined;
        if (!collection || typeof collection.title !== "string") {
          throw new Error("Quickstart OGC Features collection was unavailable or mismatched");
        }
        if (collection.title !== layer.body.name) {
          throw new Error("Quickstart GeoServices layer and OGC Features collection did not identify the same source");
        }
        const ogcItemsUrl = `${ogcLandingUrl}/collections/${encodeURIComponent(quickstartOgcCollectionId)}/items?limit=1`;
        const ogcItems = await requestJson(ogcItemsUrl);
        if (
          ogcItems.body?.type !== "FeatureCollection" ||
          !Array.isArray(ogcItems.body?.features) ||
          ogcItems.body.features.length < 1
        ) {
          throw new Error("Quickstart OGC Features query did not return a bounded FeatureCollection");
        }
        const firstOgcFeature = ogcItems.body.features[0];
        if (!firstOgcFeature?.geometry || typeof firstOgcFeature.geometry !== "object") {
          throw new Error("Quickstart OGC Features result did not contain renderable geometry");
        }
        const healthProbeLatencyMs =
          layer.latencyMs +
          query.latencyMs +
          ogcLanding.latencyMs +
          ogcConformance.latencyMs +
          ogcCollections.latencyMs +
          ogcItems.latencyMs;
        const workflowExecutions = await withFirstMapRuntime(async (runtime) => [
          await qualifyFirstMapProtocol(runtime, {
            endpoint: quickstartLayerUrl,
            mode: "public-live",
            protocol: "geoservices-feature-service",
            sourceId: String(quickstartLayerId),
            maxFeatures: 1,
            query: { returnGeometry: true, pagination: { limit: 1 } },
          }, firstMapDeadlineMs),
          await qualifyFirstMapProtocol(runtime, {
            endpoint: ogcLandingUrl,
            mode: "public-live",
            protocol: "ogc-features",
            sourceId: quickstartOgcCollectionId,
            maxFeatures: 1,
            query: { returnGeometry: true, pagination: { limit: 1 } },
          }, firstMapDeadlineMs),
        ]);
        const workflowLatencyMs = workflowExecutions.reduce((total, execution) => total + execution.runtimeMs, 0);
        const totalLatencyMs = healthProbeLatencyMs + workflowLatencyMs;
        return {
          endpointVersion: null,
          protocolVersion: "geoservices-feature-service+ogc-api-features-1",
          latencyMs: totalLatencyMs,
          checks: {
            protocolsObserved: ["geoservices", "ogc-features"],
            sharedSourceTitle: layer.body.name,
            rawEndpointHealth: {
              kind: "availability-only",
              requestCount: 6,
              latencyMs: healthProbeLatencyMs,
              geoservices: {
                serviceId: quickstartServiceId,
                layerId: quickstartLayerId,
                geometryType: layer.body.geometryType ?? "unreported",
                returnedFeatureCount: query.body.features.length,
                renderableGeometry: true,
              },
              ogcFeatures: {
                collectionId: quickstartOgcCollectionId,
                coreConformance: true,
                geoJsonConformance: true,
                returnedFeatureCount: ogcItems.body.features.length,
                renderableGeometry: true,
              },
            },
            publicSdkWorkflowQualification: {
              kind: "connect-inspect-explain-bounded-query-mount",
              executions: workflowExecutions,
              cleanup: "verified-empty-map-host-after-each-execution",
            },
          },
          journey: {
            id: "first-map-dual-protocol-bounded-query",
            timeToFirstSuccessfulInteractionMs: totalLatencyMs,
            visibleOutcome: {
              kind: "dual-protocol-public-sdk-workflow-mounted-feature",
              itemCount: workflowExecutions.reduce((total, execution) => total + execution.featureCount, 0),
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
            observedAt: ogcItems.observedAt,
            serverDate: ogcItems.serverDate ?? query.serverDate,
            sourceDataTimestamp: null,
            etag: ogcItems.etag ?? layer.etag ?? query.etag,
            lastModified: ogcItems.lastModified ?? layer.lastModified ?? query.lastModified,
          },
          provenance: {
            source: `honua-demo:${quickstartServiceId}:${quickstartLayerId}:geoservices+ogc-features`,
            requestedUrls: [
              layerUrl,
              queryUrl,
              ogcLandingUrl,
              ogcConformanceUrl,
              ogcCollectionsUrl,
              ogcItemsUrl,
            ],
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
  const selection = selectedEvidence ? `${receiptSampleId}: ${selectedEvidence.status}; ` : "";
  process.stdout.write(
    `Live benchmark evidence: ${evidence.run.status}; ${selection}${evidence.targets.length} target(s); ${output}\n`,
  );
  for (const target of evidence.targets) {
    process.stdout.write(`  ${target.id}: ${target.status}${target.skipReason ? ` (${target.skipReason})` : ""}\n`);
  }
  if (options.strict && (selectedEvidence?.status ?? evidence.run.status) === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`live benchmark evidence failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
