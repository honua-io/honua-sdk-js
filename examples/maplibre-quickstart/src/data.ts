import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  createDataset,
  type Query,
  type Result,
  type SourceDescriptor,
} from "@honua/sdk-js/contract";
import { HonuaClient, type HonuaLayerMetadata, type HonuaTypedQueryResponse } from "@honua/sdk-js/honua";
import {
  executeQueryPlan,
  explainQuery,
  type QueryExecutionPlanV1,
} from "@honua/sdk-js/query-planner";

import type { QuickstartConfig } from "./config.js";
import {
  type QuickstartBounds,
  type QuickstartGeoJsonFeature,
  type QuickstartGeoJsonFeatureCollection,
  type QuickstartRenderableGeometryType,
  convertEsriFeaturesToGeoJson,
  getCollectionBounds,
  getFeatureCenter,
  getGeometryKind,
  summarizeRenderableGeometryTypes,
} from "./esri-geojson.js";
import type { QuickstartTelemetry } from "./telemetry.js";

declare const __HONUA_SDK_VERSION__: string;

export type QuickstartJourneyStageId = "connect" | "discover" | "explain" | "query" | "mount";

export interface QuickstartJourneyStage {
  id: QuickstartJourneyStageId;
  label: string;
  detail: string;
  durationMs: number;
  status: "complete" | "pending" | "error";
}

export interface QuickstartCompatibilitySummary {
  serverVersion: string;
  releaseChannel: string;
}

export interface QuickstartFeatureSummary {
  id: string;
  title: string;
  subtitle: string;
  center?: [number, number];
  geometryKind?: QuickstartRenderableGeometryType;
  feature: QuickstartGeoJsonFeature;
}

export interface QuickstartEvidence {
  mode: "fixture" | "live";
  auth: "none" | "anonymous" | "server-side-api-key" | "server-side-bearer";
  endpoint: string;
  source: string;
  protocol: "geoservices-feature-service";
  sdkVersion: string;
  serverVersion: string;
  dataVersion: string;
  observedAt: string;
  capturedAt?: string;
  freshness: string;
  metadataCache: string;
  capabilities: string[];
  degradation: string[];
}

export interface QuickstartDataset {
  compatibility: QuickstartCompatibilitySummary;
  metadata: HonuaLayerMetadata;
  descriptor: SourceDescriptor;
  query: Query;
  plan: QueryExecutionPlanV1;
  queryResponse: HonuaTypedQueryResponse;
  result: Result;
  evidence: QuickstartEvidence;
  journey: QuickstartJourneyStage[];
  geojson: QuickstartGeoJsonFeatureCollection;
  featureSummaries: QuickstartFeatureSummary[];
  featureCount: number;
  renderableFeatureCount: number;
  geometryTypes: QuickstartRenderableGeometryType[];
  bounds?: QuickstartBounds;
  queryDurationMs: number;
}

const TITLE_FIELDS = ["NAME", "TITLE", "name", "title", "LABEL", "label"];
const SUBTITLE_FIELDS = ["STATUS", "CATEGORY", "status", "category", "TYPE", "type"];

function readString(properties: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function describeGeometry(kind: QuickstartRenderableGeometryType | undefined): string {
  if (kind === "polygon") return "Polygon feature";
  if (kind === "line") return "Line feature";
  if (kind === "point") return "Point feature";
  return "Feature without renderable geometry";
}

function createFeatureSummary(feature: QuickstartGeoJsonFeature, index: number): QuickstartFeatureSummary {
  const properties = feature.properties ?? {};
  const geometryKind = getGeometryKind(feature.geometry);
  return {
    id: feature.id,
    title: readString(properties, TITLE_FIELDS) ?? `Feature ${index + 1}`,
    subtitle: readString(properties, SUBTITLE_FIELDS) ?? describeGeometry(geometryKind),
    center: getFeatureCenter(feature),
    geometryKind,
    feature,
  };
}

function createCompatibilitySummary(
  status: Awaited<ReturnType<HonuaClient["checkCompatibility"]>>,
): QuickstartCompatibilitySummary {
  return {
    serverVersion: status.compatibility?.serverVersion ?? "unknown",
    releaseChannel: status.compatibility?.releaseChannel ?? "unknown",
  };
}

function sdkVersion(): string {
  return typeof __HONUA_SDK_VERSION__ === "string" ? __HONUA_SDK_VERSION__ : "development";
}

function safeEndpoint(baseUrl: string): string {
  if (!baseUrl) return "same-origin fixture server";
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return "configured live endpoint";
  }
}

