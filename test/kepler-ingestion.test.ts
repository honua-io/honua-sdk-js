import { describe, expect, it } from "vitest";

import {
  type HonuaKeplerBridgeError,
  KEPLER_BRIDGE_CAPABILITIES,
  type KeplerResultProjectionRequest,
  projectColumnarBatchToKeplerDataset,
  projectRemoteSourceToKepler,
  projectResultToKeplerDataset,
} from "../src/kepler/index.js";

/** Shoelace signed area; positive is counter-clockwise (GeoJSON exterior). */
function signedArea(ring: readonly number[][]): number {
  let total = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    total += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return total / 2;
}

const provenance = {
  sourceId: "incidents",
  sourceVersion: "2026-07-01T00:00:00Z",
  schemaVersion: "schema-1",
  planId: "plan-1",
  planFingerprint: "sha256:abc",
  authorizationScope: "scope:public-read",
  attribution: "City of Honua open data",
  protocol: "geoservices",
  freshness: { observedAt: "2026-07-25T12:00:00Z", staleAfter: "2026-07-25T12:05:00Z", validator: 'W/"etag-1"' },
} as const;

function resultRequest(overrides: Partial<KeplerResultProjectionRequest> = {}): KeplerResultProjectionRequest {
  return {
    datasetId: "incidents",
    label: "Incidents",
    provenance,
    result: {
      features: [
        {
          attributes: { objectid: 1, status: "open", reported_at: "2026-07-25T11:00:00Z", severity: 2.5 },
          geometry: { x: -122.4, y: 37.8 },
        },
        {
          attributes: { objectid: 2, status: "closed", reported_at: "2026-07-25T11:30:00Z", severity: 1 },
          geometry: { type: "Point", coordinates: [-122.41, 37.81] },
        },
      ],
      fields: [
        { name: "objectid", type: "esriFieldTypeOID" },
        { name: "status", type: "esriFieldTypeString" },
        { name: "reported_at", type: "esriFieldTypeDate" },
        { name: "severity", type: "esriFieldTypeDouble" },
      ],
      exceededTransferLimit: false,
    },
    rowIdentityField: "objectid",
    ...overrides,
  };
}

describe("projectResultToKeplerDataset — direct point path", () => {
  it("projects point geometry into longitude/latitude columns with no GeoJSON round trip", () => {
    const projection = projectResultToKeplerDataset(resultRequest());

    expect(projection.diagnostic.strategy).toBe("point-columns-direct");
    expect(projection.diagnostic.geoJsonRoundTrip).toBe(false);
    expect(projection.diagnostic.geoJsonBytes).toBe(0);
    expect(projection.metrics.geoJsonBytes).toBe(0);
    expect(projection.dataset.data.fields.map((field) => field.name)).toEqual([
      "objectid",
      "status",
      "reported_at",
      "severity",
      "longitude",
      "latitude",
    ]);
    expect(projection.dataset.data.rows[0]).toEqual([1, "open", Date.parse("2026-07-25T11:00:00Z"), 2.5, -122.4, 37.8]);
    expect(projection.dataset.metadata.pointColumns).toEqual({ longitude: "longitude", latitude: "latitude" });
  });

  it("preserves field types, temporal fields, plan identity, attribution, freshness, and authorization scope", () => {
    const projection = projectResultToKeplerDataset(resultRequest());
    const metadata = projection.dataset.metadata;

    expect(projection.dataset.data.fields.map((field) => field.type)).toEqual([
      "integer",
      "string",
      "timestamp",
      "real",
      "real",
      "real",
    ]);
    expect(metadata.temporalFields).toEqual(["reported_at"]);
    expect(metadata.provenance.planId).toBe("plan-1");
    expect(metadata.provenance.planFingerprint).toBe("sha256:abc");
    expect(metadata.provenance.attribution).toBe("City of Honua open data");
    expect(metadata.provenance.freshness?.validator).toBe('W/"etag-1"');
    expect(metadata.provenance.authorizationScope).toBe("scope:public-read");
    expect(metadata.crs).toEqual({
      requested: "EPSG:4326",
      applied: "EPSG:4326",
      reprojected: false,
      reason: "Input coordinates are already WGS84 lon/lat; no reprojection performed.",
    });
    expect(metadata.rowIdentityField).toBe("objectid");
  });

  it("treats an explicitly declared temporal attribute as a Kepler timestamp column", () => {
    const projection = projectResultToKeplerDataset(
      resultRequest({
        temporalFields: ["status"],
        rowIdentityField: undefined,
        result: {
          features: [{ attributes: { status: "2026-01-01T00:00:00Z" }, geometry: { x: 0, y: 0 } }],
          exceededTransferLimit: false,
        },
      }),
    );

    expect(projection.dataset.data.fields[0]).toMatchObject({ name: "status", type: "timestamp", format: "x" });
    expect(projection.dataset.data.rows[0][0]).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });
});

