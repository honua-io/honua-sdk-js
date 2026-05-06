import type { HonuaSourceCacheStatus } from "@honua/sdk-js/app-workspace";
import type { FilterClause, LinkedViewQueryProjection } from "@honua/sdk-js/exploration";

export type StacCapabilityStatus = "supported" | "degraded" | "unsupported";
export type StacAssetSupport = "renderable" | "unsupported";
export type StacCacheSource = "fixture" | "honua-cloud";
export type StacPaginationStatus = "idle" | "loading" | "cancelled" | "complete";

export interface StacBbox {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface StacCollection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly license: string;
  readonly extent: StacBbox;
  readonly assetTypes: readonly string[];
  readonly cache: {
    readonly status: HonuaSourceCacheStatus;
    readonly source: StacCacheSource;
    readonly updatedAt: number;
    readonly revalidateAfterMs: number;
    readonly schemaCached: boolean;
  };
}

export interface StacAsset {
  readonly key: string;
  readonly title: string;
  readonly type: string;
  readonly roles: readonly string[];
  readonly href: string;
  readonly support: StacAssetSupport;
  readonly previewLayer?: {
    readonly kind: "tile" | "thumbnail";
    readonly label: string;
    readonly url: string;
  };
  readonly unsupportedReason?: string;
}

export interface StacItem {
  readonly id: string;
  readonly collectionId: string;
  readonly title: string;
  readonly datetime: string;
  readonly cloudCover: number;
  readonly platform: string;
  readonly bbox: StacBbox;
  readonly footprint: readonly [number, number][];
  readonly assets: readonly StacAsset[];
}

export interface StacCatalogDataset {
  readonly workspaceId: string;
  readonly activeSourceId: string;
  readonly generatedAt: number;
  readonly collections: readonly StacCollection[];
  readonly items: readonly StacItem[];
  readonly capabilities: {
    readonly stacSearch: StacCapabilityStatus;
    readonly collectionMetadataCache: StacCapabilityStatus;
    readonly tilePreview: StacCapabilityStatus;
    readonly rasterAnalysis: StacCapabilityStatus;
    readonly coverageExport: StacCapabilityStatus;
  };
}

export interface StacSearchFilters {
  readonly aoi: StacBbox;
  readonly startDate: string;
  readonly endDate: string;
  readonly collectionId: string;
  readonly maxCloudCover: number;
  readonly assetType: string;
}

export interface StacSearchQuery {
  readonly collections: readonly string[];
  readonly bbox: readonly [number, number, number, number];
  readonly datetime: string;
  readonly limit: number;
  readonly query: {
    readonly "eo:cloud_cover": { readonly lte: number };
    readonly "assets.type"?: { readonly eq: string };
  };
}

export interface StacSearchPage {
  readonly query: StacSearchQuery;
  readonly offset: number;
  readonly limit: number;
  readonly totalMatched: number;
  readonly items: readonly StacItem[];
  readonly nextOffset?: number;
  readonly status: StacPaginationStatus;
}

export interface StacSelectionProjection {
  readonly itemId: string;
  readonly assetKey: string;
  readonly collectionId: string;
  readonly itemTitle: string;
  readonly assetTitle: string;
  readonly footprint: readonly [number, number][];
  readonly renderable: boolean;
  readonly previewLayer?: StacAsset["previewLayer"];
  readonly message: string;
  readonly linkedView: LinkedViewQueryProjection;
}

export interface StacBrowserSession {
  readonly dataset: StacCatalogDataset;
  readonly filters: StacSearchFilters;
  readonly pageSize: number;
  readonly loadedItems: readonly StacItem[];
  readonly totalMatched: number;
  readonly paginationStatus: StacPaginationStatus;
  readonly activeItem?: StacItem;
  readonly activeAsset?: StacAsset;
  readonly projection?: StacSelectionProjection;
  readonly queryFilters: Readonly<Record<string, FilterClause>>;
}
