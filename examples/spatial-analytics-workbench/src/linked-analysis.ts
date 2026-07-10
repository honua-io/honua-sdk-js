import { capabilities, createDataset } from "@honua/sdk-js/contract";
import type { Query, Result, Source, SourceDescriptor } from "@honua/sdk-js/contract";
import { HonuaClient, envelope } from "@honua/sdk-js/honua";
import {
  HonuaQueryPlanningError,
  canonicalStringify,
  executeQueryPlan,
  explainQuery,
  sha256,
  toJsonValue,
} from "@honua/sdk-js/query-planner";

import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";
import type {
  AnalyticsAoi,
  AnalyticsDataset,
  AnalyticsFeature,
  LinkedAnalysisContext,
  LinkedAnalysisController,
  LinkedAnalysisDataMode,
  LinkedAnalysisLane,
  LinkedAnalysisLiveConfig,
  LinkedAnalysisOutputArtifact,
  LinkedAnalysisProvenance,
} from "./types.js";

const CONTEXT_SCHEMA_VERSION = "honua.linked-analysis-context.v1";
const OUTPUT_SCHEMA_VERSION = "honua.linked-analysis-output.v1";
const FIXTURE_SOURCE_VERSION = "honolulu-exposure-fixture.v2";
const FIXTURE_SCHEMA_VERSION = "analytics-feature-schema.v2";
const FIXTURE_SOURCE_URL = "https://fixture.invalid/FeatureServer";
const FIXTURE_ATTRIBUTION = "Honua synthetic Honolulu exposure fixture; demonstration only.";
const LOCAL_MAX_ROWS = 64;
const UNSAFE_MAX_ROWS = 2;

export interface CreateLinkedAnalysisControllerOptions {
  readonly dataMode?: LinkedAnalysisDataMode;
  readonly live?: LinkedAnalysisLiveConfig;
  readonly now?: () => number;
}

export interface LinkedAnalysisEnvironment {
  readonly VITE_HONUA_SPATIAL_ANALYTICS_BASE_URL?: string;
  readonly VITE_HONUA_SPATIAL_ANALYTICS_SERVICE_ID?: string;
  readonly VITE_HONUA_SPATIAL_ANALYTICS_LAYER_ID?: string;
  readonly VITE_HONUA_SPATIAL_ANALYTICS_SOURCE_VERSION?: string;
  readonly VITE_HONUA_SPATIAL_ANALYTICS_SCHEMA_VERSION?: string;
}

