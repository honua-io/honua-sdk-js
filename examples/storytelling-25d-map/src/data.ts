import { HonuaClient, type HonuaOgcFeatureCollectionResponse, type HonuaOgcFeatureResponse } from "@honua/sdk-js/honua";

import { getBoundsForGeometry, flattenRouteCoordinates, buildRouteMetrics, mergeBounds } from "./geometry.js";
import type {
  StoryAssetFeature,
  StoryAssetProperties,
  StoryAssetView,
  StoryDataset,
  StoryDemoConfig,
  StoryFeatureCollection,
  StoryFeatureId,
  StoryRouteFeature,
  StoryRouteProperties,
  StoryStopFeature,
  StoryStopProperties,
} from "./types.js";
import type { StoryTelemetry } from "./telemetry.js";

const RISK_FIELDS = ["risk_score", "riskScore", "risk", "severity", "priority_score"];
const HEIGHT_FIELDS = ["extrusion_height_m", "height_m", "height", "heightMeters", "elevation_m", "elevation"];
const TITLE_FIELDS = ["title", "name", "asset_name", "assetName", "label"];
const DISTRICT_FIELDS = ["district", "zone", "area", "corridor"];
const STATUS_FIELDS = ["status", "inspection_status", "condition"];
const SUMMARY_FIELDS = ["summary", "description", "story", "note"];
const LINKED_STOP_FIELDS = ["linked_stop_id", "linkedStopId", "stop_id", "stopId"];

function asProperties(value: Record<string, unknown> | null): Record<string, unknown> {
  return value ?? {};
}

