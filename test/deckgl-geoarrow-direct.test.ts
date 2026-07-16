import { describe, expect, it, vi } from "vitest";

import { type ColumnarBatchIdentityV1, createGeoArrowBatch } from "../src/columnar/index.js";
import { type DeckGlLayer, bindGeoArrowPointBatchToDeckGl, createDeckGlAdapter } from "../src/deckgl/index.js";

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