export function createLinkedAnalysisController(
  dataset: AnalyticsDataset,
  options: CreateLinkedAnalysisControllerOptions = {},
): LinkedAnalysisController {
  const dataMode = options.dataMode ?? "fixture";
  const now = options.now ?? Date.now;

  return {
    dataMode,
    explain(lane, aoi, projection) {
      const matching = matchingFeatures(dataset.features, aoi, projection);
      const measuredFixtureBytes = new TextEncoder().encode(JSON.stringify(matching)).byteLength;
      const sourceWideEstimate =
        dataset.layers.find((layer) => layer.id === "parcels")?.featureCount ?? matching.length;
      const estimatedRows =
        lane === "unsafe-rejected" ? Math.max(matching.length, sourceWideEstimate) : matching.length;
      const estimateBytes =
        lane === "unsafe-rejected" ? Math.max(measuredFixtureBytes, estimatedRows * 240) : measuredFixtureBytes;
      const provenance = provenanceFor(dataMode, dataset, options.live, now);
      const unavailable = liveUnavailable(dataMode, options.live);
      if (unavailable) {
        return contextWithoutPlan({
          lane,
          dataMode,
          state: "skipped",
          aoi,
          projection,
          provenance,
          estimatedRows,
          estimatedBytes: estimateBytes,
          code: "live-config-unavailable",
          reason: unavailable,
        });
      }

      const descriptor = descriptorFor(lane, dataMode, options.live);
      try {
        const plan = explainQuery({
          descriptor,
          query: analysisQuery(aoi, projection),
          capabilityPolicy: lane === "remote-pushdown" ? "strict" : "degraded",
          fallback:
            lane === "remote-pushdown"
              ? { mode: "disabled" }
              : {
                  mode: "bounded-local",
                  maxRows: lane === "unsafe-rejected" ? UNSAFE_MAX_ROWS : LOCAL_MAX_ROWS,
                  maxBytes: 256_000,
                },
          estimates: { rows: estimatedRows, bytes: estimateBytes, requests: 1 },
          sourceVersion: provenance.sourceVersion,
          schemaVersion: provenance.schemaVersion,
          authorizationScope: ["data:read"],
        });
        return Object.freeze({
          schemaVersion: CONTEXT_SCHEMA_VERSION,
          id: `analysis_${plan.fingerprint.slice("sha256:".length, "sha256:".length + 16)}`,
          lane,
          dataMode,
          state: "estimate",
          aoiId: aoi.id,
          projection,
          plan,
          provenance,
          estimatedRows,
          estimatedBytes: estimateBytes,
        });
      } catch (error) {
        if (!(error instanceof HonuaQueryPlanningError)) throw error;
        return contextWithoutPlan({
          lane,
          dataMode,
          state: "rejected",
          aoi,
          projection,
          provenance,
          estimatedRows,
          estimatedBytes: estimateBytes,
          code: error.code,
          reason: error.message,
        });
      }
    },
    accept(context) {
      if (context.state === "rejected" || context.state === "skipped" || !context.plan) return context;
      return Object.freeze({ ...context, state: "accepted" });
    },
    async execute(context, signal) {
      if (context.state !== "accepted" || !context.plan) {
        throw new Error("Linked analysis requires one accepted plan before execution");
      }
      const startedAt = performance.now();
      const source =
        dataMode === "live"
          ? liveSource(context.plan.ir.source.id, context.lane, options.live)
          : fixtureSource(dataset, context, context.lane === "remote-pushdown");
      const execution = await executeQueryPlan(context.plan, source, {
        signal,
        sourceVersion: context.provenance.sourceVersion,
        schemaVersion: context.provenance.schemaVersion,
        authorizationScope: ["data:read"],
      });
      const executionMs = Math.max(0, performance.now() - startedAt);
      const observedAt = dataMode === "fixture" ? dataset.generatedAt : new Date(now()).toISOString();
      const provenance = {
        ...context.provenance,
        observedAt,
        observationState: dataMode === "fixture" ? ("replayed" as const) : ("live" as const),
      };
      const aggregateRows = execution.result.aggregateRows ?? [];
      const state =
        dataMode === "fixture" && context.lane === "remote-pushdown"
          ? "fixture-replay"
          : context.lane === "bounded-local"
            ? "executed-local"
            : "executed-remote";
      const outputArtifact: LinkedAnalysisOutputArtifact = {
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        id: `artifact_${context.plan.id}`,
        contextId: context.id,
        planId: context.plan.id,
        planFingerprint: context.plan.fingerprint,
        generatedAt: observedAt,
        aoiId: context.aoiId,
        aggregateRows,
        provenance,
      };
      return Object.freeze({
        ...context,
        state,
        provenance,
        executionMs,
        aggregateRows,
        outputArtifact,
      });
    },
  };
}

export function linkedAnalysisConfigFromLocation(
  location: Location,
  env: LinkedAnalysisEnvironment,
): {
  readonly dataMode: LinkedAnalysisDataMode;
  readonly live?: LinkedAnalysisLiveConfig;
} {
  const query = new URLSearchParams(location.search);
  const dataMode = query.get("mode") === "live" ? "live" : "fixture";
  if (dataMode === "fixture") return { dataMode };
  const rawLayerId = query.get("layerId") ?? env.VITE_HONUA_SPATIAL_ANALYTICS_LAYER_ID;
  const protocol = query.get("protocol") === "ogc-features" ? "ogc-features" : "geoservices-feature-service";
  return {
    dataMode,
    live: {
      protocol,
      baseUrl: query.get("baseUrl") ?? env.VITE_HONUA_SPATIAL_ANALYTICS_BASE_URL,
      serviceId: query.get("serviceId") ?? env.VITE_HONUA_SPATIAL_ANALYTICS_SERVICE_ID,
      layerId: rawLayerId !== undefined ? Number(rawLayerId) : undefined,
      sourceVersion: query.get("sourceVersion") ?? env.VITE_HONUA_SPATIAL_ANALYTICS_SOURCE_VERSION,
      schemaVersion: query.get("schemaVersion") ?? env.VITE_HONUA_SPATIAL_ANALYTICS_SCHEMA_VERSION,
    },
  };
}

