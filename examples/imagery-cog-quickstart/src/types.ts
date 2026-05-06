import type { SourceDescriptor } from "@honua/sdk-js/contract";
import type { HonuaExportMapResponse, HonuaLegendResponse, HonuaServiceMetadata } from "@honua/sdk-js/honua";

export type ImageryAccessPath = "wms-getmap" | "image-server-tile" | "image-server-export";

export type ImageryCacheStatus = "ready" | "stale" | "bypass";

export interface ImageryExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface ImageryCacheNote {
  readonly status: ImageryCacheStatus;
  readonly source: "honua-metadata" | "fixture" | "not-cached";
  readonly updatedAt: string;
  readonly ttlMs?: number;
}

export interface ImageryLayerDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly serviceId: string;
  readonly layerName: string;
  readonly accessPath: ImageryAccessPath;
  readonly sourceAsset: string;
  readonly auditCapability: "ImageServer" | "WMS";
  readonly endpointPath: string;
  readonly defaultOpacity: number;
  readonly visible: boolean;
  readonly extent: ImageryExtent;
  readonly bandPreset: string;
  readonly cache: ImageryCacheNote;
  readonly legend: ReadonlyArray<{ label: string; color: string }>;
}

export interface ImageryCogDataset {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly mode: "fixture-safe" | "live";
  readonly center: readonly [number, number];
  readonly zoom: number;
  readonly extent: ImageryExtent;
  readonly layers: readonly ImageryLayerDefinition[];
}

export interface RasterSourceSpec {
  readonly type: "raster";
  readonly tiles: readonly string[];
  readonly tileSize: number;
  readonly scheme?: "xyz" | "tms";
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly attribution?: string;
}

export interface ImageryLayerState {
  readonly layer: ImageryLayerDefinition;
  readonly mapSourceId: string;
  readonly mapLayerId: string;
  readonly sourceSpec: RasterSourceSpec;
  readonly descriptor?: SourceDescriptor;
  readonly visible: boolean;
  readonly opacity: number;
  readonly metadata?: HonuaServiceMetadata;
  readonly legendResponse?: HonuaLegendResponse;
  readonly exportPreview?: HonuaExportMapResponse;
  readonly error?: string;
}

export interface ImageryRenderPlan {
  readonly dataset: ImageryCogDataset;
  readonly layers: readonly ImageryLayerState[];
  readonly auditRows: readonly ImageryAuditRow[];
}

export interface ImageryAuditRow {
  readonly capability: string;
  readonly sampleLayer: string;
  readonly sdkSurface: string;
  readonly endpoint: string;
  readonly cachePolicy: string;
}
