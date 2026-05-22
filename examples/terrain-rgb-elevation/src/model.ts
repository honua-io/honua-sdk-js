import { type HonuaClient, HonuaImageService } from "@honua/sdk-js/honua";
import type { SceneRuntimePrimitive } from "@honua/sdk-js/scene-workspace";

import { createFixtureTerrainElevationDataset } from "./fixtures.js";
import type {
  TerrainAuditRow,
  TerrainCacheNote,
  TerrainCoordinate,
  TerrainElevationDataset,
  TerrainElevationProfile,
  TerrainElevationProfileResponse,
  TerrainElevationSample,
  TerrainElevationValueResponse,
  TerrainProfileSample,
  TerrainRenderPlan,
  TerrainRgbTilesetDefinition,
} from "./types.js";

const EARTH_RADIUS_METERS = 6_371_000;
const PROFILE_SAMPLE_COUNT = 8;

export function createDefaultTerrainDataset(serviceId?: string): TerrainElevationDataset {
  return createFixtureTerrainElevationDataset(serviceId);
}

export function createTerrainRenderPlan(dataset: TerrainElevationDataset, client: HonuaClient): TerrainRenderPlan {
  const imageService = new HonuaImageService({ client, serviceId: dataset.tileset.serviceId });
  return {
    dataset,
    sourceId: `${dataset.tileset.id}-source`,
    hillshadeLayerId: `${dataset.tileset.id}-hillshade`,
    profileSourceId: "terrain-profile-line",
    profileVertexSourceId: "terrain-profile-vertices",
    lookupSourceId: "terrain-lookup-point",
    terrainExaggeration: 1.35,
    sourceSpec: {
      type: "raster-dem",
      tiles: [buildTerrainRgbTileUrlTemplate(imageService)],
      tileSize: dataset.tileset.tileSize,
      encoding: dataset.tileset.encoding,
      minzoom: dataset.tileset.minzoom,
      maxzoom: dataset.tileset.maxzoom,
      attribution: dataset.tileset.attribution,
    },
    auditRows: createTerrainAuditRows(dataset.tileset),
  };
}

export function createTerrainScenePrimitives(plan: TerrainRenderPlan): readonly SceneRuntimePrimitive[] {
  return [
    {
      kind: "elevation-source",
      id: `${plan.dataset.tileset.id}-terrain`,
      title: plan.dataset.tileset.title,
      sourceId: plan.sourceId,
      protocol: "terrain-rgb",
      tiles: plan.sourceSpec.tiles,
      encoding: plan.sourceSpec.encoding,
      tileSize: plan.sourceSpec.tileSize,
      minzoom: plan.sourceSpec.minzoom,
      maxzoom: plan.sourceSpec.maxzoom,
      exaggeration: plan.terrainExaggeration,
      attribution: plan.sourceSpec.attribution,
      cache: {
        status: plan.dataset.tileset.cache.status === "ready" ? "ready" : "bypass",
        scope: "tiles",
        updatedAt: plan.dataset.tileset.cache.updatedAt,
        ttlMs: plan.dataset.tileset.cache.ttlMs,
      },
      metadata: {
        sourceAsset: plan.dataset.tileset.sourceAsset,
        elevationValueEndpoint: plan.dataset.tileset.endpointPaths.elevationValue,
        elevationProfileEndpoint: plan.dataset.tileset.endpointPaths.elevationProfile,
      },
    },
    {
      kind: "ground",
      id: `${plan.dataset.tileset.id}-ground`,
      terrainId: `${plan.dataset.tileset.id}-terrain`,
      title: "Terrain ground",
    },
  ];
}

export async function hydrateTerrainRenderPlan(
  plan: TerrainRenderPlan,
  client: HonuaClient,
): Promise<TerrainRenderPlan> {
  try {
    const service = new HonuaImageService({ client, serviceId: plan.dataset.tileset.serviceId });
    const metadata = await service.metadata();
    return { ...plan, metadata };
  } catch (error) {
    return {
      ...plan,
      metadataError: error instanceof Error ? error.message : "Unknown terrain metadata load failure",
    };
  }
}

export function buildTerrainRgbTileUrlTemplate(
  imageService: HonuaImageService,
  format: "png" | "jpg" | "jpeg" | "tif" | "tiff" = "png",
): string {
  const levelSentinel = 98765;
  const rowSentinel = 54321;
  const colSentinel = 12345;
  return imageService
    .tileUrl(levelSentinel, rowSentinel, colSentinel, format)
    .replace(`/${levelSentinel}/${rowSentinel}/${colSentinel}`, "/{z}/{y}/{x}");
}

export function decodeTerrainRgbElevation(red: number, green: number, blue: number): number {
  return -10_000 + (red * 256 * 256 + green * 256 + blue) * 0.1;
}

