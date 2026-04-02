import { HonuaClient, type HonuaQueryResponse } from "@honua/sdk-js/honua";

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

export interface QuickstartDataset {
  compatibility: QuickstartCompatibilitySummary;
  queryResponse: HonuaQueryResponse;
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
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function describeGeometry(kind: QuickstartRenderableGeometryType | undefined): string {
  if (kind === "polygon") {
    return "Polygon feature";
  }
  if (kind === "line") {
    return "Line feature";
  }
  if (kind === "point") {
    return "Point feature";
  }
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

function createQueryLoadError(serviceId: string, layerId: number, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to query service "${serviceId}" layer ${layerId}: ${detail}`);
}

export function formatCompatibilityError(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.join(" ") : "The Honua compatibility contract rejected this server.";
}

export function buildQuickstartDataset(
  config: QuickstartConfig,
  compatibility: QuickstartCompatibilitySummary,
  queryResponse: HonuaQueryResponse,
  queryDurationMs: number,
): QuickstartDataset {
  const featureCount = queryResponse.features?.length ?? 0;
  if (featureCount < 1) {
    throw new Error(
      `The feature query returned no features for service "${config.serviceId}" layer ${config.layerId}.`,
    );
  }

  const geojson = convertEsriFeaturesToGeoJson(queryResponse.features ?? []);
  const featureSummaries = geojson.features.map(createFeatureSummary);
  const renderableFeatures = featureSummaries.filter((summary) => Boolean(summary.geometryKind));
  const renderableFeatureCount = renderableFeatures.length;

  if (renderableFeatureCount < 1) {
    throw new Error(`The feature query returned ${featureCount} feature(s), but none included renderable geometry.`);
  }

  const renderableCollection: QuickstartGeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: renderableFeatures.map((summary) => summary.feature),
  };

  return {
    compatibility,
    queryResponse,
    geojson: renderableCollection,
    featureSummaries: renderableFeatures,
    featureCount,
    renderableFeatureCount,
    geometryTypes: summarizeRenderableGeometryTypes(renderableCollection),
    bounds: getCollectionBounds(renderableCollection),
    queryDurationMs,
  };
}

export interface LoadQuickstartDatasetOptions {
  fetchFn?: typeof fetch;
  telemetry?: QuickstartTelemetry;
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

  options.telemetry?.patchRuntime({
    baseUrl: config.honuaBaseUrl || "same-origin",
    serviceId: config.serviceId,
    layerId: config.layerId,
  });

  const compatibilityStatus = await client.checkCompatibility();
  if (!compatibilityStatus.supported) {
    throw new Error(formatCompatibilityError(compatibilityStatus.reasons));
  }

  const compatibility = createCompatibilitySummary(compatibilityStatus);
  options.telemetry?.emit("compatibility-ok", {
    serverVersion: compatibility.serverVersion,
    releaseChannel: compatibility.releaseChannel,
    baseUrl: config.honuaBaseUrl || "same-origin",
  });
  options.telemetry?.patchRuntime({
    serverVersion: compatibility.serverVersion,
    releaseChannel: compatibility.releaseChannel,
  });

  options.telemetry?.emit("query-started", {
    serviceId: config.serviceId,
    layerId: config.layerId,
    where: config.where,
    resultRecordCount: config.resultRecordCount,
  });

  const queryStartedAt = Date.now();
  let queryResponse: HonuaQueryResponse;

  try {
    queryResponse = await client.queryFeatures({
      serviceId: config.serviceId,
      layerId: config.layerId,
      where: config.where,
      returnGeometry: true,
      outFields: ["*"],
      outSr: 4326,
      resultRecordCount: config.resultRecordCount,
    });
  } catch (error) {
    throw createQueryLoadError(config.serviceId, config.layerId, error);
  }

  const dataset = buildQuickstartDataset(config, compatibility, queryResponse, Date.now() - queryStartedAt);
  options.telemetry?.emit("query-finished", {
    serviceId: config.serviceId,
    layerId: config.layerId,
    featureCount: dataset.featureCount,
    renderableFeatureCount: dataset.renderableFeatureCount,
    geometryTypes: dataset.geometryTypes,
    queryDurationMs: dataset.queryDurationMs,
  });
  options.telemetry?.patchRuntime({
    featureCount: dataset.featureCount,
    renderableFeatureCount: dataset.renderableFeatureCount,
    geometryTypes: dataset.geometryTypes,
    queryDurationMs: dataset.queryDurationMs,
  });

  return dataset;
}