function analysisQuery(aoi: AnalyticsAoi, projection: LinkedViewQueryProjection): Query<AnalyticsFeature> {
  const risk = projection.filters.risk?.value;
  return {
    where: typeof risk === "string" ? `risk = '${risk.replaceAll("'", "''")}'` : "1=1",
    spatialFilter: envelope(
      aoi.extent.xmin,
      aoi.extent.ymin,
      aoi.extent.xmax,
      aoi.extent.ymax,
      aoi.extent.spatialReference,
    ),
    aggregation: {
      groupBy: ["risk"],
      metrics: [
        { fn: "count", field: "OBJECTID", alias: "feature_count" },
        { fn: "avg", field: "score", alias: "average_score" },
      ],
    },
    orderBy: [{ field: "feature_count", direction: "desc" }],
    pagination: { offset: 0, limit: 10 },
    returnGeometry: false,
    outSr: 4326,
  };
}

function descriptorFor(
  lane: LinkedAnalysisLane,
  dataMode: LinkedAnalysisDataMode,
  live: LinkedAnalysisLiveConfig | undefined,
): SourceDescriptor {
  const remoteAggregation = lane === "remote-pushdown";
  const url = dataMode === "live" ? requireSafeLiveUrl(live?.baseUrl) : FIXTURE_SOURCE_URL;
  return {
    id: dataMode === "live" ? `live:${live?.serviceId}:layer:${live?.layerId}` : "fixture:honolulu-exposure",
    protocol: "geoservices-feature-service",
    locator: {
      url,
      serviceId: dataMode === "live" ? requireString(live?.serviceId, "serviceId") : "honolulu-exposure",
      layerId: dataMode === "live" ? requireLayerId(live?.layerId) : 0,
    },
    capabilities: capabilities(remoteAggregation ? ["query", "queryAggregate"] : ["query"]),
    schema: { primaryKey: "OBJECTID" },
    attribution:
      dataMode === "live" ? "Attribution supplied by the configured GeoServices source." : FIXTURE_ATTRIBUTION,
  };
}

function fixtureSource(
  dataset: AnalyticsDataset,
  context: LinkedAnalysisContext,
  remoteAggregation: boolean,
): Source<AnalyticsFeature> {
  if (!context.plan) throw new Error("Fixture source requires a plan");
  const descriptor = descriptorFor(context.lane, "fixture", undefined);
  const aoi = dataset.aois.find((entry) => entry.id === context.aoiId);
  if (!aoi) throw new Error(`Unknown AOI: ${context.aoiId}`);
  const matching = matchingFeatures(dataset.features, aoi, context.projection);
  const result: Result<AnalyticsFeature> = {
    features: matching.map((feature) => ({
      attributes: { ...feature, OBJECTID: feature.id },
      geometry: { x: feature.x, y: feature.y, spatialReference: { wkid: 4326 } },
    })),
    exceededTransferLimit: false,
  };
  return sourceStub(descriptor, {
    queryAll: async () => result,
    queryAggregate: async () => ({
      features: [],
      exceededTransferLimit: false,
      aggregateRows: remoteAggregation ? aggregateFixtureRows(matching) : [],
    }),
  });
}

function liveSource(
  sourceId: string,
  lane: LinkedAnalysisLane,
  live: LinkedAnalysisLiveConfig | undefined,
): Source<AnalyticsFeature> {
  const descriptor = descriptorFor(lane, "live", live);
  if (descriptor.id !== sourceId) throw new Error("Live source identity changed after plan acceptance");
  const client = new HonuaClient({ baseUrl: descriptor.locator.url });
  const dataset = createDataset({
    id: "spatial-analytics-live",
    client,
    sources: [descriptor],
    skipCompatibilityCheck: true,
  });
  const source = dataset.source<AnalyticsFeature>(descriptor.id);
  if (!source) throw new Error("Configured live GeoServices source could not be constructed");
  return source;
}

function sourceStub<T>(
  descriptor: SourceDescriptor,
  overrides: Pick<Source<T>, "queryAll" | "queryAggregate">,
): Source<T> {
  const unsupported = async (): Promise<never> => {
    throw new Error("Fixture Source operation is not part of the accepted linked-analysis plan");
  };
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    query: unsupported,
    queryAll: overrides.queryAll,
    queryAggregate: overrides.queryAggregate,
    queryExtent: unsupported,
    async *stream() {},
    queryObjectIds: unsupported,
    applyEdits: unsupported,
    queryRelated: unsupported,
    attachments: { query: unsupported, list: unsupported, add: unsupported, update: unsupported, delete: unsupported },
    protocol: () => undefined,
    adapter: () => undefined,
  };
}

function aggregateFixtureRows(features: readonly AnalyticsFeature[]): readonly Record<string, unknown>[] {
  const groups = new Map<string, AnalyticsFeature[]>();
  for (const feature of features) {
    const bucket = groups.get(feature.risk);
    if (bucket) bucket.push(feature);
    else groups.set(feature.risk, [feature]);
  }
  return Array.from(groups, ([risk, rows]) => ({
    risk,
    feature_count: rows.length,
    average_score: rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
  })).sort((left, right) => Number(right.feature_count) - Number(left.feature_count));
}