function authentication(config: QuickstartConfig): QuickstartEvidence["auth"] {
  if (config.bearerToken) return "server-side-bearer";
  if (config.apiKey) return "server-side-api-key";
  return config.mode === "fixture" ? "none" : "anonymous";
}

function stage(
  id: QuickstartJourneyStageId,
  detail: string,
  durationMs: number,
): QuickstartJourneyStage {
  return {
    id,
    label: id[0]?.toUpperCase() + id.slice(1),
    detail,
    durationMs,
    status: "complete",
  };
}

async function measure<T>(action: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const startedAt = performance.now();
  const value = await action();
  return { value, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) };
}

function createDescriptor(config: QuickstartConfig, metadata: HonuaLayerMetadata): SourceDescriptor {
  return {
    id: config.sourceId,
    protocol: "geoservices-feature-service",
    locator: {
      url: config.honuaBaseUrl,
      serviceId: config.serviceId,
      layerId: config.layerId,
    },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    schema: {
      fields: metadata.fields,
      primaryKey: metadata.fields?.find((field) => field.type === "esriFieldTypeOID")?.name,
    },
    attribution: config.mode === "fixture" ? "Honua deterministic review fixture" : metadata.name,
    analytics: {
      freshness: config.mode === "fixture" ? { mode: "snapshot" } : { mode: "watermark" },
    },
  };
}

function toTypedQueryResponse(result: Result, metadata: HonuaLayerMetadata): HonuaTypedQueryResponse {
  return {
    features: [...result.features],
    exceededTransferLimit: result.exceededTransferLimit,
    fields: result.fields ? [...result.fields] : metadata.fields,
    geometryType: metadata.geometryType,
    spatialReference: metadata.spatialReference,
  };
}

export function formatCompatibilityError(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.join(" ") : "The Honua compatibility contract rejected this server.";
}

export function buildQuickstartDataset(options: {
  config: QuickstartConfig;
  compatibility: QuickstartCompatibilitySummary;
  metadata: HonuaLayerMetadata;
  descriptor: SourceDescriptor;
  query: Query;
  plan: QueryExecutionPlanV1;
  result: Result;
  journey: QuickstartJourneyStage[];
  queryDurationMs: number;
  observedAt?: string;
}): QuickstartDataset {
  const { config, compatibility, metadata, descriptor, query, plan, result, journey, queryDurationMs } = options;
  const featureCount = result.features.length;
  if (featureCount < 1) {
    throw new Error(`The feature query returned no features for service "${config.serviceId}" layer ${config.layerId}.`);
  }

  const queryResponse = toTypedQueryResponse(result, metadata);
  const geojson = convertEsriFeaturesToGeoJson(queryResponse.features ?? []);
  const featureSummaries = geojson.features.map(createFeatureSummary);
  const renderableFeatures = featureSummaries.filter((summary) => Boolean(summary.geometryKind));
  if (renderableFeatures.length < 1) {
    throw new Error(`The feature query returned ${featureCount} feature(s), but none included renderable geometry.`);
  }

  const renderableCollection: QuickstartGeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: renderableFeatures.map((summary) => summary.feature),
  };
  const observedAt = options.observedAt ?? new Date().toISOString();
  const degradation = [
    ...plan.warnings,
    ...(result.degraded?.map((reason) => reason.reason) ?? []),
  ];
  if (degradation.length === 0) degradation.push("None — exact remote pushdown");

  return {
    compatibility,
    metadata,
    descriptor,
    query,
    plan,
    queryResponse,
    result,
    journey,
    geojson: renderableCollection,
    featureSummaries: renderableFeatures,
    featureCount,
    renderableFeatureCount: renderableFeatures.length,
    geometryTypes: summarizeRenderableGeometryTypes(renderableCollection),
    bounds: getCollectionBounds(renderableCollection),
    queryDurationMs,
    evidence: {
      mode: config.mode,
      auth: authentication(config),
      endpoint: safeEndpoint(config.honuaBaseUrl),
      source: `${config.serviceId}/${config.layerId}`,
      protocol: "geoservices-feature-service",
      sdkVersion: sdkVersion(),
      serverVersion: compatibility.serverVersion,
      dataVersion: config.dataVersion,
      observedAt,
      capturedAt: config.capturedAt,
      freshness:
        config.mode === "fixture"
          ? `snapshot captured ${config.capturedAt ?? "at an unspecified time"}`
          : metadata.cache?.sourceUpdatedAt
            ? `source updated ${metadata.cache.sourceUpdatedAt}`
            : `live response observed ${observedAt}`,
      metadataCache: metadata.cache?.status ?? "not reported",
      capabilities: [...descriptor.capabilities].sort(),
      degradation,
    },
  };
}