export async function lookupTerrainElevation(
  plan: TerrainRenderPlan,
  client: HonuaClient,
  coordinate: TerrainCoordinate,
  signal?: AbortSignal,
): Promise<TerrainElevationSample> {
  const [longitude, latitude] = coordinate;
  const path = pathWithQuery(plan.dataset.tileset.endpointPaths.elevationValue, {
    longitude,
    latitude,
    sr: 4326,
    units: "meters",
  });
  const response = await client.pipelineRequestJson<TerrainElevationValueResponse>("GET", path, undefined, signal);
  return toElevationSample(response, {
    coordinate,
    endpointPath: plan.dataset.tileset.endpointPaths.elevationValue,
    distanceMeters: undefined,
  }) as TerrainElevationSample;
}

export async function queryTerrainElevationProfile(
  plan: TerrainRenderPlan,
  client: HonuaClient,
  line: readonly TerrainCoordinate[],
  signal?: AbortSignal,
): Promise<TerrainElevationProfile> {
  requireProfileLine(line);
  const response = await client.pipelineRequestJson<TerrainElevationProfileResponse>(
    "POST",
    plan.dataset.tileset.endpointPaths.elevationProfile,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        geometry: {
          type: "LineString",
          coordinates: line,
        },
        sampleCount: PROFILE_SAMPLE_COUNT,
        sr: 4326,
        units: "meters",
      }),
    },
    signal,
  );
  return toElevationProfile(response, line, plan.dataset.tileset.endpointPaths.elevationProfile);
}

export function createFixtureElevationSample(
  coordinate: TerrainCoordinate,
  endpointPath = "/api/v1/terrain/OahuTerrain/elevation/value",
): TerrainElevationSample {
  const [longitude, latitude] = coordinate;
  return {
    longitude,
    latitude,
    elevationMeters: estimateFixtureElevationMeters(coordinate),
    verticalDatum: "EGM96",
    resolutionMeters: 10,
    source: "fixture-terrain-rgb",
    endpointPath,
    cache: interactionCacheNote(),
  };
}

export function createFixtureElevationProfile(
  line: readonly TerrainCoordinate[],
  endpointPath = "/api/v1/terrain/OahuTerrain/elevation/profile",
  sampleCount = PROFILE_SAMPLE_COUNT,
): TerrainElevationProfile {
  requireProfileLine(line);
  const sampledLine = sampleLine(line, sampleCount);
  const samples: TerrainProfileSample[] = sampledLine.map((sample) => ({
    ...createFixtureElevationSample(sample.coordinate, endpointPath),
    distanceMeters: sample.distanceMeters,
  }));
  return summarizeProfile(line, samples, endpointPath, "fixture-terrain-rgb");
}

export function summarizeTerrainCache(dataset: TerrainElevationDataset): string {
  return dataset.tileset.cache.status === "ready" ? "metadata ready / interactions uncached" : "metadata bypassed";
}

export function summarizeTerrainCapabilities(plan: TerrainRenderPlan): string {
  return plan.auditRows.map((row) => row.capability).join(", ");
}

export function profileDistanceMeters(profile: TerrainElevationProfile | undefined): number {
  return profile?.samples.at(-1)?.distanceMeters ?? 0;
}

export function formatElevationMeters(value: number): string {
  return `${Math.round(value).toLocaleString()} m`;
}

function createTerrainAuditRows(tileset: TerrainRgbTilesetDefinition): TerrainAuditRow[] {
  return [
    {
      capability: "Terrain-RGB tiles",
      uiFeature: "MapLibre terrain and hillshade layer",
      sdkSurface: "HonuaImageService.tileUrl",
      endpoint: tileset.endpointPaths.tiles,
      cachePolicy: "Tile pyramid and ImageServer metadata are cacheable by source/config version.",
    },
    {
      capability: "Elevation value API",
      uiFeature: "Click point elevation readout",
      sdkSurface: "demo-local helper over HonuaClient.pipelineRequestJson (typed Terrain API gap)",
      endpoint: tileset.endpointPaths.elevationValue,
      cachePolicy: "Uncached ad hoc point request because it depends on click location.",
    },
    {
      capability: "Elevation profile API",
      uiFeature: "Drawn line elevation profile",
      sdkSurface: "demo-local helper over HonuaClient.pipelineRequestJson (typed Terrain API gap)",
      endpoint: tileset.endpointPaths.elevationProfile,
      cachePolicy: "Uncached ad hoc profile request because it depends on user-drawn geometry.",
    },
  ];
}

function toElevationSample(
  response: TerrainElevationValueResponse,
  context: {
    coordinate: TerrainCoordinate;
    endpointPath: string;
    distanceMeters: number | undefined;
  },
): TerrainElevationSample | TerrainProfileSample {
  const longitude = finiteOr(response.longitude ?? response.location?.longitude, context.coordinate[0]);
  const latitude = finiteOr(response.latitude ?? response.location?.latitude, context.coordinate[1]);
  const sample: TerrainElevationSample = {
    longitude,
    latitude,
    elevationMeters: finiteOr(response.elevationMeters, estimateFixtureElevationMeters([longitude, latitude])),
    verticalDatum: response.verticalDatum ?? "EGM96",
    resolutionMeters: finiteOr(response.resolutionMeters, 10),
    source: response.source ?? "terrain-elevation-endpoint",
    endpointPath: context.endpointPath,
    cache: interactionCacheNote(),
  };
  return context.distanceMeters === undefined
    ? sample
    : {
        ...sample,
        distanceMeters: context.distanceMeters,
      };
}

