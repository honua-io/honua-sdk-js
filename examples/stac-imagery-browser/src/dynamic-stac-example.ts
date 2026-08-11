import type { DynamicStacAssetDescriptor, DynamicStacClient, HonuaStacItemResponse } from "@honua/sdk-js/stac";

export const MAUI_BOUNDS = [-156.75, 20.55, -155.85, 21.05] as const;

/** Minimal SDK path used by the sample's pinned-fixture contract test. */
export async function searchMauiImagery(
  stac: DynamicStacClient,
  signal?: AbortSignal,
): Promise<{ item: HonuaStacItemResponse; asset: DynamicStacAssetDescriptor }> {
  const response = await stac.search({
    method: "POST",
    collections: ["sentinel-2-l2a"],
    bbox: MAUI_BOUNDS,
    datetime: "2026-04-01T00:00:00Z/2026-05-05T23:59:59Z",
    filterLang: "cql2-json",
    filter: { op: "<=", args: [{ property: "eo:cloud_cover" }, 20] },
    fields: { include: ["id", "collection", "properties.datetime", "assets", "links"] },
    sortby: [{ field: "properties.datetime", direction: "desc" }],
    limit: 10,
    signal,
  });
  const item = response.features[0];
  if (!item) throw new Error("No Maui imagery matched the selected bounds and time range.");
  const asset = await stac.selectAsset(item, { roles: ["visual", "data"], formats: ["cog", "raster"], signal });
  return { item, asset };
}