describe("projectResultToKeplerDataset — measured GeoJSON fallback", () => {
  it("serializes non-point geometry into a Kepler geojson column and measures the cost", () => {
    const projection = projectResultToKeplerDataset(
      resultRequest({
        result: {
          features: [
            {
              attributes: { objectid: 1 },
              geometry: {
                rings: [
                  [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0],
                  ],
                ],
              },
            },
          ],
          exceededTransferLimit: false,
        },
        rowIdentityField: undefined,
      }),
    );

    expect(projection.diagnostic.strategy).toBe("geojson-column");
    expect(projection.diagnostic.geoJsonRoundTrip).toBe(true);
    expect(projection.diagnostic.geoJsonBytes).toBeGreaterThan(0);
    expect(projection.diagnostic.fidelity).toBe("lossy");
    expect(projection.dataset.data.fields.at(-1)).toMatchObject({ name: "_geojson", type: "geojson" });
    expect(projection.dataset.data.rows[0].at(-1)).toEqual({
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    });
  });

  it("emits a MultiPolygon for an Esri polygon with several exterior rings", () => {
    // Two clockwise exterior rings (Esri convention). Emitting one Polygon would
    // silently demote the second exterior ring to a hole of the first.
    const projection = projectResultToKeplerDataset(
      resultRequest({
        rowIdentityField: undefined,
        result: {
          features: [
            {
              attributes: { objectid: 1 },
              geometry: {
                rings: [
                  [
                    [0, 0],
                    [0, 2],
                    [2, 2],
                    [2, 0],
                    [0, 0],
                  ],
                  [
                    [10, 10],
                    [10, 12],
                    [12, 12],
                    [12, 10],
                    [10, 10],
                  ],
                ],
              },
            },
          ],
          exceededTransferLimit: false,
        },
      }),
    );

    const feature = projection.dataset.data.rows[0].at(-1) as {
      geometry: { type: string; coordinates: number[][][][] };
    };
    expect(feature.geometry.type).toBe("MultiPolygon");
    expect(feature.geometry.coordinates).toHaveLength(2);
    // Each polygon keeps exactly one exterior ring; neither became a hole.
    expect(feature.geometry.coordinates[0]).toHaveLength(1);
    expect(feature.geometry.coordinates[1]).toHaveLength(1);
  });

  it("rewinds Esri rings to the RFC 7946 right-hand rule", () => {
    const projection = projectResultToKeplerDataset(
      resultRequest({
        rowIdentityField: undefined,
        result: {
          features: [
            {
              attributes: { objectid: 1 },
              geometry: {
                // Clockwise exterior ring with a counter-clockwise hole.
                rings: [
                  [
                    [0, 0],
                    [0, 4],
                    [4, 4],
                    [4, 0],
                    [0, 0],
                  ],
                  [
                    [1, 1],
                    [2, 1],
                    [2, 2],
                    [1, 2],
                    [1, 1],
                  ],
                ],
              },
            },
          ],
          exceededTransferLimit: false,
        },
      }),
    );

    const feature = projection.dataset.data.rows[0].at(-1) as {
      geometry: { type: string; coordinates: number[][][] };
    };
    expect(feature.geometry.type).toBe("Polygon");
    expect(feature.geometry.coordinates).toHaveLength(2);
    expect(signedArea(feature.geometry.coordinates[0])).toBeGreaterThan(0);
    expect(signedArea(feature.geometry.coordinates[1])).toBeLessThan(0);
  });

  it("still converts single-ring polygons, polylines, multipoints, and envelopes", () => {
    const cases: Array<{ readonly geometry: unknown; readonly type: string }> = [
      {
        geometry: {
          paths: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
        type: "LineString",
      },
      {
        geometry: {
          paths: [
            [
              [0, 0],
              [1, 1],
            ],
            [
              [5, 5],
              [6, 6],
            ],
          ],
        },
        type: "MultiLineString",
      },
      {
        geometry: {
          points: [
            [0, 0],
            [1, 1],
          ],
        },
        type: "MultiPoint",
      },
      { geometry: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, type: "Polygon" },
    ];

    for (const { geometry, type } of cases) {
      const projection = projectResultToKeplerDataset(
        resultRequest({
          rowIdentityField: undefined,
          result: { features: [{ attributes: { objectid: 1 }, geometry }], exceededTransferLimit: false },
        }),
      );
      const feature = projection.dataset.data.rows[0].at(-1) as { geometry: { type: string } };
      expect(feature.geometry.type, type).toBe(type);
    }
  });

  it("honors forceGeoJsonColumn for point geometry so an existing layer binding keeps working", () => {
    const projection = projectResultToKeplerDataset(resultRequest({ forceGeoJsonColumn: true }));

    expect(projection.diagnostic.strategy).toBe("geojson-column");
    expect(projection.diagnostic.geoJsonBytes).toBeGreaterThan(0);
  });

  it("records absent geometry as an explicit loss instead of silently dropping rows", () => {
    const projection = projectResultToKeplerDataset(
      resultRequest({
        result: {
          features: [
            { attributes: { objectid: 1 }, geometry: { x: 1, y: 2 } },
            { attributes: { objectid: 2 }, geometry: null },
          ],
          exceededTransferLimit: false,
        },
      }),
    );

    expect(projection.diagnostic.losses.map((loss) => loss.kind)).toContain("null-geometry-dropped");
    expect(projection.dataset.data.rows[1].slice(-2)).toEqual([null, null]);
  });
});

