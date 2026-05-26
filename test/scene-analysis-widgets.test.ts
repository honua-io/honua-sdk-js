import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// The analysis renderers touch CesiumJS lazily (`await import("cesium")`) just
// like the scene adapter. Cesium needs a WebGL context unavailable headless and
// `Cartesian3` / `Color` are opaque ECEF/colour objects, so we mock only the
// surface the renderers read. The server endpoints are mocked via a fake
// request executor (the same shape as `HonuaClient.pipelineRequestJson`), so
// the request/response wiring is exercised without a live server. The 2D bundle
// never loads this module — see the static-import guard test at the bottom.
vi.mock("cesium", () => ({
  Cartesian3: {
    fromDegrees: (longitude: number, latitude: number, height?: number) => ({
      kind: "cart",
      longitude,
      latitude,
      height,
    }),
    fromDegreesArrayHeights: (coordinates: number[]) => ({ kind: "cart-array-h", coordinates }),
    fromDegreesArray: (coordinates: number[]) => ({ kind: "cart-array", coordinates }),
  },
  Color: {
    fromCssColorString: (color: string) => ({ kind: "css-color", color }),
    LIME: { kind: "color", name: "LIME" },
    RED: { kind: "color", name: "RED" },
    YELLOW: { kind: "color", name: "YELLOW" },
  },
}));

import {
  type CesiumEntityCollectionLike,
  type LineOfSightResult,
  type SceneAnalysisPosition,
  type SceneAnalysisRequestExecutor,
  type ViewshedResult,
  buildElevationProfilePath,
  buildLineOfSightBody,
  buildViewshedBody,
  formatMeasurementLabel,
  haversineMeters,
  measureScenePositions,
  pathLengthMeters,
  positionsToWktLineString,
  renderElevationProfilePolyline,
  renderLineOfSight,
  renderMeasurement,
  renderViewshed,
  requestElevationProfile,
  requestLineOfSight,
  requestViewshed,
  slantDistanceMeters,
  sphericalPolygonAreaSquareMeters,
} from "../src/scene-workspace/index.js";

/**
 * A pure-JS stand-in for Cesium's `EntityCollection` (off `viewer.entities`).
 * It records every added entity and supports removal so overlay teardown is
 * observable without a live WebGL `Viewer`.
 */
function createMockEntities(): CesiumEntityCollectionLike & { added: unknown[] } {
  const added: unknown[] = [];
  return {
    added,
    add(entity: unknown) {
      added.push(entity);
      return entity;
    },
    remove(entity: unknown) {
      const index = added.indexOf(entity);
      if (index === -1) return false;
      added.splice(index, 1);
      return true;
    },
  };
}

/** A request executor capturing one call and returning a canned JSON body. */
function createMockExecutor(response: unknown): SceneAnalysisRequestExecutor & {
  calls: Array<{ method: string; path: string; init?: { headers?: Record<string, string>; body?: string | null } }>;
} {
  const calls: Array<{
    method: string;
    path: string;
    init?: { headers?: Record<string, string>; body?: string | null };
  }> = [];
  const executor = (async (
    method: string,
    requestPath: string,
    init?: { headers?: Record<string, string>; body?: string | null },
  ) => {
    calls.push({ method, path: requestPath, init });
    return response;
  }) as SceneAnalysisRequestExecutor & { calls: typeof calls };
  executor.calls = calls;
  return executor;
}

const HONOLULU: SceneAnalysisPosition = { longitude: -157.8583, latitude: 21.3069, height: 10 };
const DIAMOND_HEAD: SceneAnalysisPosition = { longitude: -157.8036, latitude: 21.2619, height: 232 };

