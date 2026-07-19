import { describe, expect, it, vi } from "vitest";

import { type ColumnarBatchIdentityV1, createGeoArrowBatch } from "../src/columnar/index.js";
import {
  type DeckGlLayer,
  bindGeoArrowLineBatchToDeckGl,
  bindGeoArrowPointBatchToDeckGl,
  bindGeoArrowPolygonBatchToDeckGl,
  createDeckGlAdapter,
} from "../src/deckgl/index.js";

class CapturingScatterplotLayer implements DeckGlLayer {
  public readonly id: string | undefined;
  public readonly data: {
    readonly length: number;
    readonly attributes: Readonly<Record<string, { readonly value: ArrayBufferView }>>;
  };

  public constructor(public readonly props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
    this.data = props.data as CapturingScatterplotLayer["data"];
  }
}

class CapturingPathLayer implements DeckGlLayer {
  public readonly id: string | undefined;
  public readonly data: {
    readonly length: number;
    readonly attributes: Readonly<Record<string, { readonly value: ArrayBufferView }>>;
    readonly startIndices: ArrayLike<number>;
  };

  public constructor(public readonly props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
    this.data = props.data as CapturingPathLayer["data"];
  }
}

class CapturingSolidPolygonLayer implements DeckGlLayer {
  public readonly id: string | undefined;
  public readonly data: {
    readonly length: number;
    readonly attributes: Readonly<Record<string, { readonly value: ArrayBufferView }>>;
    readonly startIndices: ArrayLike<number>;
  };

  public constructor(public readonly props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
    this.data = props.data as CapturingSolidPolygonLayer["data"];
  }
}

function identity(schemaVersion: string): ColumnarBatchIdentityV1 {
  return {
    sourceId: "incidents-live",
    sourceVersion: "42",
    schemaVersion,
    planId: "plan:sha256:abc",
    authorizationScope: "auth-scope:sha256:def",
    ordering: {
      stable: true,
      keys: [{ field: "feature_id", direction: "ascending", nulls: "last" }],
    },
    freshness: { observedAt: "2026-07-15T12:00:00Z", generation: "42" },
  };
}