function matchingFeatures(
  features: readonly AnalyticsFeature[],
  aoi: AnalyticsAoi,
  projection: LinkedViewQueryProjection,
): AnalyticsFeature[] {
  const risk = projection.filters.risk?.value;
  return features.filter(
    (feature) =>
      feature.aoiIds.includes(aoi.id) &&
      (typeof risk !== "string" || feature.risk === risk) &&
      feature.x >= aoi.extent.xmin &&
      feature.x <= aoi.extent.xmax &&
      feature.y >= aoi.extent.ymin &&
      feature.y <= aoi.extent.ymax,
  );
}

function provenanceFor(
  dataMode: LinkedAnalysisDataMode,
  dataset: AnalyticsDataset,
  live: LinkedAnalysisLiveConfig | undefined,
  now: () => number,
): LinkedAnalysisProvenance {
  return {
    sourceId: dataMode === "fixture" ? "fixture:honolulu-exposure" : `live:${live?.serviceId}:layer:${live?.layerId}`,
    sourceUrl: dataMode === "fixture" ? null : safeDisplayUrl(live?.baseUrl),
    sourceVersion: dataMode === "fixture" ? FIXTURE_SOURCE_VERSION : (live?.sourceVersion ?? "unreported-live-version"),
    schemaVersion: dataMode === "fixture" ? FIXTURE_SCHEMA_VERSION : (live?.schemaVersion ?? "unreported-live-schema"),
    observedAt: dataMode === "fixture" ? dataset.generatedAt : new Date(now()).toISOString(),
    observationState: dataMode === "fixture" ? "replayed" : "live",
    attribution:
      dataMode === "fixture" ? FIXTURE_ATTRIBUTION : "Attribution supplied by the configured GeoServices source.",
    cacheDecision: "bypass",
  };
}

function liveUnavailable(
  dataMode: LinkedAnalysisDataMode,
  live: LinkedAnalysisLiveConfig | undefined,
): string | undefined {
  if (dataMode !== "live") return undefined;
  if (live?.protocol === "ogc-features") {
    return "OGC/CQL2 planner execution remains a #389 follow-on; this lane is a structured skip, not simulated execution.";
  }
  if (!live?.baseUrl || !live.serviceId || live.layerId === undefined || !Number.isInteger(live.layerId)) {
    return "Live GeoServices mode requires a public baseUrl, serviceId, and integer layerId; no fixture fallback was substituted.";
  }
  try {
    requireSafeLiveUrl(live.baseUrl);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function contextWithoutPlan(options: {
  lane: LinkedAnalysisLane;
  dataMode: LinkedAnalysisDataMode;
  state: "rejected" | "skipped";
  aoi: AnalyticsAoi;
  projection: LinkedViewQueryProjection;
  provenance: LinkedAnalysisProvenance;
  estimatedRows: number;
  estimatedBytes: number;
  code: LinkedAnalysisContext["rejection"] extends infer _
    ? NonNullable<LinkedAnalysisContext["rejection"]>["code"]
    : never;
  reason: string;
}): LinkedAnalysisContext {
  const digest = sha256(
    canonicalStringify(
      toJsonValue({
        lane: options.lane,
        mode: options.dataMode,
        aoiId: options.aoi.id,
        projection: options.projection,
      }),
    ),
  );
  return Object.freeze({
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    id: `analysis_${digest.slice("sha256:".length, "sha256:".length + 16)}`,
    lane: options.lane,
    dataMode: options.dataMode,
    state: options.state,
    aoiId: options.aoi.id,
    projection: options.projection,
    rejection: { code: options.code, reason: options.reason },
    provenance: options.provenance,
    estimatedRows: options.estimatedRows,
    estimatedBytes: options.estimatedBytes,
  });
}

function requireSafeLiveUrl(value: string | undefined): string {
  const url = new URL(requireString(value, "baseUrl"));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Live baseUrl must use http or https");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Live baseUrl must not contain credentials, query parameters, or fragments");
  }
  return url.toString().replace(/\/$/, "");
}

function safeDisplayUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return requireSafeLiveUrl(value);
  } catch {
    return null;
  }
}

function requireString(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Live ${name} is required`);
  return value;
}

function requireLayerId(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 0)
    throw new Error("Live layerId must be a non-negative integer");
  return value;
}