describe("scene analysis: client-side geometry", () => {
  it("computes haversine ground distance between two positions", () => {
    // Honolulu -> Diamond Head is roughly 7.5 km along the ground.
    const meters = haversineMeters(HONOLULU, DIAMOND_HEAD);
    expect(meters).toBeGreaterThan(6500);
    expect(meters).toBeLessThan(8500);
  });

  it("folds height delta into the 3D slant distance via Pythagoras", () => {
    const a: SceneAnalysisPosition = { longitude: 0, latitude: 0, height: 0 };
    const b: SceneAnalysisPosition = { longitude: 0, latitude: 0, height: 300 };
    // Same lon/lat -> ground distance ~0, so slant is dominated by the 300 m rise.
    expect(slantDistanceMeters(a, b)).toBeCloseTo(300, 3);
  });

  it("sums per-segment slant distances into a total path length", () => {
    const total = pathLengthMeters([HONOLULU, DIAMOND_HEAD, HONOLULU]);
    expect(total).toBeCloseTo(slantDistanceMeters(HONOLULU, DIAMOND_HEAD) * 2, 3);
  });

  it("computes spherical polygon area for a small ring (~1 km square)", () => {
    // ~0.009 deg ≈ ~1 km at the equator; expect roughly 1 km².
    const ring: SceneAnalysisPosition[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 0.009, latitude: 0 },
      { longitude: 0.009, latitude: 0.009 },
      { longitude: 0, latitude: 0.009 },
    ];
    const area = sphericalPolygonAreaSquareMeters(ring);
    expect(area).toBeGreaterThan(800_000);
    expect(area).toBeLessThan(1_200_000);
  });

  it("returns zero area for degenerate rings", () => {
    expect(sphericalPolygonAreaSquareMeters([HONOLULU, DIAMOND_HEAD])).toBe(0);
  });

  it("normalizes longitude deltas across the antimeridian (no area inflation)", () => {
    // A ~1 km square straddling the ±180° antimeridian (0.009° wide). Without
    // longitude-delta normalization, the 179.9955 → -179.9955 edge reads as
    // ~-359.99° instead of +0.009°, inflating the area ~40000x.
    const ring: SceneAnalysisPosition[] = [
      { longitude: 179.9955, latitude: 0 },
      { longitude: -179.9955, latitude: 0 },
      { longitude: -179.9955, latitude: 0.009 },
      { longitude: 179.9955, latitude: 0.009 },
    ];
    const area = sphericalPolygonAreaSquareMeters(ring);
    expect(area).toBeGreaterThan(800_000);
    expect(area).toBeLessThan(1_200_000);

    // It must match the identical square placed away from the antimeridian.
    const equivalent: SceneAnalysisPosition[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 0.009, latitude: 0 },
      { longitude: 0.009, latitude: 0.009 },
      { longitude: 0, latitude: 0.009 },
    ];
    expect(area).toBeCloseTo(sphericalPolygonAreaSquareMeters(equivalent), 3);
  });

  it("serializes positions to a 2D WKT LINESTRING (lon lat, height dropped)", () => {
    expect(positionsToWktLineString([HONOLULU, DIAMOND_HEAD])).toBe(
      "LINESTRING (-157.8583 21.3069, -157.8036 21.2619)",
    );
  });
});

describe("scene analysis: measurement widget", () => {
  it("measures distance with per-segment slant distances", () => {
    const measurement = measureScenePositions([HONOLULU, DIAMOND_HEAD]);
    expect(measurement.mode).toBe("distance");
    expect(measurement.segmentMeters).toHaveLength(1);
    expect(measurement.lengthMeters).toBeCloseTo(slantDistanceMeters(HONOLULU, DIAMOND_HEAD), 3);
    expect(measurement.areaSquareMeters).toBeUndefined();
  });

  it("measures area when mode is 'area'", () => {
    const ring: SceneAnalysisPosition[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 0.01, latitude: 0 },
      { longitude: 0.01, latitude: 0.01 },
    ];
    const measurement = measureScenePositions(ring, "area");
    expect(measurement.mode).toBe("area");
    expect(measurement.areaSquareMeters).toBeGreaterThan(0);
  });

  it("formats distance and area labels in km / km² above 1 unit", () => {
    expect(formatMeasurementLabel(measureScenePositions([HONOLULU, DIAMOND_HEAD]))).toMatch(/km$/);
    expect(formatMeasurementLabel({ positions: [], lengthMeters: 250, segmentMeters: [], mode: "distance" })).toBe(
      "250.0 m",
    );
    expect(
      formatMeasurementLabel({
        positions: [],
        lengthMeters: 0,
        segmentMeters: [],
        mode: "area",
        areaSquareMeters: 2_500_000,
      }),
    ).toBe("2.50 km²");
  });

  it("renders the measurement polyline + label into the scene entities", async () => {
    const entities = createMockEntities();
    const measurement = measureScenePositions([HONOLULU, DIAMOND_HEAD]);
    const overlay = await renderMeasurement(entities, measurement);

    expect(overlay.kind).toBe("measurement");
    // One polyline + one label.
    expect(entities.added).toHaveLength(2);
    expect(overlay.entities).toHaveLength(2);

    overlay.remove();
    expect(entities.added).toHaveLength(0);
  });

  it("closes the ring for an area measurement render", async () => {
    const entities = createMockEntities();
    const ring: SceneAnalysisPosition[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 0.01, latitude: 0 },
      { longitude: 0.01, latitude: 0.01 },
    ];
    await renderMeasurement(entities, measureScenePositions(ring, "area"));
    const line = entities.added[0] as { polyline: { positions: { coordinates: number[] } } };
    // 3 ring vertices + closing vertex = 4 positions = 12 flattened lon/lat/h values.
    expect(line.polyline.positions.coordinates).toHaveLength(12);
  });
});