describe("normative GeoArrow -> deck.gl direct path", () => {
  it("constructs and projects a ScatterplotLayer with no GeoJSON round-trip or payload copy", () => {
    const schemaId = "incidents@42";
    const { batch } = createGeoArrowBatch({
      id: "incidents:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId),
      geometry: {
        kind: "point",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [
          [-157.86, 21.31],
          [-157.77, 21.44],
          [-157.7, 21.4],
        ],
      },
      featureIds: { field: "feature_id", values: new Uint32Array([101, 102, 103]) },
    });
    const jsonStringify = vi.spyOn(JSON, "stringify");
    const jsonParse = vi.spyOn(JSON, "parse");

    const binding = bindGeoArrowPointBatchToDeckGl({
      batch,
      layerId: "incidents",
      props: { radiusUnits: "meters" },
    });
    const coordinates = batch.buffers.find(({ id }) => id === "geometry.coordinates")!;
    expect(binding.request.data.attributes.getPosition.value.buffer).toBe(coordinates.data);
    expect(binding.metrics).toEqual({
      rows: 3,
      positionBytes: 48,
      copiedBytes: 0,
      geoJsonFeaturesMaterialized: 0,
    });

    const projection = createDeckGlAdapter({
      peers: { ScatterplotLayer: CapturingScatterplotLayer },
    }).project(binding.request);
    const layer = projection.layer as CapturingScatterplotLayer;
    expect(layer.data.attributes.getPosition.value.buffer).toBe(coordinates.data);
    expect(layer.props).toMatchObject({ id: "incidents", radiusUnits: "meters", pickable: true });
    expect(projection.metrics).toMatchObject({ rows: 3, copiedBytes: 0 });
    expect(projection.selectionForPick(1)).toEqual({
      sourceId: "incidents-live",
      sourceVersion: "42",
      planId: "plan:sha256:abc",
      featureId: 102,
      rowIndex: 1,
    });
    // Exact admission inspects the one bounded extension-metadata descriptor;
    // no row, coordinate array, Feature, or FeatureCollection is serialized.
    expect(jsonStringify).toHaveBeenCalledTimes(1);
    expect(jsonStringify).toHaveBeenCalledWith({ crs: "OGC:CRS84" });
    expect(jsonParse).toHaveBeenCalledTimes(1);
    expect(jsonParse).toHaveBeenCalledWith('{"crs":"OGC:CRS84"}');
    jsonStringify.mockRestore();
    jsonParse.mockRestore();
  });

  it("fails explicitly when a zero-copy scatterplot cannot preserve separated, nullable, or M coordinates", () => {
    const make = (
      geometry:
        | { kind: "point"; coordinateLayout: "separated"; values: readonly (readonly number[])[] }
        | {
            kind: "point";
            coordinateLayout: "interleaved";
            dimensions?: "xym";
            values: readonly (readonly number[] | null)[];
          },
    ) => {
      const dimensions = "dimensions" in geometry ? geometry.dimensions : undefined;
      const schemaId = `unsupported:${geometry.coordinateLayout}:${dimensions ?? "xy"}`;
      return createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: { ...geometry, crs: "OGC:CRS84" },
      }).batch;
    };

    for (const batch of [
      make({ kind: "point", coordinateLayout: "separated", values: [[1, 2]] }),
      make({ kind: "point", coordinateLayout: "interleaved", values: [[1, 2], null] }),
      make({ kind: "point", coordinateLayout: "interleaved", dimensions: "xym", values: [[1, 2, 3]] }),
    ]) {
      expect(() => bindGeoArrowPointBatchToDeckGl({ batch, layerId: "unsupported" })).toThrowError(
        expect.objectContaining({ code: "invalid-data" }),
      );
    }
  });

  it("rejects forged normative storage and non-longitude/latitude CRS evidence", () => {
    const make = (crs?: string) => {
      const schemaId = `admission:${crs ?? "missing"}`;
      return createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: {
          kind: "point",
          coordinateLayout: "interleaved",
          ...(crs === undefined ? {} : { crs }),
          values: [[1, 2]],
        },
      }).batch;
    };

    for (const batch of [make(), make("EPSG:3857"), make("EPSG:4326")]) {
      expect(() => bindGeoArrowPointBatchToDeckGl({ batch, layerId: "wrong-crs" })).toThrowError(
        expect.objectContaining({ code: "invalid-data" }),
      );
    }

    const valid = make("OGC:CRS84");
    const geometry = valid.schema.fields[0]!;
    const forged = {
      ...valid,
      schema: {
        ...valid.schema,
        fields: [
          {
            ...geometry,
            children: [
              {
                ...geometry.children![0]!,
                type: { name: "fixed_size_list", parameters: { size: 3, valueType: "float64" } },
              },
            ],
          },
        ],
      },
    };
    expect(() => bindGeoArrowPointBatchToDeckGl({ batch: forged, layerId: "forged" })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );

    const coordinates = valid.buffers.find(({ id }) => id === "geometry.coordinates")!;
    new Float64Array(coordinates.data, coordinates.byteOffset, 2)[0] = Number.NaN;
    expect(() => bindGeoArrowPointBatchToDeckGl({ batch: valid, layerId: "nan" })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });
});

