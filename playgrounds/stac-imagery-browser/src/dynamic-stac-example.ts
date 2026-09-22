import type {
  DynamicStacAssetDescriptor,
  DynamicStacClient,
  DynamicStacSearchRequest,
  HonuaStacItemResponse,
  StacSearchMethod,
} from "@honua/sdk-js/stac";

export const MAUI_BOUNDS = [-156.75, 20.55, -155.85, 21.05] as const;
export const MAUI_DATETIME = "2026-04-01T00:00:00Z/2026-05-05T23:59:59Z";

export function mauiSearchRequest(method: StacSearchMethod, signal?: AbortSignal): DynamicStacSearchRequest {
  return {
    method,
    collections: ["sentinel-2-l2a"],
    bbox: MAUI_BOUNDS,
    datetime: MAUI_DATETIME,
    filterLang: "cql2-json",
    filter: { op: "<=", args: [{ property: "eo:cloud_cover" }, 20] },
    fields: { include: ["id", "collection", "bbox", "geometry", "properties.datetime", "assets", "links"] },
    sortby: [{ field: "properties.datetime", direction: "desc" }],
    limit: 10,
    signal,
  };
}

/** Atomic SDK Example: one bounded search and one typed asset selection. */
export async function searchMauiImagery(
  stac: DynamicStacClient,
  signal?: AbortSignal,
): Promise<{ item: HonuaStacItemResponse; asset: DynamicStacAssetDescriptor }> {
  const response = await stac.search(mauiSearchRequest("POST", signal));
  const item = response.features[0];
  if (!item) throw new Error("No Maui imagery matched the selected bounds and time range.");
  const asset = await stac.selectAsset(item, { roles: ["visual", "data"], formats: ["cog"], signal });
  return { item, asset };
}
