import type { HonuaSourceCacheStatus } from "@honua/sdk-js/app-workspace";
import type {
  EsriGeometryType,
  HonuaCacheState,
  HonuaExtent,
  HonuaFeature,
  HonuaFieldInfo,
  HonuaLayerMetadata,
  HonuaServiceMetadata,
} from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

export type ServiceExplorerDataMode = "auto" | "cloud" | "fixture";
export type ServiceExplorerDataSource = "cloud" | "fixture";
export type ServiceExplorerDiagnosticLevel = "info" | "warning" | "error";
export type ServiceExplorerProtocol =
  | "Honua gRPC"
  | "FeatureServer"
  | "MapServer"
  | "ImageServer"
  | "Geometry Service"
  | "GP Service"
  | "OGC Features"
  | "OGC Tiles"
  | "OGC Maps"
  | "OGC Records"
  | "STAC"
  | "WFS"
  | "WMS"
  | "WMTS"
  | "OData"
  | "MapLibre Vector"
  | "MapLibre Raster"
  | "MapLibre GeoJSON";
export type ServiceExplorerCapabilityStatus = "supported" | "degraded" | "unsupported";
export type ServiceExplorerSourceMode = "queryable" | "render-only" | "degraded";

export interface ServiceExplorerConfig {
  readonly honuaBaseUrl: string;
  readonly apiKey?: string;
  readonly bearerToken?: string;
  readonly mode: ServiceExplorerDataMode;
  readonly serviceId: string;
  readonly layerId: number;
  readonly where: string;
  readonly resultRecordCount: number;
  readonly mapMoveDebounceMs: number;
  readonly selectedSourceId?: string;
}

export interface ServiceExplorerDiagnostic {
  readonly level: ServiceExplorerDiagnosticLevel;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly sourceId?: string;
}

export interface ServiceExplorerCapabilitySummary {
  readonly query: ServiceExplorerCapabilityStatus;
  readonly render: ServiceExplorerCapabilityStatus;
  readonly table: ServiceExplorerCapabilityStatus;
  readonly metadata: ServiceExplorerCapabilityStatus;
  readonly extent: ServiceExplorerCapabilityStatus;
  readonly statistics: ServiceExplorerCapabilityStatus;
  readonly attachments: ServiceExplorerCapabilityStatus;
  readonly find: ServiceExplorerCapabilityStatus;
}

export interface ServiceExplorerServiceSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly layerCount?: number;
  readonly description?: string;
  readonly status?: "available" | "degraded" | "unsupported";
  readonly protocol?: ServiceExplorerProtocol;
}

export interface ServiceExplorerLayerSummary {
  readonly id: number;
  readonly name: string;
  readonly serviceId: string;
  readonly serviceType: ServiceExplorerProtocol;
  readonly geometryType?: EsriGeometryType;
  readonly sourceId: string;
}

export interface ServiceExplorerSourceOption {
  readonly id: string;
  readonly name: string;
  readonly protocol: ServiceExplorerProtocol;
  readonly mode: ServiceExplorerSourceMode;
  readonly serviceId: string;
  readonly layerId?: number;
  readonly sourceId: string;
  readonly description: string;
  readonly cachePolicy: string;
  readonly capabilities: ServiceExplorerCapabilitySummary;
}

export interface ServiceExplorerCatalog {
  readonly sources: readonly ServiceExplorerSourceOption[];
  readonly services: readonly ServiceExplorerServiceSummary[];
  readonly layersByServiceId: Readonly<Record<string, readonly ServiceExplorerLayerSummary[]>>;
}

export interface ServiceExplorerCacheInfo {
  readonly status: HonuaSourceCacheStatus;
  readonly state: HonuaCacheState;
  readonly source: ServiceExplorerDataSource;
  readonly updatedAt: number;
  readonly revalidateAfterMs: number;
  readonly lastRevalidatedAt?: number;
}

export interface ServiceExplorerSourceMetadata {
  readonly service: ServiceExplorerServiceSummary;
  readonly layer: ServiceExplorerLayerSummary;
  readonly schema: HonuaLayerMetadata;
  readonly serviceMetadata?: HonuaServiceMetadata;
  readonly capabilities: ServiceExplorerCapabilitySummary;
  readonly cache: ServiceExplorerCacheInfo;
  readonly diagnostics: readonly ServiceExplorerDiagnostic[];
}

export interface ServiceExplorerDataset {
  readonly catalog: ServiceExplorerCatalog;
  readonly sourceId: string;
  readonly sourceOption: ServiceExplorerSourceOption;
  readonly source: ServiceExplorerDataSource;
  readonly metadata: ServiceExplorerSourceMetadata;
  readonly features: readonly HonuaFeature[];
  readonly featureSummaries: readonly ServiceExplorerFeatureSummary[];
  readonly diagnostics: readonly ServiceExplorerDiagnostic[];
  readonly queryDurationMs: number;
}

export interface ServiceExplorerFeatureSummary {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly geometryType: "point" | "line" | "polygon" | "unsupported";
  readonly coordinate?: readonly [number, number];
  readonly feature: HonuaFeature;
}

export interface ServiceExplorerPointFeature {
  readonly type: "Feature";
  readonly id: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: {
    readonly type: "Point";
    readonly coordinates: readonly [number, number];
  };
}

export interface ServiceExplorerFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: readonly ServiceExplorerPointFeature[];
}

export interface ServiceExplorerProjectionResult {
  readonly projection: LinkedViewQueryProjection;
  readonly matchedRows: readonly ServiceExplorerFeatureSummary[];
  readonly rows: readonly ServiceExplorerFeatureSummary[];
  readonly totalMatched: number;
  readonly visibleCount: number;
}

export interface ServiceExplorerChartBucket {
  readonly field: string;
  readonly value: string;
  readonly count: number;
  readonly selected: boolean;
}

export interface ServiceExplorerChartModel {
  readonly field: string;
  readonly buckets: readonly ServiceExplorerChartBucket[];
  readonly total: number;
}

export interface ServiceExplorerFilterOption {
  readonly field: string;
  readonly values: readonly string[];
}

export interface ServiceExplorerQueryDiagnostics {
  readonly where: string;
  readonly outFields: readonly string[];
  readonly orderBy: readonly string[];
  readonly resultOffset?: number;
  readonly resultRecordCount?: number;
  readonly extent?: HonuaExtent;
  readonly filterIds: readonly string[];
}

export type ServiceExplorerField = HonuaFieldInfo;