describe("scene analysis: elevation profile widget", () => {
  it("builds a GET profile path with a WKT line + sampling params", () => {
    const requestPath = buildElevationProfilePath({
      datasetId: "dem-1",
      polyline: [HONOLULU, DIAMOND_HEAD],
      sampleCount: 64,
      srid: 4326,
    });
    expect(requestPath.startsWith("/elevation/dem-1/profile?")).toBe(true);
    const query = new URLSearchParams(requestPath.split("?")[1]);
    expect(query.get("line")).toBe("LINESTRING (-157.8583 21.3069, -157.8036 21.2619)");
    expect(query.get("sampleCount")).toBe("64");
    expect(query.get("srid")).toBe("4326");
  });

  it("requests a profile and normalizes the server response", async () => {
    const executor = createMockExecutor({
      datasetId: "dem-1",
      layerId: 3,
      sampleCount: 3,
      lineLengthMeters: 6800,
      lineSrid: 4326,
      isAllNoData: false,
      samples: [
        { distanceMeters: 0, elevation: 10, noData: false },
        { distanceMeters: 3400, elevation: 120, noData: false },
        { distanceMeters: 6800, elevation: 232, noData: false },
      ],
    });

    const result = await requestElevationProfile(executor, { datasetId: "dem-1", polyline: [HONOLULU, DIAMOND_HEAD] });

    expect(executor.calls[0]?.method).toBe("GET");
    expect(executor.calls[0]?.path.startsWith("/elevation/dem-1/profile?")).toBe(true);
    expect(result.sampleCount).toBe(3);
    expect(result.lineLengthMeters).toBe(6800);
    expect(result.samples[2]?.elevation).toBe(232);
  });

  it("treats null-elevation samples as noData", async () => {
    const executor = createMockExecutor({
      samples: [{ distanceMeters: 0, elevation: null }],
    });
    const result = await requestElevationProfile(executor, { datasetId: "dem-1", polyline: [HONOLULU, DIAMOND_HEAD] });
    expect(result.samples[0]?.noData).toBe(true);
    expect(result.isAllNoData).toBe(true);
  });

  it("rejects a profile request with fewer than two positions", async () => {
    const executor = createMockExecutor({});
    await expect(requestElevationProfile(executor, { datasetId: "dem-1", polyline: [HONOLULU] })).rejects.toThrow(
      /at least two positions/,
    );
    expect(executor.calls).toHaveLength(0);
  });

  it("renders the profile polyline into the scene entities", async () => {
    const entities = createMockEntities();
    const overlay = await renderElevationProfilePolyline(entities, [HONOLULU, DIAMOND_HEAD]);
    expect(overlay.kind).toBe("elevation-profile");
    expect(entities.added).toHaveLength(1);
    const line = entities.added[0] as { polyline: { clampToGround: boolean } };
    expect(line.polyline.clampToGround).toBe(true);
  });
});