describe("projectResultToKeplerDataset — capability truth", () => {
  it("drops a field type with no Kepler equivalent and reports the loss", () => {
    const projection = projectResultToKeplerDataset(
      resultRequest({
        result: {
          features: [{ attributes: { objectid: 1, thumbnail: "..." } }],
          fields: [
            { name: "objectid", type: "esriFieldTypeOID" },
            { name: "thumbnail", type: "esriFieldTypeBlob" },
          ],
          exceededTransferLimit: false,
        },
      }),
    );

    expect(projection.dataset.data.fields.map((field) => field.name)).toEqual(["objectid"]);
    expect(projection.diagnostic.losses).toEqual([
      {
        kind: "unsupported-field-type",
        field: "thumbnail",
        detail: 'Field type "esriFieldTypeBlob" has no Kepler equivalent; the column was dropped.',
      },
    ]);
  });

  it("refuses a non-WGS84 result rather than mis-plotting it", () => {
    expect(() => projectResultToKeplerDataset(resultRequest({ crs: "EPSG:3857" }))).toThrowError(
      /Kepler renders WGS84 lon\/lat only/,
    );
    try {
      projectResultToKeplerDataset(resultRequest({ crs: "EPSG:3857" }));
    } catch (error) {
      expect((error as HonuaKeplerBridgeError).code).toBe("unsupported-crs");
    }
  });

  it("carries a source truncation and source degradation into the workspace diagnostics", () => {
    const projection = projectResultToKeplerDataset(
      resultRequest({
        result: {
          features: [{ attributes: { objectid: 1 }, geometry: { x: 0, y: 0 } }],
          exceededTransferLimit: true,
          degraded: [{ capability: "aggregation", reason: "computed client-side" }],
        },
      }),
    );

    expect(projection.diagnostic.losses.map((loss) => loss.kind)).toContain("row-limit-truncated");
    expect(projection.diagnostic.losses.some((loss) => loss.detail.includes("computed client-side"))).toBe(true);
  });

  it("projects aggregate rows with no geometry and no CRS decision", () => {
    const projection = projectResultToKeplerDataset({
      datasetId: "by-status",
      provenance,
      result: {
        features: [],
        aggregateRows: [
          { status: "open", count: 12 },
          { status: "closed", count: 3 },
        ],
        exceededTransferLimit: false,
      },
    });

    expect(projection.diagnostic.strategy).toBe("row-object-direct");
    expect(projection.diagnostic.geoJsonBytes).toBe(0);
    expect(projection.dataset.metadata.crs.applied).toBe("none");
    expect(projection.dataset.data.fields.map((field) => field.name)).toEqual(["count", "status"]);
  });

  it("rejects a row identity field that is not a projected column", () => {
    expect(() => projectResultToKeplerDataset(resultRequest({ rowIdentityField: "missing" }))).toThrowError(
      /is not a projected attribute column/,
    );
  });

  it("enforces the row budget instead of truncating", () => {
    expect(() =>
      projectResultToKeplerDataset(resultRequest(), {
        maxDatasets: 4,
        maxRowsPerDataset: 1,
        maxFieldsPerDataset: 64,
        maxRetainedRowBytes: 1024,
        maxDeltaRows: 10,
      }),
    ).toThrowError(/at most 1 rows/);
  });
});