function toElevationProfile(
  response: TerrainElevationProfileResponse,
  requestedLine: readonly TerrainCoordinate[],
  endpointPath: string,
): TerrainElevationProfile {
  const fallbackSamples = sampleLine(requestedLine, PROFILE_SAMPLE_COUNT);
  const samples = response.samples.map((sample, index) => {
    const fallback = fallbackSamples[Math.min(index, fallbackSamples.length - 1)]!;
    const coordinate: TerrainCoordinate = [
      sample.longitude ?? sample.location?.longitude ?? fallback.coordinate[0],
      sample.latitude ?? sample.location?.latitude ?? fallback.coordinate[1],
    ];
    return toElevationSample(sample, {
      coordinate,
      endpointPath,
      distanceMeters: finiteOr(sample.distanceMeters, fallback.distanceMeters),
    }) as TerrainProfileSample;
  });
  return summarizeProfile(
    response.line ?? requestedLine,
    samples,
    endpointPath,
    response.source ?? "terrain-profile-endpoint",
  );
}

function summarizeProfile(
  line: readonly TerrainCoordinate[],
  samples: readonly TerrainProfileSample[],
  endpointPath: string,
  source: string,
): TerrainElevationProfile {
  const elevations = samples.map((sample) => sample.elevationMeters);
  let gainMeters = 0;
  let lossMeters = 0;
  for (let index = 1; index < elevations.length; index += 1) {
    const delta = elevations[index]! - elevations[index - 1]!;
    if (delta > 0) {
      gainMeters += delta;
    } else {
      lossMeters += Math.abs(delta);
    }
  }
  return {
    line,
    samples,
    minElevationMeters: elevations.length > 0 ? Math.min(...elevations) : 0,
    maxElevationMeters: elevations.length > 0 ? Math.max(...elevations) : 0,
    gainMeters: Math.round(gainMeters * 10) / 10,
    lossMeters: Math.round(lossMeters * 10) / 10,
    endpointPath,
    source,
    cache: interactionCacheNote(),
  };
}

function pathWithQuery(path: string, query: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  return `${path}?${params.toString()}`;
}

function estimateFixtureElevationMeters([longitude, latitude]: TerrainCoordinate): number {
  const eastRamp = (longitude + 158.02) * 960;
  const northRamp = (latitude - 21.28) * 2200;
  const ridge = Math.sin((longitude + 157.91) * 19) * 160 + Math.cos((latitude - 21.39) * 24) * 85;
  return Math.round(Math.max(12, 260 + eastRamp + northRamp + ridge) * 10) / 10;
}

function sampleLine(
  line: readonly TerrainCoordinate[],
  count: number,
): Array<{
  readonly coordinate: TerrainCoordinate;
  readonly distanceMeters: number;
}> {
  requireProfileLine(line);
  const segmentLengths = line.slice(1).map((point, index) => haversineMeters(line[index]!, point));
  const total = segmentLengths.reduce((sum, value) => sum + value, 0);
  const safeCount = Math.max(2, count);
  return Array.from({ length: safeCount }, (_, index) => {
    const targetDistance = total * (index / (safeCount - 1));
    return {
      coordinate: interpolateLine(line, segmentLengths, targetDistance),
      distanceMeters: Math.round(targetDistance),
    };
  });
}

function interpolateLine(
  line: readonly TerrainCoordinate[],
  segmentLengths: readonly number[],
  targetDistance: number,
): TerrainCoordinate {
  let traversed = 0;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index]!;
    if (targetDistance <= traversed + segmentLength || index === segmentLengths.length - 1) {
      const start = line[index]!;
      const end = line[index + 1]!;
      const ratio = segmentLength === 0 ? 0 : (targetDistance - traversed) / segmentLength;
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    traversed += segmentLength;
  }
  return line.at(-1)!;
}

function haversineMeters([lon1, lat1]: TerrainCoordinate, [lon2, lat2]: TerrainCoordinate): number {
  const phi1 = degreesToRadians(lat1);
  const phi2 = degreesToRadians(lat2);
  const deltaPhi = degreesToRadians(lat2 - lat1);
  const deltaLambda = degreesToRadians(lon2 - lon1);
  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function requireProfileLine(line: readonly TerrainCoordinate[]): void {
  if (line.length < 2) {
    throw new Error("Elevation profile requires at least two coordinates.");
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function interactionCacheNote(): TerrainCacheNote {
  return {
    status: "bypass",
    source: "interaction",
    updatedAt: "2026-05-06T00:00:00Z",
  };
}
