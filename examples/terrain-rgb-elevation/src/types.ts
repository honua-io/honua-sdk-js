import type { HonuaServiceMetadata } from "@honua/sdk-js/honua";

export type TerrainRgbEncoding = "mapbox";
export type TerrainCoordinate = readonly [number, number];

export interface TerrainExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface TerrainCacheNote {
  readonly status: "ready" | "bypass";
  readonly source: "honua-metadata" | "interaction";
  readonly updatedAt: string;
  readonly ttlMs?: number;
}

export interface TerrainEndpointPaths {
  readonly metadata: string;
  readonly tiles: string;
  readonly elevationValue: string;
  readonly elevationProfile: string;
}

export interface TerrainRgbTilesetDefinition {
  readonly id: string;
  readonly title: string;
  readonly serviceId: string;
  readonly sourceAsset: string;
  readonly endpointPaths: TerrainEndpointPaths;
  readonly encoding: TerrainRgbEncoding;
  readonly tileSize: number;
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly attribution: string;
  readonly cache: TerrainCacheNote;
}

export interface TerrainElevationDataset {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly mode: "fixture-safe" | "live";
  readonly center: TerrainCoordinate;
  readonly zoom: number;
  readonly extent: TerrainExtent;
  readonly profileLine: readonly TerrainCoordinate[];
  readonly tileset: TerrainRgbTilesetDefinition;
}

export interface TerrainRasterDemSourceSpec {
  readonly type: "raster-dem";
  readonly tiles: readonly string[];
  readonly tileSize: number;
  readonly encoding: TerrainRgbEncoding;
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly attribution: string;
}

export interface TerrainRenderPlan {
  readonly dataset: TerrainElevationDataset;
  readonly sourceId: string;
  readonly hillshadeLayerId: string;
  readonly profileSourceId: string;
  readonly profileVertexSourceId: string;
  readonly lookupSourceId: string;
  readonly terrainExaggeration: number;
  readonly sourceSpec: TerrainRasterDemSourceSpec;
  readonly auditRows: readonly TerrainAuditRow[];
  readonly metadata?: HonuaServiceMetadata;
  readonly metadataError?: string;
}

export interface TerrainAuditRow {
  readonly capability: string;
  readonly uiFeature: string;
  readonly sdkSurface: string;
  readonly endpoint: string;
  readonly cachePolicy: string;
}

export interface TerrainElevationSample {
  readonly longitude: number;
  readonly latitude: number;
  readonly elevationMeters: number;
  readonly verticalDatum: string;
  readonly resolutionMeters: number;
  readonly source: string;
  readonly endpointPath: string;
  readonly cache: TerrainCacheNote;
}

export interface TerrainProfileSample extends TerrainElevationSample {
  readonly distanceMeters: number;
}

export interface TerrainElevationProfile {
  readonly line: readonly TerrainCoordinate[];
  readonly samples: readonly TerrainProfileSample[];
  readonly minElevationMeters: number;
  readonly maxElevationMeters: number;
  readonly gainMeters: number;
  readonly lossMeters: number;
  readonly endpointPath: string;
  readonly source: string;
  readonly cache: TerrainCacheNote;
}

export interface TerrainElevationValueResponse {
  readonly location?: {
    readonly longitude?: number;
    readonly latitude?: number;
  };
  readonly longitude?: number;
  readonly latitude?: number;
  readonly elevationMeters: number;
  readonly verticalDatum?: string;
  readonly resolutionMeters?: number;
  readonly source?: string;
}

export interface TerrainElevationProfileResponse {
  readonly line?: readonly TerrainCoordinate[];
  readonly samples: ReadonlyArray<
    TerrainElevationValueResponse & {
      readonly distanceMeters?: number;
    }
  >;
  readonly minElevationMeters?: number;
  readonly maxElevationMeters?: number;
  readonly gainMeters?: number;
  readonly lossMeters?: number;
  readonly source?: string;
}
