import type { TerrainElevationDataset, TerrainExtent } from "./types.js";

const OAHU_TERRAIN_EXTENT: TerrainExtent = {
  xmin: -158.08,
  ymin: 21.28,
  xmax: -157.72,
  ymax: 21.52,
};

function servicePath(serviceId: string, suffix: string): string {
  return `/rest/services/${encodeURIComponent(serviceId)}/ImageServer${suffix}`;
}

function terrainApiPath(serviceId: string, suffix: string): string {
  return `/api/v1/terrain/${encodeURIComponent(serviceId)}${suffix}`;
}

export function createFixtureTerrainElevationDataset(serviceId = "OahuTerrain"): TerrainElevationDataset {
  return {
    workspaceId: "terrain-rgb-elevation",
    generatedAt: "2026-05-06T00:00:00Z",
    mode: "fixture-safe",
    center: [-157.88, 21.39],
    zoom: 10.7,
    extent: OAHU_TERRAIN_EXTENT,
    profileLine: [
      [-157.965, 21.354],
      [-157.91, 21.385],
      [-157.84, 21.422],
      [-157.78, 21.446],
    ],
    tileset: {
      id: "oahu-terrain-rgb",
      title: "Oahu Terrain-RGB DEM",
      serviceId,
      sourceAsset: "/fixtures/terrain/oahu-10m-dem-terrain-rgb.mbtiles",
      endpointPaths: {
        metadata: servicePath(serviceId, ""),
        tiles: servicePath(serviceId, "/tile/{z}/{y}/{x}"),
        elevationValue: terrainApiPath(serviceId, "/elevation/value"),
        elevationProfile: terrainApiPath(serviceId, "/elevation/profile"),
      },
      encoding: "mapbox",
      tileSize: 256,
      minzoom: 6,
      maxzoom: 14,
      attribution: "Honua fixture Terrain-RGB DEM",
      cache: {
        status: "ready",
        source: "honua-metadata",
        updatedAt: "2026-05-06T00:00:00Z",
        ttlMs: 600_000,
      },
    },
  };
}