describe("scene analysis: line-of-sight widget", () => {
  it("builds a FLAT LoS body with observerHeight/targetHeight folding the offset", () => {
    const body = buildLineOfSightBody({
      datasetId: "dem-1",
      observer: HONOLULU,
      target: DIAMOND_HEAD,
      observerOffsetMeters: 1.7,
      targetOffsetMeters: 0,
      sampleCount: 128,
    });
    // observerHeight is the terrain-relative offset (offset wins over position.height).
    expect(body).toMatchObject({
      observerLon: -157.8583,
      observerLat: 21.3069,
      observerHeight: 1.7,
      targetLon: -157.8036,
      targetLat: 21.2619,
      targetHeight: 0,
      sampleCount: 128,
    });
    // No nested observer/target, no srid/offset.
    expect(body.observer).toBeUndefined();
    expect(body.target).toBeUndefined();
    expect(body.srid).toBeUndefined();
  });

  it("falls back to position.height then 0 for the height offset", () => {
    const body = buildLineOfSightBody({ datasetId: "dem-1", observer: HONOLULU, target: DIAMOND_HEAD });
    // No explicit offset -> use position.height.
    expect(body.observerHeight).toBe(10);
    expect(body.targetHeight).toBe(232);
  });

  it("POSTs a flat LoS request to the endpoint and normalizes a visible result", async () => {
    const executor = createMockExecutor({
      datasetId: "dem-1",
      layerId: 3,
      visible: true,
      distanceMeters: 6800,
      observerElevation: 11.7,
      targetElevation: 232,
      sampleCount: 256,
      hasNoDataSamples: false,
      obstruction: null,
    });
    const result = await requestLineOfSight(executor, { datasetId: "dem-1", observer: HONOLULU, target: DIAMOND_HEAD });

    const call = executor.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/elevation/dem-1/line-of-sight");
    expect(call?.init?.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call?.init?.body ?? "{}").observerLon).toBe(-157.8583);
    expect(result.visible).toBe(true);
    expect(result.obstruction).toBeUndefined();
    expect(result.distanceMeters).toBe(6800);
    expect(result.observerElevation).toBeCloseTo(11.7, 6);
    expect(result.targetElevation).toBe(232);
    expect(result.sampleCount).toBe(256);
    expect(result.hasNoDataSamples).toBe(false);
  });

  it("normalizes an obstructed LoS result mapping obstruction lon/lat/elevation", async () => {
    const executor = createMockExecutor({
      visible: false,
      distanceMeters: 6800,
      obstruction: { lon: -157.83, lat: 21.28, elevation: 180, distanceMeters: 4200 },
    });
    const result = await requestLineOfSight(executor, { datasetId: "dem-1", observer: HONOLULU, target: DIAMOND_HEAD });
    expect(result.visible).toBe(false);
    expect(result.obstruction).toEqual({ longitude: -157.83, latitude: 21.28, height: 180 });
    expect(result.obstructionDistanceMeters).toBe(4200);
  });

  it("renders a visible sightline (lime, no marker)", async () => {
    const entities = createMockEntities();
    const result: LineOfSightResult = { datasetId: "dem-1", visible: true };
    const overlay = await renderLineOfSight(entities, { observer: HONOLULU, target: DIAMOND_HEAD }, result);

    expect(overlay.kind).toBe("line-of-sight");
    expect(entities.added).toHaveLength(1);
    const line = entities.added[0] as { polyline: { material: { name: string } } };
    expect(line.polyline.material).toMatchObject({ name: "LIME" });
  });

  it("renders an obstructed sightline (red) + obstruction marker", async () => {
    const entities = createMockEntities();
    const result: LineOfSightResult = {
      datasetId: "dem-1",
      visible: false,
      obstruction: { longitude: -157.83, latitude: 21.28, height: 180 },
    };
    const overlay = await renderLineOfSight(entities, { observer: HONOLULU, target: DIAMOND_HEAD }, result);

    expect(entities.added).toHaveLength(2);
    const line = entities.added[0] as { polyline: { material: { name: string } } };
    expect(line.polyline.material).toMatchObject({ name: "RED" });
    const marker = entities.added[1] as { point: { color: { name: string } } };
    expect(marker.point.color).toMatchObject({ name: "YELLOW" });

    overlay.remove();
    expect(entities.added).toHaveLength(0);
  });
});