function readString(properties: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(properties: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  const floors = properties.floors;
  if (typeof floors === "number" && Number.isFinite(floors)) {
    return floors * 4;
  }
  if (typeof floors === "string" && floors.trim().length > 0) {
    const parsed = Number(floors);
    if (Number.isFinite(parsed)) {
      return parsed * 4;
    }
  }
  return undefined;
}

function getRiskBucket(riskScore: number): StoryAssetProperties["risk_bucket"] {
  if (riskScore >= 85) {
    return "severe";
  }
  if (riskScore >= 70) {
    return "high";
  }
  if (riskScore >= 45) {
    return "guarded";
  }
  return "stable";
}

function resolveFeatureId(
  feature: HonuaOgcFeatureResponse,
  properties: Record<string, unknown>,
  fallbackPrefix: string,
  index: number,
): StoryFeatureId {
  if (typeof feature.id === "string" && feature.id.trim().length > 0) {
    return feature.id.trim();
  }
  if (typeof feature.id === "number" && Number.isFinite(feature.id)) {
    return String(feature.id);
  }
  const candidate = readString(properties, ["story_id", "asset_id", "assetId", "id", "name", "title"]);
  return candidate ?? `${fallbackPrefix}-${index + 1}`;
}

export function normalizeAssets(
  collection: HonuaOgcFeatureCollectionResponse,
): { collection: StoryFeatureCollection<StoryAssetFeature>; views: StoryAssetView[] } {
  const features: StoryAssetFeature[] = [];
  const views: StoryAssetView[] = [];

  collection.features.forEach((feature, index) => {
    if (feature.geometry?.type !== "Polygon" && feature.geometry?.type !== "MultiPolygon") {
      return;
    }

    const properties = asProperties(feature.properties);
    const id = resolveFeatureId(feature, properties, "asset", index);
    const name = readString(properties, TITLE_FIELDS) ?? `Asset ${index + 1}`;
    const riskScore = readNumber(properties, RISK_FIELDS);
    const height = readNumber(properties, HEIGHT_FIELDS);

    if (riskScore === undefined) {
      throw new Error("Assets collection requires a numeric risk field such as risk_score or risk.");
    }
    if (height === undefined) {
      throw new Error(
        "Assets collection requires a numeric extrusion field such as extrusion_height_m, height_m, height, or floors.",
      );
    }

    const normalizedFeature: StoryAssetFeature = {
      type: "Feature",
      id,
      geometry: feature.geometry,
      properties: {
        story_id: id,
        name,
        district: readString(properties, DISTRICT_FIELDS) ?? "Operations corridor",
        status: readString(properties, STATUS_FIELDS) ?? "Review scheduled",
        summary:
          readString(properties, SUMMARY_FIELDS) ??
          `${name} is part of the current inspection corridor and carries elevated operational risk.`,
        risk_score: Number(riskScore.toFixed(1)),
        risk_bucket: getRiskBucket(riskScore),
        extrusion_height_m: Math.max(8, Number(height.toFixed(1))),
        priority_rank: null,
        linked_stop_id: readString(properties, LINKED_STOP_FIELDS) ?? null,
      },
    };

    const bounds = getBoundsForGeometry(normalizedFeature.geometry);
    features.push(normalizedFeature);
    views.push({
      feature: normalizedFeature,
      bounds,
      center: bounds.center,
    });
  });

  if (features.length < 1) {
    throw new Error("Assets collection did not contain any polygon features to extrude.");
  }

  return {
    collection: {
      type: "FeatureCollection",
      features,
    },
    views,
  };
}

export function normalizeRoute(collection: HonuaOgcFeatureCollectionResponse): StoryRouteFeature {
  const routeCandidate = collection.features.find(
    (feature) => feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString",
  );

  if (!routeCandidate || !routeCandidate.geometry) {
    throw new Error("Route collection did not contain a line feature for playback.");
  }

  const properties = asProperties(routeCandidate.properties);
  const id = resolveFeatureId(routeCandidate, properties, "route", 0);

  return {
    type: "Feature",
    id,
    geometry: routeCandidate.geometry as StoryRouteFeature["geometry"],
    properties: {
      story_id: id,
      name: readString(properties, ["title", "name", "route_name"]) ?? "Inspection route",
      summary:
        readString(properties, ["summary", "description"]) ??
        "Animated replay of the inspection corridor using the current Honua OGC delivery path.",
    },
  };
}

export function normalizeStops(collection: HonuaOgcFeatureCollectionResponse): StoryFeatureCollection<StoryStopFeature> {
  const features = collection.features
    .map((feature, index) => {
      if (feature.geometry?.type !== "Point") {
        return undefined;
      }

      const properties = asProperties(feature.properties);
      const id = resolveFeatureId(feature, properties, "stop", index);

      const normalized: StoryStopFeature = {
        type: "Feature",
        id,
        geometry: feature.geometry,
        properties: {
          story_id: id,
          title: readString(properties, ["title", "name", "stop_name"]) ?? `Stop ${index + 1}`,
          summary:
            readString(properties, ["summary", "description"]) ??
            "Deterministic stop used to anchor the replay sequence.",
          sequence: readNumber(properties, ["sequence", "seq", "order"]) ?? index + 1,
          linked_asset_id: readString(properties, ["linked_asset_id", "linkedAssetId", "asset_id", "assetId"]) ?? null,
        },
      };

      return normalized;
    })
    .filter((feature): feature is StoryStopFeature => Boolean(feature))
    .sort((left, right) => left.properties.sequence - right.properties.sequence);

  if (features.length < 1) {
    throw new Error("Stops collection did not contain any point features.");
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

export function buildStoryDataset(
  config: StoryDemoConfig,
  assetsCollection: HonuaOgcFeatureCollectionResponse,
  routeCollection: HonuaOgcFeatureCollectionResponse,
  stopsCollection: HonuaOgcFeatureCollectionResponse,
): StoryDataset {
  const { collection: assets, views: assetViews } = normalizeAssets(assetsCollection);
  const routeFeature = normalizeRoute(routeCollection);
  const routeCoordinates = flattenRouteCoordinates(routeFeature.geometry);
  const routeMetrics = buildRouteMetrics(routeCoordinates);
  const stops = normalizeStops(stopsCollection);
  const stopViews = stops.features.map((feature) => ({ feature }));

  const priorityCandidates = [...assetViews]
    .sort((left, right) => right.feature.properties.risk_score - left.feature.properties.risk_score)
    .filter((entry) => entry.feature.properties.risk_score >= config.priorityRiskThreshold);
  const priorityViews = (priorityCandidates.length > 0 ? priorityCandidates : [...assetViews].sort(
    (left, right) => right.feature.properties.risk_score - left.feature.properties.risk_score,
  )).slice(0, Math.min(3, assetViews.length));

  priorityViews.forEach((entry, index) => {
    entry.feature.properties.priority_rank = index + 1;
  });

  const focusAsset = priorityViews[0] ?? assetViews[0];
  const focusStop =
    resolveLinkedStop(stops.features, focusAsset.feature.properties.linked_stop_id) ??
    stops.features.find((feature) => feature.properties.linked_asset_id === focusAsset.feature.id);

  const allBounds = mergeBounds([
    ...assetViews.map((entry) => entry.bounds),
    getBoundsForGeometry(routeFeature.geometry),
    ...stops.features.map((feature) => getBoundsForGeometry(feature.geometry)),
  ]);

  return {
    assets,
    assetViews,
    route: {
      type: "FeatureCollection",
      features: [routeFeature],
    },
    routeFeature,
    routeCoordinates,
    stops,
    stopViews,
    bounds: allBounds,
    priorityAssetIds: priorityViews.map((entry) => entry.feature.id),
    focusAssetId: focusAsset.feature.id,
    focusStopId: focusStop?.id,
    summary: {
      assetCount: assets.features.length,
      priorityAssetCount: priorityViews.length,
      stopCount: stops.features.length,
      routeLengthKm: Number((routeMetrics.totalMeters / 1_000).toFixed(2)),
    },
  };
}

function resolveLinkedStop(
  stops: readonly StoryStopFeature[],
  linkedStopId: StoryFeatureId | null,
): StoryStopFeature | undefined {
  if (!linkedStopId) {
    return undefined;
  }

  return stops.find((feature) => feature.id === linkedStopId || feature.properties.story_id === linkedStopId);
}

function createCollectionLoadError(label: string, collectionId: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to load the ${label} collection "${collectionId}" from OGC API Features: ${detail}`);
}

export function formatCompatibilityError(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.join(" ") : "The Honua compatibility contract rejected this server.";
}

export interface LoadStoryDatasetOptions {
  fetchFn?: typeof fetch;
  telemetry?: StoryTelemetry;
}

export async function loadStoryDataset(
  config: StoryDemoConfig,
  options: LoadStoryDatasetOptions = {},
): Promise<StoryDataset> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const client = new HonuaClient({
    baseUrl: config.honuaBaseUrl,
    apiKey: config.apiKey,
    fetchFn,
  });

  const compatibility = await client.checkCompatibility();
  if (!compatibility.supported) {
    throw new Error(formatCompatibilityError(compatibility.reasons));
  }

  options.telemetry?.emit("compatibility-ok", {
    serverVersion: compatibility.compatibility?.serverVersion ?? "unknown",
    releaseChannel: compatibility.compatibility?.releaseChannel ?? "unknown",
    baseUrl: config.honuaBaseUrl || "same-origin",
  });

  const ogc = client.ogcFeatures();

  const loadCollection = async (label: string, collectionId: string) => {
    try {
      return await ogc.collection(collectionId).items({ limit: 250 });
    } catch (error) {
      throw createCollectionLoadError(label, collectionId, error);
    }
  };

  const [assets, route, stops] = await Promise.all([
    loadCollection("assets", config.collections.assets),
    loadCollection("route", config.collections.route),
    loadCollection("stops", config.collections.stops),
  ]);

  const dataset = buildStoryDataset(config, assets, route, stops);
  options.telemetry?.emit("data-loaded", {
    assetCount: dataset.summary.assetCount,
    priorityAssetCount: dataset.summary.priorityAssetCount,
    stopCount: dataset.summary.stopCount,
    routeLengthKm: dataset.summary.routeLengthKm,
    collections: config.collections,
  });
  options.telemetry?.setSummary(dataset.summary);
  return dataset;
}
