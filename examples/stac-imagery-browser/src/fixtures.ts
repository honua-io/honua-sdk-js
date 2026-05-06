import type { StacCatalogDataset, StacItem } from "./types.js";

export const STAC_BROWSER_PAGE_SIZE = 2;

export function createFixtureStacCatalogDataset(now = 1_798_742_400_000): StacCatalogDataset {
  return {
    workspaceId: "fixture-honua-stac",
    activeSourceId: "honua-cloud:stac:sentinel-2-l2a",
    generatedAt: now,
    capabilities: {
      stacSearch: "supported",
      collectionMetadataCache: "supported",
      tilePreview: "supported",
      rasterAnalysis: "unsupported",
      coverageExport: "unsupported",
    },
    collections: [
      {
        id: "sentinel-2-l2a",
        title: "Sentinel-2 L2A Surface Reflectance",
        description: "Cloud Honua fixture collection with visual tiles, thumbnails, and COG assets around Oahu.",
        license: "CC-BY-4.0",
        extent: { xmin: -158.3, ymin: 21.15, xmax: -157.6, ymax: 21.75 },
        assetTypes: ["image/tiff; application=geotiff", "image/png", "text/xml"],
        cache: {
          status: "ready",
          source: "fixture",
          updatedAt: now,
          revalidateAfterMs: 600_000,
          schemaCached: true,
        },
      },
      {
        id: "landsat-9-l2",
        title: "Landsat 9 Level-2",
        description: "Fixture collection for lower cadence operational comparison imagery.",
        license: "USGS public domain",
        extent: { xmin: -159.0, ymin: 20.9, xmax: -157.3, ymax: 22.1 },
        assetTypes: ["image/tiff; application=geotiff", "application/json"],
        cache: {
          status: "stale",
          source: "fixture",
          updatedAt: now - 900_000,
          revalidateAfterMs: 600_000,
          schemaCached: true,
        },
      },
    ],
    items: [
      item({
        id: "S2A_20260412T211901_OAHU_01",
        collectionId: "sentinel-2-l2a",
        title: "Oahu south shore clear pass",
        datetime: "2026-04-12T21:19:01Z",
        cloudCover: 4,
        platform: "sentinel-2a",
        bbox: { xmin: -158.08, ymin: 21.25, xmax: -157.71, ymax: 21.47 },
        visualUrl: "/fixtures/stac/s2a-oahu-visual/{z}/{x}/{y}.png",
      }),
      item({
        id: "S2B_20260418T212029_OAHU_02",
        collectionId: "sentinel-2-l2a",
        title: "Windward ridge cloud break",
        datetime: "2026-04-18T21:20:29Z",
        cloudCover: 18,
        platform: "sentinel-2b",
        bbox: { xmin: -158.02, ymin: 21.31, xmax: -157.68, ymax: 21.63 },
        visualUrl: "/fixtures/stac/s2b-windward-visual/{z}/{x}/{y}.png",
      }),
      item({
        id: "LC09_20260328T210455_OAHU_03",
        collectionId: "landsat-9-l2",
        title: "Islandwide Landsat comparison",
        datetime: "2026-03-28T21:04:55Z",
        cloudCover: 22,
        platform: "landsat-9",
        bbox: { xmin: -158.24, ymin: 21.18, xmax: -157.61, ymax: 21.72 },
        visualUrl: "/fixtures/stac/landsat-oahu-visual/{z}/{x}/{y}.png",
      }),
      item({
        id: "S2A_20260501T211859_OAHU_04",
        collectionId: "sentinel-2-l2a",
        title: "Leeward coast recent tasking",
        datetime: "2026-05-01T21:18:59Z",
        cloudCover: 9,
        platform: "sentinel-2a",
        bbox: { xmin: -158.23, ymin: 21.28, xmax: -157.88, ymax: 21.52 },
        visualUrl: "/fixtures/stac/s2a-leeward-visual/{z}/{x}/{y}.png",
      }),
      item({
        id: "S2B_20260503T212031_OAHU_05",
        collectionId: "sentinel-2-l2a",
        title: "Harbor asset monitoring haze",
        datetime: "2026-05-03T21:20:31Z",
        cloudCover: 34,
        platform: "sentinel-2b",
        bbox: { xmin: -157.96, ymin: 21.25, xmax: -157.75, ymax: 21.38 },
        visualUrl: "/fixtures/stac/s2b-harbor-visual/{z}/{x}/{y}.png",
      }),
    ],
  };
}

function item(input: {
  id: string;
  collectionId: string;
  title: string;
  datetime: string;
  cloudCover: number;
  platform: string;
  bbox: StacItem["bbox"];
  visualUrl: string;
}): StacItem {
  const { bbox } = input;
  return {
    ...input,
    footprint: [
      [bbox.xmin, bbox.ymin],
      [bbox.xmax, bbox.ymin],
      [bbox.xmax, bbox.ymax],
      [bbox.xmin, bbox.ymax],
      [bbox.xmin, bbox.ymin],
    ],
    assets: [
      {
        key: "visual",
        title: "Visual tile preview",
        type: "image/png",
        roles: ["visual", "tiles"],
        href: input.visualUrl,
        support: "renderable",
        previewLayer: { kind: "tile", label: "Honua tile preview", url: input.visualUrl },
      },
      {
        key: "thumbnail",
        title: "Scene thumbnail",
        type: "image/jpeg",
        roles: ["thumbnail"],
        href: `/fixtures/stac/${input.id.toLowerCase()}-thumb.jpg`,
        support: "renderable",
        previewLayer: {
          kind: "thumbnail",
          label: "Static thumbnail preview",
          url: `/fixtures/stac/${input.id.toLowerCase()}-thumb.jpg`,
        },
      },
      {
        key: "cog",
        title: "Cloud optimized GeoTIFF",
        type: "image/tiff; application=geotiff",
        roles: ["data"],
        href: `/fixtures/stac/${input.id.toLowerCase()}-sr-cog.tif`,
        support: "unsupported",
        unsupportedReason:
          "Raster band math and coverage export are not enabled in this fixture. Use Honua Cloud analysis jobs when raster processing is available.",
      },
    ],
  };
}