describe("projectColumnarBatchToKeplerDataset", () => {
  it("transposes typed columns into Kepler rows with no GeoJSON round trip", () => {
    const projection = projectColumnarBatchToKeplerDataset({
      datasetId: "sensor-readings",
      provenance,
      rowCount: 3,
      columns: [
        { name: "sensor_id", type: "int32", values: new Int32Array([1, 2, 3]) },
        { name: "reading", type: "float64", values: new Float64Array([1.5, 2.5, 3.5]) },
        { name: "lon", type: "float64", values: new Float64Array([-122.4, -122.5, -122.6]) },
        { name: "lat", type: "float64", values: new Float64Array([37.8, 37.9, 38]) },
      ],
      pointColumns: { longitude: "lon", latitude: "lat" },
    });

    expect(projection.diagnostic.strategy).toBe("columnar-columns-direct");
    expect(projection.diagnostic.geoJsonRoundTrip).toBe(false);
    expect(projection.diagnostic.geoJsonBytes).toBe(0);
    expect(projection.diagnostic.fidelity).toBe("exact");
    expect(projection.dataset.data.rows).toEqual([
      [1, 1.5, -122.4, 37.8],
      [2, 2.5, -122.5, 37.9],
      [3, 3.5, -122.6, 38],
    ]);
    expect(projection.dataset.metadata.pointColumns).toEqual({ longitude: "lon", latitude: "lat" });
  });

  it("drops a nested column layout with explicit fallback evidence", () => {
    const projection = projectColumnarBatchToKeplerDataset({
      datasetId: "nested",
      provenance,
      rowCount: 1,
      columns: [
        { name: "id", type: "int32", values: new Int32Array([7]) },
        { name: "tags", type: "list", values: [["a", "b"]] },
      ],
    });

    expect(projection.dataset.data.fields.map((field) => field.name)).toEqual(["id"]);
    expect(projection.diagnostic.losses).toEqual([
      {
        kind: "unsupported-column-layout",
        field: "tags",
        detail: 'Columnar type "list" has no Kepler equivalent; the column was dropped rather than flattened.',
      },
    ]);
    expect(projection.diagnostic.fidelity).toBe("lossy");
  });

  it("reports 64-bit integers narrowed for Kepler", () => {
    const projection = projectColumnarBatchToKeplerDataset({
      datasetId: "wide-ids",
      provenance,
      rowCount: 1,
      columns: [{ name: "id", type: "int64", values: new BigInt64Array([9_007_199_254_740_993n]) }],
    });

    expect(projection.diagnostic.losses.map((loss) => loss.kind)).toEqual(["numeric-precision-narrowed"]);
  });

  it("rejects point columns that are not numeric", () => {
    expect(() =>
      projectColumnarBatchToKeplerDataset({
        datasetId: "bad-points",
        provenance,
        rowCount: 1,
        columns: [
          { name: "lon", type: "utf8", values: ["-122.4"] },
          { name: "lat", type: "float64", values: new Float64Array([37.8]) },
        ],
        pointColumns: { longitude: "lon", latitude: "lat" },
      }),
    ).toThrowError(/must be a numeric column/);
  });

  it("rejects a column shorter than the declared row count", () => {
    expect(() =>
      projectColumnarBatchToKeplerDataset({
        datasetId: "short",
        provenance,
        rowCount: 4,
        columns: [{ name: "id", type: "int32", values: new Int32Array([1, 2]) }],
      }),
    ).toThrowError(/carries 2 values but rowCount is 4/);
  });
});

