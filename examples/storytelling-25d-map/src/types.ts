import type {
  GeoJsonGeometry,
  GeoJsonLineString,
  GeoJsonMultiLineString,
  GeoJsonMultiPolygon,
  GeoJsonPoint,
  GeoJsonPolygon,
} from "@honua/sdk-js/honua";

export type StoryFeatureId = string;
export type StoryCoordinate = [number, number];
export type StoryRiskBucket = "stable" | "guarded" | "high" | "severe";

export interface StoryBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  center: StoryCoordinate;
}

export interface StorySourceIds {
  assets: string;
  route: string;
  routeProgress: string;
  routeMarker: string;
  stops: string;
}

export interface StoryDemoCollections {
  assets: string;
  route: string;
  stops: string;
}

export interface StoryDemoConfig {
  honuaBaseUrl: string;
  apiKey?: string;
  basemapStyle: string;
  collections: StoryDemoCollections;
  sourceIds: StorySourceIds;
  priorityRiskThreshold: number;
  routeAnimationMs: number;
  initialPitch: number;
  initialBearing: number;
}

export interface StoryAssetProperties extends Record<string, unknown> {
  story_id: StoryFeatureId;
  name: string;
  district: string;
  status: string;
  summary: string;
  risk_score: number;
  risk_bucket: StoryRiskBucket;
  extrusion_height_m: number;
  priority_rank: number | null;
  linked_stop_id: StoryFeatureId | null;
}

export interface StoryRouteProperties extends Record<string, unknown> {
  story_id: StoryFeatureId;
  name: string;
  summary: string;
}

export interface StoryStopProperties extends Record<string, unknown> {
  story_id: StoryFeatureId;
  title: string;
  summary: string;
  sequence: number;
  linked_asset_id: StoryFeatureId | null;
}

export interface StoryAssetFeature {
  type: "Feature";
  id: StoryFeatureId;
  geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
  properties: StoryAssetProperties;
}

export interface StoryRouteFeature {
  type: "Feature";
  id: StoryFeatureId;
  geometry: GeoJsonLineString | GeoJsonMultiLineString;
  properties: StoryRouteProperties;
}

export interface StoryStopFeature {
  type: "Feature";
  id: StoryFeatureId;
  geometry: GeoJsonPoint;
  properties: StoryStopProperties;
}

export interface StoryFeatureCollection<TFeature> {
  type: "FeatureCollection";
  features: TFeature[];
}

export interface StoryAssetView {
  feature: StoryAssetFeature;
  bounds: StoryBounds;
  center: StoryCoordinate;
}

export interface StoryStopView {
  feature: StoryStopFeature;
}

export interface StorySummary {
  assetCount: number;
  priorityAssetCount: number;
  stopCount: number;
  routeLengthKm: number;
}

export interface StoryDataset {
  assets: StoryFeatureCollection<StoryAssetFeature>;
  assetViews: StoryAssetView[];
  route: StoryFeatureCollection<StoryRouteFeature>;
  routeFeature: StoryRouteFeature;
  routeCoordinates: StoryCoordinate[];
  stops: StoryFeatureCollection<StoryStopFeature>;
  stopViews: StoryStopView[];
  bounds: StoryBounds;
  priorityAssetIds: StoryFeatureId[];
  focusAssetId: StoryFeatureId;
  focusStopId: StoryFeatureId | undefined;
  summary: StorySummary;
}

export interface StoryRouteMetrics {
  coordinates: StoryCoordinate[];
  cumulativeMeters: number[];
  totalMeters: number;
}

export interface StoryTelemetryEvent {
  type:
    | "init"
    | "compatibility-ok"
    | "data-loaded"
    | "story-step-changed"
    | "route-playback-started"
    | "route-playback-finished"
    | "error";
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface StoryRuntimeState {
  currentStepId?: string;
  datasetSummary?: StorySummary;
  routeProgress?: number;
}

export type SupportedStoryGeometry =
  | GeoJsonGeometry
  | GeoJsonPoint
  | GeoJsonPolygon
  | GeoJsonMultiPolygon
  | GeoJsonLineString
  | GeoJsonMultiLineString;