export interface LoadQuickstartDatasetOptions {
  fetchFn?: typeof fetch;
  telemetry?: QuickstartTelemetry;
  now?: () => string;
}

export async function loadQuickstartDataset(
  config: QuickstartConfig,
  options: LoadQuickstartDatasetOptions = {},
): Promise<QuickstartDataset> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const client = new HonuaClient({
    baseUrl: config.honuaBaseUrl,
    apiKey: config.apiKey,
    bearerToken: config.bearerToken,
    fetchFn,
  });
  const journey: QuickstartJourneyStage[] = [];

  options.telemetry?.patchRuntime({
    mode: config.mode,
    baseUrl: safeEndpoint(config.honuaBaseUrl),
    serviceId: config.serviceId,
    layerId: config.layerId,
  });

  const connected = await measure(() => client.checkCompatibility());
  if (!connected.value.supported) throw new Error(formatCompatibilityError(connected.value.reasons));
  const compatibility = createCompatibilitySummary(connected.value);
  journey.push(stage("connect", `Honua ${compatibility.serverVersion} accepted`, connected.durationMs));

  const discovered = await measure(() => client.getLayerMetadata(config.serviceId, config.layerId));
  const metadata = discovered.value;
  journey.push(
    stage(
      "discover",
      `${metadata.name} · ${metadata.fields?.length ?? 0} fields · ${metadata.geometryType ?? "unknown geometry"}`,
      discovered.durationMs,
    ),
  );

  const descriptor = createDescriptor(config, metadata);
  const dataset = createDataset({
    id: `${config.serviceId}/${config.layerId}`,
    client,
    sources: [descriptor],
    skipCompatibilityCheck: true,
  });
  const source = dataset.source(config.sourceId);
  if (!source) throw new Error(`Could not resolve source "${config.sourceId}".`);
  const query: Query = {
    where: config.where,
    outFields: ["*"],
    returnGeometry: true,
    outSr: 4326,
    pagination: { limit: config.resultRecordCount },
  };

  const explainStartedAt = performance.now();
  const plan = explainQuery({
    descriptor,
    query,
    sourceVersion: config.dataVersion,
    authorizationScope: [],
    estimates: { rows: config.resultRecordCount, requests: 1 },
  });
  journey.push(stage("explain", `${plan.pushdown} pushdown · ${plan.fidelity} fidelity`, Math.round(performance.now() - explainStartedAt)));

  options.telemetry?.emit("plan-explained", {
    planId: plan.id,
    fingerprint: plan.fingerprint,
    pushdown: plan.pushdown,
    fidelity: plan.fidelity,
    steps: plan.steps.length,
  });

  const executed = await measure(() =>
    executeQueryPlan(plan, source, {
      sourceVersion: config.dataVersion,
      authorizationScope: [],
    }),
  );
  journey.push(stage("query", `${executed.value.result.features.length} rows returned`, executed.durationMs));

  const quickstartDataset = buildQuickstartDataset({
    config,
    compatibility,
    metadata,
    descriptor,
    query,
    plan,
    result: executed.value.result,
    journey,
    queryDurationMs: executed.durationMs,
    observedAt: options.now?.(),
  });
  options.telemetry?.patchRuntime({
    serverVersion: compatibility.serverVersion,
    releaseChannel: compatibility.releaseChannel,
    sdkVersion: quickstartDataset.evidence.sdkVersion,
    dataVersion: config.dataVersion,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    planPushdown: plan.pushdown,
    featureCount: quickstartDataset.featureCount,
    renderableFeatureCount: quickstartDataset.renderableFeatureCount,
    geometryTypes: quickstartDataset.geometryTypes,
    queryDurationMs: quickstartDataset.queryDurationMs,
  });
  options.telemetry?.emit("query-finished", {
    featureCount: quickstartDataset.featureCount,
    renderableFeatureCount: quickstartDataset.renderableFeatureCount,
    queryDurationMs: quickstartDataset.queryDurationMs,
    planId: plan.id,
  });
  return quickstartDataset;
}