describe("projectRemoteSourceToKepler", () => {
  it("projects a raster tile source into a Kepler custom basemap entry", () => {
    const projection = projectRemoteSourceToKepler({
      datasetId: "imagery",
      label: "Imagery",
      provenance: { sourceId: "imagery", attribution: "Honua imagery" },
      source: { kind: "raster-tiles", tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"], minZoom: 0, maxZoom: 18 },
    });

    expect(projection.target).toBe("map-style");
    if (projection.target !== "map-style") throw new Error("expected a map-style projection");
    expect(projection.mapStyle).toEqual({
      id: "imagery",
      label: "Imagery",
      url: "https://tiles.example.com/{z}/{x}/{y}.png",
      custom: true,
      minZoom: 0,
      maxZoom: 18,
    });
    expect(projection.diagnostic.strategy).toBe("remote-basemap-style");
  });

  it("projects a vector tile source into a tileset descriptor carrying provenance", () => {
    const projection = projectRemoteSourceToKepler({
      datasetId: "parcels",
      provenance: { sourceId: "parcels", planId: "plan-9" },
      source: { kind: "vector-tiles", url: "https://tiles.example.com/parcels/metadata.json" },
    });

    if (projection.target !== "tileset") throw new Error("expected a tileset projection");
    expect(projection.tileset.info).toEqual({ id: "parcels", label: "parcels", type: "vectorTile" });
    expect(projection.tileset.metadata.tilesetMetadataUrl).toBe("https://tiles.example.com/parcels/metadata.json");
    expect(projection.tileset.metadata.provenance.planId).toBe("plan-9");
  });

  it("refuses a signed remote source URL", () => {
    expect(() =>
      projectRemoteSourceToKepler({
        datasetId: "imagery",
        provenance: { sourceId: "imagery" },
        source: {
          kind: "raster-tiles",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.png?X-Amz-Signature=deadbeef&X-Amz-Credential=abc"],
        },
      }),
    ).toThrowError(/credential-bearing query parameters/);
  });

  it("refuses a source URL with an embedded API key", () => {
    try {
      projectRemoteSourceToKepler({
        datasetId: "style",
        provenance: { sourceId: "style" },
        source: { kind: "style", url: "https://api.example.com/style.json?key=secret-value" },
      });
      throw new Error("expected a credential-leak rejection");
    } catch (error) {
      expect((error as HonuaKeplerBridgeError).code).toBe("credential-leak");
    }
  });
});

describe("KEPLER_BRIDGE_CAPABILITIES", () => {
  it("declares the direct paths as GeoJSON-free and the fallback as a round trip", () => {
    const byStrategy = new Map(KEPLER_BRIDGE_CAPABILITIES.map((entry) => [entry.strategy, entry]));

    expect(byStrategy.get("row-object-direct")?.geoJsonRoundTrip).toBe(false);
    expect(byStrategy.get("point-columns-direct")?.geoJsonRoundTrip).toBe(false);
    expect(byStrategy.get("columnar-columns-direct")?.geoJsonRoundTrip).toBe(false);
    expect(byStrategy.get("geojson-column")?.geoJsonRoundTrip).toBe(true);
    expect(byStrategy.get("arrow-columns-zero-copy")?.supported).toBe(false);
  });
});
