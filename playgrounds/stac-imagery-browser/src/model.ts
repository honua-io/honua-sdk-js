import type { FilterClause, LinkedViewQueryProjection } from "@honua/sdk-js/exploration";

import { STAC_BROWSER_PAGE_SIZE, createFixtureStacCatalogDataset } from "./fixtures.js";
import type {
  StacAsset,
  StacBbox,
  StacBrowserSession,
  StacCatalogDataset,
  StacItem,
  StacSearchFilters,
  StacSearchPage,
  StacSearchQuery,
  StacSelectionProjection,
} from "./types.js";

export const DEFAULT_STAC_FILTERS: StacSearchFilters = {
  aoi: { xmin: -158.18, ymin: 21.22, xmax: -157.7, ymax: 21.58 },
  startDate: "2026-04-01",
  endDate: "2026-05-05",
  collectionId: "sentinel-2-l2a",
  maxCloudCover: 25,
  assetType: "image/png",
};

export function createStacBrowserSession(
  dataset: StacCatalogDataset = createFixtureStacCatalogDataset(),
  filters: StacSearchFilters = DEFAULT_STAC_FILTERS,
): StacBrowserSession {
  const firstPage = searchStacPage(dataset, filters, 0, STAC_BROWSER_PAGE_SIZE);
  const activeItem = firstPage.items[0];
  const activeAsset = activeItem ? selectDefaultAsset(activeItem) : undefined;
  const projection = activeItem && activeAsset ? projectSelectedAsset(activeItem, activeAsset) : undefined;
  return {
    dataset,
    filters,
    pageSize: STAC_BROWSER_PAGE_SIZE,
    loadedItems: firstPage.items,
    totalMatched: firstPage.totalMatched,
    paginationStatus: firstPage.nextOffset === undefined ? "complete" : "idle",
    activeItem,
    activeAsset,
    projection,
    queryFilters: queryFiltersFromStacFilters(filters),
  };
}

export function buildStacSearchQuery(filters: StacSearchFilters, limit = STAC_BROWSER_PAGE_SIZE): StacSearchQuery {
  return {
    collections: filters.collectionId === "all" ? [] : [filters.collectionId],
    bbox: [filters.aoi.xmin, filters.aoi.ymin, filters.aoi.xmax, filters.aoi.ymax],
    datetime: `${filters.startDate}T00:00:00Z/${filters.endDate}T23:59:59Z`,
    limit,
    query: {
      "eo:cloud_cover": { lte: filters.maxCloudCover },
      ...(filters.assetType === "any" ? {} : { "assets.type": { eq: filters.assetType } }),
    },
  };
}

export function searchStacPage(
  dataset: StacCatalogDataset,
  filters: StacSearchFilters,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): StacSearchPage {
  const query = buildStacSearchQuery(filters, limit);
  if (signal?.aborted) {
    return { query, offset, limit, totalMatched: 0, items: [], status: "cancelled" };
  }
  const matched = dataset.items.filter((item) => matchesFilters(item, filters));
  const pageItems = matched.slice(offset, offset + limit);
  return {
    query,
    offset,
    limit,
    totalMatched: matched.length,
    items: pageItems,
    nextOffset: offset + pageItems.length < matched.length ? offset + pageItems.length : undefined,
    status: "complete",
  };
}

export function loadNextStacPage(session: StacBrowserSession, signal?: AbortSignal): StacBrowserSession {
  if (signal?.aborted) return { ...session, paginationStatus: "cancelled" };
  if (session.loadedItems.length >= session.totalMatched) return { ...session, paginationStatus: "complete" };

  const page = searchStacPage(session.dataset, session.filters, session.loadedItems.length, session.pageSize, signal);
  if (page.status === "cancelled") return { ...session, paginationStatus: "cancelled" };

  const loadedItems = [...session.loadedItems, ...page.items];
  return {
    ...session,
    loadedItems,
    totalMatched: page.totalMatched,
    paginationStatus: page.nextOffset === undefined ? "complete" : "idle",
  };
}

export function cancelStacPagination(session: StacBrowserSession): StacBrowserSession {
  return { ...session, paginationStatus: "cancelled" };
}

export function updateStacFilters(session: StacBrowserSession, filters: StacSearchFilters): StacBrowserSession {
  return createStacBrowserSession(session.dataset, filters);
}

export function selectStacAsset(session: StacBrowserSession, itemId: string, assetKey = "visual"): StacBrowserSession {
  const activeItem = session.dataset.items.find((item) => item.id === itemId);
  const activeAsset = activeItem?.assets.find((asset) => asset.key === assetKey) ?? activeItem?.assets[0];
  return {
    ...session,
    activeItem,
    activeAsset,
    projection: activeItem && activeAsset ? projectSelectedAsset(activeItem, activeAsset) : undefined,
  };
}

export function projectSelectedAsset(item: StacItem, asset: StacAsset): StacSelectionProjection {
  const renderable = asset.support === "renderable" && asset.previewLayer !== undefined;
  return {
    itemId: item.id,
    assetKey: asset.key,
    collectionId: item.collectionId,
    itemTitle: item.title,
    assetTitle: asset.title,
    footprint: item.footprint,
    renderable,
    previewLayer: asset.previewLayer,
    message: renderable
      ? `${asset.title} is ready as a Honua map preview layer.`
      : (asset.unsupportedReason ??
        "This asset is discoverable, but Honua Cloud raster or coverage operations are not available in the fixture."),
    linkedView: linkedViewProjectionForItem(item),
  };
}

export function collectionCacheSummary(dataset: StacCatalogDataset): string {
  return dataset.collections
    .map((collection) => {
      const schema = collection.cache.schemaCached ? "schema cached" : "schema pending";
      return `${collection.title}: ${collection.cache.status}, ${schema}`;
    })
    .join(" | ");
}

export function queryFiltersFromStacFilters(filters: StacSearchFilters): Readonly<Record<string, FilterClause>> {
  return {
    collection: { field: "collectionId", operator: "=", value: filters.collectionId },
    cloud: { field: "cloudCover", operator: "<=", value: filters.maxCloudCover },
    assetType: { field: "assetType", operator: "=", value: filters.assetType },
  };
}

function linkedViewProjectionForItem(item: StacItem): LinkedViewQueryProjection {
  return {
    filters: {
      item: { field: "id", operator: "=", value: item.id },
      collection: { field: "collectionId", operator: "=", value: item.collectionId },
    },
    orderBy: [{ field: "datetime", direction: "desc" }],
    pagination: { offset: 0, limit: 1 },
    outFields: ["id", "collectionId", "datetime", "cloudCover", "platform"],
    grouping: [],
    selection: [item.id],
  };
}

function selectDefaultAsset(item: StacItem): StacAsset | undefined {
  return item.assets.find((asset) => asset.support === "renderable") ?? item.assets[0];
}

function matchesFilters(item: StacItem, filters: StacSearchFilters): boolean {
  if (filters.collectionId !== "all" && item.collectionId !== filters.collectionId) return false;
  if (item.cloudCover > filters.maxCloudCover) return false;
  if (!intersects(item.bbox, filters.aoi)) return false;

  const itemTime = Date.parse(item.datetime);
  const start = Date.parse(`${filters.startDate}T00:00:00Z`);
  const end = Date.parse(`${filters.endDate}T23:59:59Z`);
  if (itemTime < start || itemTime > end) return false;

  if (filters.assetType === "any") return true;
  return item.assets.some((asset) => asset.type === filters.assetType);
}

function intersects(a: StacBbox, b: StacBbox): boolean {
  return a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;
}