describe("scene analysis: viewshed widget", () => {
  it("builds a FLAT viewshed body with observerHeight/targetHeight/rayCount/samplesPerRay", () => {
    const body = buildViewshedBody({
      datasetId: "dem-1",
      observer: HONOLULU,
      observerOffsetMeters: 30,
      targetHeightMeters: 1.5,
      radiusMeters: 5000,
      rayCount: 360,
      samplesPerRay: 128,
    });
    expect(body).toMatchObject({
      observerLon: -157.8583,
      observerLat: 21.3069,
      observerHeight: 30,
      targetHeight: 1.5,
      radiusMeters: 5000,
      rayCount: 360,
      samplesPerRay: 128,
    });
    // No nested observer, no azimuth sweep, no srid.
    expect(body.observer).toBeUndefined();
    expect(body.startAzimuth).toBeUndefined();
    expect(body.endAzimuth).toBeUndefined();
    expect(body.srid).toBeUndefined();
  });

  it("POSTs a viewshed request and normalizes the radial samples", async () => {
    const executor = createMockExecutor({
      datasetId: "dem-1",
      layerId: 3,
      radiusMeters: 5000,
      rayCount: 2,
      samplesPerRay: 2,
      sampleCount: 4,
      visibleSampleCount: 3,
      samples: [
        { lon: -157.86, lat: 21.3, azimuthDegrees: 0, distanceMeters: 2500, elevation: 40, visible: true },
        { lon: -157.85, lat: 21.3, azimuthDegrees: 0, distanceMeters: 5000, elevation: 80, visible: true },
        { lon: -157.86, lat: 21.31, azimuthDegrees: 180, distanceMeters: 2500, elevation: 60, visible: false },
        { lon: -157.85, lat: 21.31, azimuthDegrees: 180, distanceMeters: 5000, elevation: null, visible: true },
      ],
    });
    const result = await requestViewshed(executor, { datasetId: "dem-1", observer: HONOLULU, radiusMeters: 5000 });

    const call = executor.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/elevation/dem-1/viewshed");
    expect(JSON.parse(call?.init?.body ?? "{}").observerLon).toBe(-157.8583);
    expect(result.sampleCount).toBe(4);
    expect(result.visibleSampleCount).toBe(3);
    expect(result.rayCount).toBe(2);
    expect(result.samplesPerRay).toBe(2);
    expect(result.samples).toHaveLength(4);
    expect(result.samples[0]).toEqual({
      position: { longitude: -157.86, latitude: 21.3, height: 40 },
      azimuthDegrees: 0,
      distanceMeters: 2500,
      visible: true,
    });
    // NoData elevation normalizes to height 0.
    expect(result.samples[3]?.position.height).toBe(0);
  });

  it("derives sampleCount/visibleSampleCount from samples when omitted", async () => {
    const executor = createMockExecutor({
      samples: [
        { lon: 0, lat: 0, azimuthDegrees: 0, distanceMeters: 100, elevation: 5, visible: true },
        { lon: 1, lat: 1, azimuthDegrees: 90, distanceMeters: 200, elevation: 6, visible: false },
      ],
    });
    const result = await requestViewshed(executor, { datasetId: "dem-1", observer: HONOLULU, radiusMeters: 1000 });
    expect(result.sampleCount).toBe(2);
    expect(result.visibleSampleCount).toBe(1);
  });

  it("renders visible (green) and obstructed (red) sample points into the scene entities", async () => {
    const entities = createMockEntities();
    const result: ViewshedResult = {
      datasetId: "dem-1",
      observer: HONOLULU,
      radiusMeters: 5000,
      sampleCount: 2,
      visibleSampleCount: 1,
      samples: [
        {
          position: { longitude: -157.86, latitude: 21.3, height: 40 },
          azimuthDegrees: 0,
          distanceMeters: 2500,
          visible: true,
        },
        {
          position: { longitude: -157.85, latitude: 21.31, height: 60 },
          azimuthDegrees: 180,
          distanceMeters: 2500,
          visible: false,
        },
      ],
    };
    const overlay = await renderViewshed(entities, result);
    expect(overlay.kind).toBe("viewshed");
    expect(entities.added).toHaveLength(2);
    const visible = entities.added[0] as { point: { color: { name: string } } };
    expect(visible.point.color).toMatchObject({ name: "LIME" });
    const obstructed = entities.added[1] as { point: { color: { name: string } } };
    expect(obstructed.point.color).toMatchObject({ name: "RED" });

    overlay.remove();
    expect(entities.added).toHaveLength(0);
  });

  it("renders no entities for an empty sample set", async () => {
    const entities = createMockEntities();
    await renderViewshed(entities, {
      datasetId: "dem-1",
      observer: HONOLULU,
      radiusMeters: 1000,
      sampleCount: 0,
      visibleSampleCount: 0,
      samples: [],
    });
    expect(entities.added).toHaveLength(0);
  });
});

describe("scene analysis: bundle hygiene", () => {
  it("does not statically import Cesium from the scene-workspace sources", () => {
    const sceneWorkspaceRoot = path.resolve(process.cwd(), "src", "scene-workspace");
    const files = fs.readdirSync(sceneWorkspaceRoot).filter((file) => file.endsWith(".ts"));
    const source = files.map((file) => fs.readFileSync(path.join(sceneWorkspaceRoot, file), "utf8")).join("\n");

    // Only the lazy dynamic `import("cesium")` is allowed; a static
    // `import ... from "cesium"` would eagerly pull Cesium into the 2D bundle.
    expect(source).not.toMatch(/from\s+["']cesium["']/);
    expect(source).toMatch(/import\(["']cesium["']\)/);
  });
});