describe("normative GeoArrow LineString -> deck.gl direct path", () => {
  it("constructs and projects a PathLayer with no GeoJSON round-trip or payload copy", () => {
    const schemaId = "routes@1";
    const { batch } = createGeoArrowBatch({
      id: "routes:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId),
      geometry: {
        kind: "linestring",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [
          [
            [-157.86, 21.31],
            [-157.77, 21.44],
          ],
          [
            [-157.7, 21.4],
            [-157.6, 21.3],
            [-157.5, 21.2],
          ],
        ],
      },
      featureIds: { field: "feature_id", values: new Uint32Array([201, 202]) },
    });

    const binding = bindGeoArrowLineBatchToDeckGl({
      batch,
      layerId: "routes",
      props: { widthUnits: "meters" },
    });
    const coordinates = batch.buffers.find(({ id }) => id === "geometry.coordinates")!;
    const offsets = batch.buffers.find(({ id }) => id === "geometry.offsets")!;
    expect(binding.request.data.attributes.getPath.value.buffer).toBe(coordinates.data);
    expect((binding.request.data.startIndices as unknown as Int32Array).buffer).toBe(offsets.data);
    expect(binding.metrics).toEqual({
      rows: 2,
      vertices: 5,
      positionBytes: 80,
      copiedBytes: 0,
      geoJsonFeaturesMaterialized: 0,
    });

    const projection = createDeckGlAdapter({
      peers: { ScatterplotLayer: CapturingScatterplotLayer, PathLayer: CapturingPathLayer },
    }).project(binding.request);
    const layer = projection.layer as CapturingPathLayer;
    expect(layer.data.attributes.getPath.value.buffer).toBe(coordinates.data);
    expect(layer.props).toMatchObject({ id: "routes", widthUnits: "meters", pickable: true, _pathType: "open" });
    expect(projection.metrics).toMatchObject({ rows: 2, copiedBytes: 0 });
    expect(projection.selectionForPick(1)).toEqual({
      sourceId: "incidents-live",
      sourceVersion: "42",
      planId: "plan:sha256:abc",
      featureId: 202,
      rowIndex: 1,
    });
  });

  it("fails explicitly when a zero-copy path cannot preserve separated, nullable, or M coordinates", () => {
    const make = (
      geometry:
        | { kind: "linestring"; coordinateLayout: "separated"; values: readonly (readonly (readonly number[])[])[] }
        | {
            kind: "linestring";
            coordinateLayout: "interleaved";
            dimensions?: "xym";
            values: readonly (readonly (readonly number[])[] | null)[];
          },
    ) => {
      const dimensions = "dimensions" in geometry ? geometry.dimensions : undefined;
      const schemaId = `unsupported-line:${geometry.coordinateLayout}:${dimensions ?? "xy"}`;
      return createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: { ...geometry, crs: "OGC:CRS84" },
      }).batch;
    };

    for (const batch of [
      make({
        kind: "linestring",
        coordinateLayout: "separated",
        values: [
          [
            [1, 2],
            [3, 4],
          ],
        ],
      }),
      make({
        kind: "linestring",
        coordinateLayout: "interleaved",
        values: [
          [
            [1, 2],
            [3, 4],
          ],
          null,
        ],
      }),
      make({
        kind: "linestring",
        coordinateLayout: "interleaved",
        dimensions: "xym",
        values: [
          [
            [1, 2, 3],
            [4, 5, 6],
          ],
        ],
      }),
    ]) {
      expect(() => bindGeoArrowLineBatchToDeckGl({ batch, layerId: "unsupported" })).toThrowError(
        expect.objectContaining({ code: "invalid-data" }),
      );
    }
  });

  it.each(["spherical", "vincenty", "thomas", "andoyer", "karney"] as const)(
    "rejects %s GeoArrow edges that a direct PathLayer cannot preserve",
    (edges) => {
      const schemaId = `non-planar-line:${edges}`;
      const batch = createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: {
          kind: "linestring",
          coordinateLayout: "interleaved",
          crs: "OGC:CRS84",
          edges,
          values: [
            [
              [1, 2],
              [3, 4],
            ],
          ],
        },
      }).batch;

      expect(() => bindGeoArrowLineBatchToDeckGl({ batch, layerId: "non-planar" })).toThrowError(
        expect.objectContaining({ code: "invalid-data", detail: { edges, copiedBytes: 0 } }),
      );
    },
  );

  it("rejects forged normative storage and non-longitude/latitude CRS evidence", () => {
    const make = (crs?: string) => {
      const schemaId = `admission-line:${crs ?? "missing"}`;
      return createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: {
          kind: "linestring",
          coordinateLayout: "interleaved",
          ...(crs === undefined ? {} : { crs }),
          values: [
            [
              [1, 2],
              [3, 4],
            ],
          ],
        },
      }).batch;
    };

    for (const batch of [make(), make("EPSG:3857"), make("EPSG:4326")]) {
      expect(() => bindGeoArrowLineBatchToDeckGl({ batch, layerId: "wrong-crs" })).toThrowError(
        expect.objectContaining({ code: "invalid-data" }),
      );
    }

    const valid = make("OGC:CRS84");
    const geometry = valid.schema.fields[0]!;
    const vertices = geometry.children![0]!;
    const coordinate = vertices.children![0]!;
    const forged = {
      ...valid,
      schema: {
        ...valid.schema,
        fields: [
          {
            ...geometry,
            children: [
              {
                ...vertices,
                children: [
                  { ...coordinate, type: { name: "fixed_size_list", parameters: { size: 3, valueType: "float64" } } },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(() => bindGeoArrowLineBatchToDeckGl({ batch: forged, layerId: "forged" })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });
});

describe("normative GeoArrow Polygon -> deck.gl direct path", () => {
  const ring = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 0],
  ] as const;
  const otherRing = [
    [10, 10],
    [12, 10],
    [12, 12],
    [10, 10],
  ] as const;

  it("constructs and projects a SolidPolygonLayer with no GeoJSON round-trip or payload copy", () => {
    const schemaId = "parcels@1";
    const { batch } = createGeoArrowBatch({
      id: "parcels:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId),
      geometry: {
        kind: "polygon",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [[ring], [otherRing]],
      },
      featureIds: { field: "feature_id", values: new Uint32Array([301, 302]) },
    });

    const binding = bindGeoArrowPolygonBatchToDeckGl({
      batch,
      layerId: "parcels",
      props: { getFillColor: [255, 0, 0] },
    });
    const coordinates = batch.buffers.find(({ id }) => id === "geometry.coordinates")!;
    const ringOffsets = batch.buffers.find(({ id }) => id === "geometry.ring-offsets")!;
    expect(binding.request.data.attributes.getPolygon.value.buffer).toBe(coordinates.data);
    expect((binding.request.data.startIndices as unknown as Int32Array).buffer).toBe(ringOffsets.data);
    expect(binding.metrics).toEqual({
      rows: 2,
      vertices: 8,
      positionBytes: 128,
      copiedBytes: 0,
      geoJsonFeaturesMaterialized: 0,
    });

    const projection = createDeckGlAdapter({
      peers: { ScatterplotLayer: CapturingScatterplotLayer, SolidPolygonLayer: CapturingSolidPolygonLayer },
    }).project(binding.request);
    const layer = projection.layer as CapturingSolidPolygonLayer;
    expect(layer.data.attributes.getPolygon.value.buffer).toBe(coordinates.data);
    expect(layer.props).toMatchObject({ id: "parcels", pickable: true, _normalize: false });
    expect(projection.metrics).toMatchObject({ rows: 2, copiedBytes: 0 });
    expect(projection.selectionForPick(1)).toEqual({
      sourceId: "incidents-live",
      sourceVersion: "42",
      planId: "plan:sha256:abc",
      featureId: 302,
      rowIndex: 1,
    });
  });

  it("rejects polygons with holes and empty polygons as needing bounded conversion", () => {
    const schemaId = "holes@1";
    const withHole = createGeoArrowBatch({
      id: "holes:0",
      sequence: 0,
      schemaId,
      identity: {
        ...identity(schemaId),
        ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
      },
      geometry: {
        kind: "polygon",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [[ring, otherRing]],
      },
    }).batch;
    expect(() => bindGeoArrowPolygonBatchToDeckGl({ batch: withHole, layerId: "holes" })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );

    const emptySchemaId = "empty@1";
    const empty = createGeoArrowBatch({
      id: "empty:0",
      sequence: 0,
      schemaId: emptySchemaId,
      identity: {
        ...identity(emptySchemaId),
        ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
      },
      geometry: {
        kind: "polygon",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [[]],
      },
    }).batch;
    expect(() => bindGeoArrowPolygonBatchToDeckGl({ batch: empty, layerId: "empty" })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });

  it("fails explicitly when a zero-copy polygon cannot preserve separated, nullable, or M coordinates", () => {
    const make = (
      geometry:
        | {
            kind: "polygon";
            coordinateLayout: "separated";
            values: readonly (readonly (readonly (readonly number[])[])[])[];
          }
        | {
            kind: "polygon";
            coordinateLayout: "interleaved";
            dimensions?: "xym";
            values: readonly (readonly (readonly (readonly number[])[])[] | null)[];
          },
    ) => {
      const dimensions = "dimensions" in geometry ? geometry.dimensions : undefined;
      const schemaId = `unsupported-polygon:${geometry.coordinateLayout}:${dimensions ?? "xy"}`;
      return createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: { ...geometry, crs: "OGC:CRS84" },
      }).batch;
    };

    for (const batch of [
      make({ kind: "polygon", coordinateLayout: "separated", values: [[ring]] }),
      make({ kind: "polygon", coordinateLayout: "interleaved", values: [[ring], null] }),
      make({
        kind: "polygon",
        coordinateLayout: "interleaved",
        dimensions: "xym",
        values: [[ring.map((position) => [...position, 0])]],
      }),
    ]) {
      expect(() => bindGeoArrowPolygonBatchToDeckGl({ batch, layerId: "unsupported" })).toThrowError(
        expect.objectContaining({ code: "invalid-data" }),
      );
    }
  });

  it.each(["spherical", "vincenty", "thomas", "andoyer", "karney"] as const)(
    "rejects %s GeoArrow edges that a direct SolidPolygonLayer cannot preserve",
    (edges) => {
      const schemaId = `non-planar-polygon:${edges}`;
      const batch = createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: {
          kind: "polygon",
          coordinateLayout: "interleaved",
          crs: "OGC:CRS84",
          edges,
          values: [[ring]],
        },
      }).batch;

      expect(() => bindGeoArrowPolygonBatchToDeckGl({ batch, layerId: "non-planar" })).toThrowError(
        expect.objectContaining({ code: "invalid-data", detail: { edges, copiedBytes: 0 } }),
      );
    },
  );

  it("rejects forged normative storage and non-longitude/latitude CRS evidence", () => {
    const make = (crs?: string) => {
      const schemaId = `admission-polygon:${crs ?? "missing"}`;
      return createGeoArrowBatch({
        id: schemaId,
        sequence: 0,
        schemaId,
        identity: {
          ...identity(schemaId),
          ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
        },
        geometry: {
          kind: "polygon",
          coordinateLayout: "interleaved",
          ...(crs === undefined ? {} : { crs }),
          values: [[ring]],
        },
      }).batch;
    };

    for (const batch of [make(), make("EPSG:3857"), make("EPSG:4326")]) {
      expect(() => bindGeoArrowPolygonBatchToDeckGl({ batch, layerId: "wrong-crs" })).toThrowError(
        expect.objectContaining({ code: "invalid-data" }),
      );
    }

    const valid = make("OGC:CRS84");
    const geometry = valid.schema.fields[0]!;
    const rings = geometry.children![0]!;
    const vertices = rings.children![0]!;
    const coordinate = vertices.children![0]!;
    const forged = {
      ...valid,
      schema: {
        ...valid.schema,
        fields: [
          {
            ...geometry,
            children: [
              {
                ...rings,
                children: [
                  {
                    ...vertices,
                    children: [
                      {
                        ...coordinate,
                        type: { name: "fixed_size_list", parameters: { size: 3, valueType: "float64" } },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(() => bindGeoArrowPolygonBatchToDeckGl({ batch: forged, layerId: "forged" })).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });
});
