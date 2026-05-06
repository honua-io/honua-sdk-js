import type { ImageryCogDataset, ImageryExtent } from "./types.js";

const OAHU_EXTENT: ImageryExtent = {
  xmin: -158.22,
  ymin: 21.21,
  xmax: -157.66,
  ymax: 21.64,
};

export function createFixtureImageryCogDataset(): ImageryCogDataset {
  return {
    workspaceId: "imagery-cog-quickstart",
    generatedAt: "2026-05-06T00:00:00Z",
    mode: "fixture-safe",
    center: [-157.93, 21.39],
    zoom: 9.35,
    extent: OAHU_EXTENT,
    layers: [
      {
        id: "oahu-wms-natural-color",
        title: "Tiled imagery service",
        description: "WMS GetMap path for a published Honua imagery service.",
        serviceId: "OahuImagery",
        layerName: "natural_color",
        accessPath: "wms-getmap",
        sourceAsset: "Honua MapServer WMS layer",
        auditCapability: "WMS",
        endpointPath: "/rest/services/OahuImagery/MapServer/WMS",
        defaultOpacity: 0.82,
        visible: true,
        extent: OAHU_EXTENT,
        bandPreset: "Natural color",
        cache: {
          status: "ready",
          source: "honua-metadata",
          updatedAt: "2026-05-06T00:00:00Z",
          ttlMs: 600_000,
        },
        legend: [
          { label: "Vegetation", color: "#4d7c0f" },
          { label: "Urban", color: "#cbd5e1" },
          { label: "Water", color: "#2563eb" },
        ],
      },
      {
        id: "oahu-cog-image-server",
        title: "Published COG through ImageServer",
        description: "COG-backed tile pyramid and exportImage preview served from Honua ImageServer.",
        serviceId: "OahuCog",
        layerName: "oahu_sentinel2_cog",
        accessPath: "image-server-tile",
        sourceAsset: "/fixtures/imagery/oahu-sentinel2-20260412-cog.tif",
        auditCapability: "ImageServer",
        endpointPath: "/rest/services/OahuCog/ImageServer",
        defaultOpacity: 0.68,
        visible: true,
        extent: OAHU_EXTENT,
        bandPreset: "Sentinel-2 visual",
        cache: {
          status: "ready",
          source: "honua-metadata",
          updatedAt: "2026-05-06T00:00:00Z",
          ttlMs: 600_000,
        },
        legend: [
          { label: "Clear land", color: "#7aa56b" },
          { label: "Built surface", color: "#d1d5db" },
          { label: "Ocean", color: "#1d4ed8" },
        ],
      },
      {
        id: "oahu-cog-export-preview",
        title: "COG export preview",
        description: "ImageServer exportImage request over the same COG-backed service for static inspection.",
        serviceId: "OahuCog",
        layerName: "export_preview",
        accessPath: "image-server-export",
        sourceAsset: "/fixtures/imagery/oahu-sentinel2-20260412-cog.tif",
        auditCapability: "ImageServer",
        endpointPath: "/rest/services/OahuCog/ImageServer/exportImage",
        defaultOpacity: 0.48,
        visible: false,
        extent: OAHU_EXTENT,
        bandPreset: "Export preview",
        cache: {
          status: "bypass",
          source: "not-cached",
          updatedAt: "2026-05-06T00:00:00Z",
        },
        legend: [
          { label: "Preview footprint", color: "#f97316" },
          { label: "Transparent background", color: "#f8fafc" },
        ],
      },
    ],
  };
}
