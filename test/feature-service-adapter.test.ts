import { describe, expect, it, vi } from "vitest";

import { HonuaClient, HonuaMap } from "../src/index.js";
import {
  esriFeaturesToGeoJson,
  esriGeometryToGeoJson,
  loadHonuaFeatureServiceGeoJson,
  registerHonuaFeatureServiceSources,
} from "../src/map/index.js";
import { createHonuaFeatureServiceLayer, createHonuaTileServiceLayer } from "../src/map/maplibre-target.js";

const FEATURE_URL = "https://gis.example.com/rest/services/parcels/FeatureServer/0";

function makeClient(): HonuaClient {
  return new HonuaClient({ baseUrl: "https://gis.example.com" });
}

describe("esriGeometryToGeoJson", () => {
  it("converts a point geometry", () => {
    expect(esriGeometryToGeoJson({ x: -157.8, y: 21.3 }, "esriGeometryPoint")).toEqual({
      type: "Point",
      coordinates: [-157.8, 21.3],
    });
  });

  it("infers a point from structure when geometryType is absent", () => {
    expect(esriGeometryToGeoJson({ x: 1, y: 2 }, undefined)).toEqual({
      type: "Point",
      coordinates: [1, 2],
    });
  });

  it("converts a single-path polyline to LineString", () => {
    expect(
      esriGeometryToGeoJson(
        {
          paths: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
        "esriGeometryPolyline",
      ),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
  });

  it("converts a multi-path polyline to MultiLineString", () => {
    const result = esriGeometryToGeoJson(
      {
        paths: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
          ],
        ],
      },
      "esriGeometryPolyline",
    );
    expect(result?.type).toBe("MultiLineString");
  });

  it("converts a polygon's rings", () => {
    const result = esriGeometryToGeoJson(
      {
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      "esriGeometryPolygon",
    );
    expect(result).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
  });

  it("returns null for missing geometry", () => {
    expect(esriGeometryToGeoJson(null, "esriGeometryPoint")).toBeNull();
    expect(esriGeometryToGeoJson(undefined, "esriGeometryPolygon")).toBeNull();
  });
});

describe("esriFeaturesToGeoJson", () => {
  it("builds a standard FeatureCollection", () => {
    const fc = esriFeaturesToGeoJson([{ attributes: { id: 1 }, geometry: { x: 0, y: 0 } }], "esriGeometryPoint");
    expect(fc).toEqual({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { id: 1 } }],
    });
  });
});

describe("loadHonuaFeatureServiceGeoJson", () => {
  it("fetches features via the SDK and returns a maplibre-understood geojson source", async () => {
    const client = makeClient();
    const queryFeatures = vi.spyOn(client, "queryFeatures").mockResolvedValueOnce({
      features: [{ attributes: { OBJECTID: 1, name: "A" }, geometry: { x: -157, y: 21 } }],
    } as never);
    vi.spyOn(client, "getLayerMetadata").mockResolvedValue({
      id: 0,
      name: "parcels",
      geometryType: "esriGeometryPoint",
    } as never);

    const source = await loadHonuaFeatureServiceGeoJson(client, FEATURE_URL);

    // MapLibre understands the "geojson" source type natively.
    expect(source.type).toBe("geojson");
    expect(source.data).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-157, 21] },
          properties: { OBJECTID: 1, name: "A" },
        },
      ],
    });
    // GeoJSON requires WGS84, so the query defaults outSr to 4326.
    expect(queryFeatures).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "parcels", layerId: 0, outSr: 4326 }),
    );
  });
});

describe("registerHonuaFeatureServiceSources", () => {
  it("patches feature-service sources on a maplibre map into geojson sources", async () => {
    const client = makeClient();
    vi.spyOn(client, "queryFeatures").mockResolvedValue({
      features: [{ attributes: { OBJECTID: 7 }, geometry: { x: 1, y: 2 } }],
    } as never);
    vi.spyOn(client, "getLayerMetadata").mockResolvedValue({
      id: 0,
      name: "parcels",
      geometryType: "esriGeometryPoint",
    } as never);

    const honuaMap = new HonuaMap({ client });
    honuaMap.addSource("parcels", { type: "honua-feature-service", url: FEATURE_URL });
    honuaMap.addSource("osm", { type: "raster", tiles: ["https://t/{z}/{x}/{y}.png"] } as never);

    const added: Array<{ id: string; source: { type: string } }> = [];
    const fakeMap = {
      getSource: () => undefined,
      addSource: (id: string, source: unknown) => {
        added.push({ id, source: source as { type: string } });
      },
      removeSource: () => {},
    };

    const result = await registerHonuaFeatureServiceSources(fakeMap, honuaMap, client);

    expect(result.registered).toEqual(["parcels"]);
    expect(result.failed).toEqual([]);
    // Only the feature-service source is wired; the raster source is left alone.
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe("parcels");
    expect(added[0].source.type).toBe("geojson");
  });

  it("updates an existing geojson source in place via setData", async () => {
    const client = makeClient();
    vi.spyOn(client, "queryFeatures").mockResolvedValue({
      features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 0, y: 0 } }],
    } as never);
    vi.spyOn(client, "getLayerMetadata").mockResolvedValue({
      id: 0,
      name: "parcels",
      geometryType: "esriGeometryPoint",
    } as never);

    const honuaMap = new HonuaMap({ client });
    honuaMap.addSource("parcels", { type: "honua-feature-service", url: FEATURE_URL });

    const setData = vi.fn();
    const fakeMap = {
      getSource: () => ({ setData }),
      addSource: vi.fn(),
      removeSource: vi.fn(),
    };

    const result = await registerHonuaFeatureServiceSources(fakeMap, honuaMap, client);

    expect(result.registered).toEqual(["parcels"]);
    expect(setData).toHaveBeenCalledTimes(1);
    expect(fakeMap.addSource).not.toHaveBeenCalled();
  });

  it("fetches multiple sources concurrently while preserving source order", async () => {
    const client = makeClient();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(client, "getLayerMetadata").mockResolvedValue({
      id: 0,
      name: "x",
      geometryType: "esriGeometryPoint",
    } as never);
    vi.spyOn(client, "queryFeatures").mockImplementation((async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { features: [{ attributes: { OBJECTID: 1 }, geometry: { x: 0, y: 0 } }] };
    }) as never);

    const honuaMap = new HonuaMap({ client });
    honuaMap.addSource("a", { type: "honua-feature-service", url: FEATURE_URL });
    honuaMap.addSource("b", { type: "honua-feature-service", url: FEATURE_URL });
    honuaMap.addSource("c", { type: "honua-feature-service", url: FEATURE_URL });

    const order: string[] = [];
    const fakeMap = {
      getSource: () => undefined,
      addSource: (id: string) => {
        order.push(id);
      },
      removeSource: () => {},
    };

    const result = await registerHonuaFeatureServiceSources(fakeMap, honuaMap, client);

    expect(result.registered).toEqual(["a", "b", "c"]);
    // Map mutations stay ordered even though fetches run concurrently.
    expect(order).toEqual(["a", "b", "c"]);
    // Serial loading would never exceed one in-flight fetch.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("helper source asymmetry", () => {
  it("tile-service helper emits a native raster source while feature-service emits a custom type", () => {
    const tile = createHonuaTileServiceLayer({
      url: "https://gis.example.com/rest/services/imagery/MapServer",
    });
    expect(tile.source.type).toBe("raster");

    const feature = createHonuaFeatureServiceLayer({ url: FEATURE_URL });
    // The custom type is not renderable by MapLibre without the adapter.
    expect(feature.source.type).toBe("honua-feature-service");
  });
});
