import { describe, expect, it } from "vitest";
import {
  type ColumnarBatchIdentityV1,
  type ColumnarBatchV1,
  DEFAULT_COLUMNAR_RESULT_MAX_FEATURES,
  type HonuaGeoArrowError,
  columnarBatchToResult,
  createGeoArrowBatch,
  inspectGeoArrowBatch,
  resultToColumnarBatch,
} from "../src/columnar/index.js";
import type { Result } from "../src/contract/types.js";

/** A batch identity must declare the schema id it belongs to. */
function identity(schemaVersion: string, overrides: Partial<ColumnarBatchIdentityV1> = {}): ColumnarBatchIdentityV1 {
  return {
    sourceId: "places",
    sourceVersion: "2026-08-01",
    schemaVersion,
    planId: "plan:places",
    authorizationScope: "scope:public",
    ordering: { stable: true, keys: [{ field: "fid", direction: "ascending", nulls: "last" }] },
    freshness: {
      observedAt: "2026-08-03T00:00:00.000Z",
      staleAfter: "2026-08-03T01:00:00.000Z",
      validator: 'W/"etag-1"',
      generation: "7",
    },
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: HonuaGeoArrowError["code"]): HonuaGeoArrowError {
  let thrown: unknown;
  expect(() => {
    try {
      action();
    } catch (error) {
      thrown = error;
      throw error;
    }
  }).toThrowError(expect.objectContaining({ name: "HonuaGeoArrowError", code }));
  return thrown as HonuaGeoArrowError;
}

function bufferView(batch: ColumnarBatchV1, id: string): Float64Array {
  const descriptor = batch.buffers.find((candidate) => candidate.id === id);
  if (!descriptor) throw new Error(`buffer ${id} is missing`);
  return new Float64Array(descriptor.data, descriptor.byteOffset, descriptor.byteLength / 8);
}

const CEILING = { maxFeatures: DEFAULT_COLUMNAR_RESULT_MAX_FEATURES } as const;

describe("bounded columnar batch to object Result conversion (#942)", () => {
  it("converts point geometry, declared attribute columns, and explicit nulls", () => {
    const { batch } = createGeoArrowBatch({
      id: "batch-points",
      sequence: 3,
      rowOffset: 100,
      schemaId: "places-v1",
      identity: identity("places-v1"),
      geometry: { kind: "point", values: [[-157.8, 21.3], null, [-158, 21.5]] },
      temporal: { field: "observedAt", unit: "microsecond", values: [1_000n, null, 3_000n] },
      dictionary: { field: "category", values: ["park", null, "beach"] },
      featureIds: { field: "fid", values: [10, 11, 12] },
    });

    const result = columnarBatchToResult(batch, CEILING);

    expect(result.features).toEqual([
      {
        attributes: { fid: 10, observedAt: 1_000n, category: "park" },
        geometry: { type: "Point", coordinates: [-157.8, 21.3] },
      },
      { attributes: { fid: 11, observedAt: null, category: null }, geometry: null },
      {
        attributes: { fid: 12, observedAt: 3_000n, category: "beach" },
        geometry: { type: "Point", coordinates: [-158, 21.5] },
      },
    ]);
    // A null temporal or dictionary value is an explicit null attribute, never
    // an omitted key and never a zero.
    expect(Object.keys(result.features[1]!.attributes)).toEqual(["fid", "observedAt", "category"]);
    expect(result.totalCount).toBe(3);
    expect(result.exceededTransferLimit).toBe(false);
    expect(result.fields).toEqual([
      { name: "fid", type: "esriFieldTypeOID", nullable: false, editable: false },
      { name: "observedAt", type: "esriFieldTypeDate", nullable: true },
      { name: "category", type: "esriFieldTypeString", nullable: true },
    ]);
    expect(result.columnar).toMatchObject({
      batchId: "batch-points",
      schemaId: "places-v1",
      sequence: 3,
      batchRowCount: 3,
      offset: 0,
      count: 3,
      rowOffset: 100,
      maxFeatures: DEFAULT_COLUMNAR_RESULT_MAX_FEATURES,
      geometry: { kind: "point", field: "geometry", dimensions: "xy", coordinateLayout: "separated", edges: "planar" },
      attributes: {
        featureId: { attribute: "fid" },
        temporal: { attribute: "observedAt", unit: "microsecond" },
        dictionary: { attribute: "category", ordered: false },
      },
    });
    // The bounded object view carries the batch's own ordering and freshness,
    // so it can never look fresher than the batch it was cut from.
    expect(result.columnar.identity.freshness).toEqual(identity("places-v1").freshness);
    expect(result.columnar.identity.ordering).toEqual(identity("places-v1").ordering);
  });

  it("preserves linestring, polygon, empty geometry, Z dimensions, and a non-4326 CRS", () => {
    const lines = createGeoArrowBatch({
      id: "batch-lines",
      sequence: 0,
      schemaId: "lines-v1",
      identity: identity("lines-v1"),
      geometry: {
        kind: "linestring",
        dimensions: "xyz",
        crs: "EPSG:3857",
        values: [
          [
            [0, 0, 5],
            [10, 20, 6],
          ],
          [],
          null,
        ],
      },
    }).batch;

    const lineResult = columnarBatchToResult(lines, CEILING);
    expect(lineResult.crs).toBe("EPSG:3857");
    expect(lineResult.features.map((feature) => feature.geometry)).toEqual([
      {
        type: "LineString",
        coordinates: [
          [0, 0, 5],
          [10, 20, 6],
        ],
      },
      { type: "LineString", coordinates: [] },
      null,
    ]);

    const projjson = { type: "GeographicCRS", name: "WGS 84 (CRS84)" } as const;
    const polygons = createGeoArrowBatch({
      id: "batch-polygons",
      sequence: 0,
      schemaId: "polygons-v1",
      identity: identity("polygons-v1"),
      geometry: {
        kind: "polygon",
        crs: projjson,
        values: [
          [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [0, 0],
            ],
          ],
          [],
          null,
        ],
      },
    }).batch;

    const polygonResult = columnarBatchToResult(polygons, CEILING);
    expect(polygonResult.crs).toEqual(projjson);
    expect(polygonResult.features.map((feature) => feature.geometry)).toEqual([
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      { type: "Polygon", coordinates: [] },
      null,
    ]);
  });

  it("refuses xym and xyzm geometry rather than silently dropping the M coordinate", () => {
    const { batch } = createGeoArrowBatch({
      id: "batch-measured",
      sequence: 0,
      schemaId: "measured-v1",
      identity: identity("measured-v1"),
      geometry: { kind: "point", dimensions: "xym", values: [[1, 2, 3]] },
    });
    const error = expectCode(() => columnarBatchToResult(batch, CEILING), "unsupported-layout");
    expect(error.message).toContain("M coordinate");
  });

  it("converts only the requested contiguous window", () => {
    const values = Array.from({ length: 10 }, (_, row) => [row, row * 2] as const);
    const { batch } = createGeoArrowBatch({
      id: "batch-window",
      sequence: 0,
      schemaId: "window-v1",
      identity: identity("window-v1"),
      geometry: { kind: "point", values: values.map((value) => [...value]) },
      featureIds: { field: "fid", values: values.map((_, row) => row) },
    });

    const page = columnarBatchToResult(batch, { offset: 4, limit: 3, maxFeatures: 8 });
    expect(page.features.map((feature) => feature.attributes.fid)).toEqual([4, 5, 6]);
    expect(page.exceededTransferLimit).toBe(true);
    expect(page.totalCount).toBe(10);
    expect(page.columnar).toMatchObject({ offset: 4, count: 3, batchRowCount: 10 });

    // A limit past the end of the batch clamps instead of over-reading.
    expect(columnarBatchToResult(batch, { offset: 8, limit: 50, maxFeatures: 8 }).features).toHaveLength(2);
    expect(columnarBatchToResult(batch, { offset: 10, maxFeatures: 8 }).features).toHaveLength(0);
    expectCode(() => columnarBatchToResult(batch, { offset: 11, maxFeatures: 8 }), "invalid-input");
  });

  it("does not read payload outside the window", () => {
    const { batch } = createGeoArrowBatch({
      id: "batch-poison",
      sequence: 0,
      schemaId: "poison-v1",
      identity: identity("poison-v1"),
      geometry: { kind: "point", values: Array.from({ length: 10 }, (_, row) => [row, row]) },
    });
    // Corrupt a row outside the window after the batch was built.
    bufferView(batch, "geometry.x")[9] = Number.NaN;

    expect(columnarBatchToResult(batch, { offset: 0, limit: 3, maxFeatures: 10 }).features).toHaveLength(3);
    // The same corruption inside the window still fails closed, and the
    // unbounded inspection still scans the whole batch as before.
    expectCode(() => columnarBatchToResult(batch, { offset: 8, limit: 2, maxFeatures: 10 }), "invalid-batch");
    expectCode(() => inspectGeoArrowBatch(batch), "invalid-batch");
  });
});

describe("columnar Result conversion ceiling (#942 REQ-003)", () => {
  function threeRowBatch(): ColumnarBatchV1 {
    return createGeoArrowBatch({
      id: "batch-ceiling",
      sequence: 0,
      schemaId: "ceiling-v1",
      identity: identity("ceiling-v1"),
      geometry: {
        kind: "point",
        values: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      },
    }).batch;
  }

  it("throws a typed error naming the ceiling and the requested count", () => {
    const error = expectCode(() => columnarBatchToResult(threeRowBatch(), { maxFeatures: 2 }), "row-limit-exceeded");
    expect(error.message).toContain("3");
    expect(error.message).toContain("2");
    expect(error.detail).toMatchObject({ resource: "maxFeatures", requested: 3, limit: 2 });
  });

  it("allocates nothing before refusing: an unreadable batch never reaches inspection", () => {
    // Same input, two ceilings. Over the ceiling the conversion refuses without
    // inspecting the batch; under the ceiling it inspects and reports the real
    // corruption. That ordering is the proof that no feature was materialized.
    const broken = { ...threeRowBatch(), buffers: [] } as ColumnarBatchV1;
    expectCode(() => columnarBatchToResult(broken, { maxFeatures: 2 }), "row-limit-exceeded");
    expectCode(() => columnarBatchToResult(broken, { maxFeatures: 3 }), "invalid-batch");
  });

  it("has no sentinel that disables the ceiling", () => {
    const batch = threeRowBatch();
    for (const maxFeatures of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 1.5]) {
      expectCode(() => columnarBatchToResult(batch, { maxFeatures }), "invalid-input");
    }
    expectCode(() => columnarBatchToResult(batch, undefined as never), "invalid-input");
    // A window under the ceiling is the only way through.
    expect(columnarBatchToResult(batch, { limit: 2, maxFeatures: 2 }).features).toHaveLength(2);
  });

  it("bounds the inverse direction with the same ceiling", () => {
    const result = columnarBatchToResult(threeRowBatch(), CEILING);
    const error = expectCode(() => resultToColumnarBatch(result, { maxFeatures: 2 }), "row-limit-exceeded");
    expect(error.detail).toMatchObject({ requested: 3, limit: 2 });
    expectCode(() => resultToColumnarBatch(result, { maxFeatures: 0 }), "invalid-input");
  });
});

describe("object Result to columnar batch conversion (#942 REQ-007)", () => {
  it("round-trips geometry, attributes, ids, nulls, and CRS in both directions", () => {
    const cases = [
      {
        name: "point xy",
        geometry: { kind: "point", crs: "EPSG:3857", values: [[1, 2], null, [3, 4]] },
      },
      {
        name: "point xyz",
        geometry: { kind: "point", dimensions: "xyz", values: [[1, 2, 3], null, [4, 5, 6]] },
      },
      {
        name: "linestring with an empty geometry",
        geometry: {
          kind: "linestring",
          values: [
            [
              [0, 0],
              [1, 1],
            ],
            [],
            null,
          ],
        },
      },
      {
        name: "polygon with an empty geometry",
        geometry: {
          kind: "polygon",
          values: [
            [
              [
                [0, 0],
                [0, 1],
                [1, 1],
                [0, 0],
              ],
            ],
            [],
            null,
          ],
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { batch } = createGeoArrowBatch({
        id: "round-trip",
        sequence: 1,
        schemaId: "round-trip-v1",
        identity: identity("round-trip-v1"),
        geometry: testCase.geometry as never,
        temporal: { field: "observedAt", unit: "nanosecond", values: [9_007_199_254_740_993n, null, 2n] },
        dictionary: { field: "category", ordered: true, values: ["park", null, "beach"] },
        featureIds: { field: "fid", values: [1, 2, 3] },
      });

      const forward = columnarBatchToResult(batch, CEILING);
      // Provenance alone carries batch identity, layout, and attribute bindings.
      const rebuilt = resultToColumnarBatch(forward, CEILING);
      const back = columnarBatchToResult(rebuilt.batch, CEILING);

      expect(back.features, testCase.name).toEqual(forward.features);
      expect(back.crs, testCase.name).toEqual(forward.crs);
      expect(back.columnar.geometry, testCase.name).toEqual(forward.columnar.geometry);
      expect(back.columnar.attributes, testCase.name).toEqual(forward.columnar.attributes);
      expect(back.columnar.identity, testCase.name).toEqual(forward.columnar.identity);
      expect(rebuilt.batch.schema, testCase.name).toEqual(batch.schema);
    }
  });

  it("accepts a plain object-path Result when the caller declares the layout", () => {
    const objectPath: Result = {
      features: [
        { attributes: { fid: 7, label: "one" }, geometry: { type: "Point", coordinates: [1, 2] } },
        { attributes: { fid: 8, label: null }, geometry: null },
      ],
      exceededTransferLimit: false,
    };

    const created = resultToColumnarBatch(objectPath, {
      maxFeatures: 10,
      id: "from-object-path",
      schemaId: "object-path-v1",
      identity: identity("object-path-v1"),
      geometry: { crs: "EPSG:4326" },
      attributes: { featureId: { attribute: "fid" }, dictionary: { attribute: "label" } },
    });

    const converted = columnarBatchToResult(created.batch, CEILING);
    expect(converted.features).toEqual(objectPath.features);
    expect(converted.crs).toBe("EPSG:4326");
    expect(converted.columnar.geometry.kind).toBe("point");
  });

  it("fails closed on missing identity, mixed geometry kinds, and non-GeoJSON geometry", () => {
    const objectPath: Result = {
      features: [{ attributes: {}, geometry: { type: "Point", coordinates: [1, 2] } }],
      exceededTransferLimit: false,
    };
    expectCode(() => resultToColumnarBatch(objectPath, { maxFeatures: 4 }), "invalid-input");

    const declared = { maxFeatures: 4, id: "x", schemaId: "x-v1", identity: identity("x-v1") } as const;
    expectCode(
      () =>
        resultToColumnarBatch(
          {
            features: [
              { attributes: {}, geometry: { type: "Point", coordinates: [1, 2] } },
              { attributes: {}, geometry: { type: "LineString", coordinates: [[1, 2]] } },
            ],
            exceededTransferLimit: false,
          },
          declared,
        ),
      "unsupported-layout",
    );
    // An Esri geometry envelope carries no GeoJSON type and is refused rather
    // than guessed at.
    expectCode(
      () =>
        resultToColumnarBatch(
          { features: [{ attributes: {}, geometry: { x: 1, y: 2 } }], exceededTransferLimit: false },
          declared,
        ),
      "invalid-input",
    );
    // A feature-id column is not nullable.
    expectCode(
      () =>
        resultToColumnarBatch(
          { features: [{ attributes: {}, geometry: null }], exceededTransferLimit: false },
          { ...declared, geometry: { kind: "point" }, attributes: { featureId: { attribute: "fid" } } },
        ),
      "invalid-input",
    );
    // An all-null window cannot imply a geometry kind.
    expectCode(
      () =>
        resultToColumnarBatch(
          { features: [{ attributes: {}, geometry: null }], exceededTransferLimit: false },
          declared,
        ),
      "invalid-input",
    );
  });

  it("converts a bounded window of a Result and tracks its absolute row offset", () => {
    const { batch } = createGeoArrowBatch({
      id: "paged",
      sequence: 0,
      rowOffset: 500,
      schemaId: "paged-v1",
      identity: identity("paged-v1"),
      geometry: { kind: "point", values: Array.from({ length: 6 }, (_, row) => [row, row]) },
      featureIds: { field: "fid", values: [0, 1, 2, 3, 4, 5] },
    });

    const result = columnarBatchToResult(batch, { offset: 2, limit: 4, maxFeatures: 4 });
    expect(result.columnar.rowOffset).toBe(502);

    const created = resultToColumnarBatch(result, { offset: 1, limit: 2, maxFeatures: 2 });
    expect(created.batch.rowOffset).toBe(503);
    expect(columnarBatchToResult(created.batch, CEILING).features.map((f) => f.attributes.fid)).toEqual([3, 4]);
  });
});

describe("object-path parity (#942 REQ-006)", () => {
  it("produces a Result equal to the object path for the same source rows", () => {
    const rows = [
      { fid: 1, category: "park", observedAt: 1_000n, coordinates: [-157.8, 21.3] },
      { fid: 2, category: null, observedAt: null, coordinates: null },
      { fid: 3, category: "beach", observedAt: 3_000n, coordinates: [-158, 21.5] },
    ] as const;

    // What a protocol adapter on the object path returns for these rows.
    const objectPath: Result = {
      features: rows.map((row) => ({
        attributes: { fid: row.fid, observedAt: row.observedAt, category: row.category },
        geometry: row.coordinates === null ? null : { type: "Point", coordinates: [...row.coordinates] },
      })),
      exceededTransferLimit: false,
      totalCount: rows.length,
    };

    // The same rows executed on the columnar path.
    const { batch } = createGeoArrowBatch({
      id: "parity",
      sequence: 0,
      schemaId: "parity-v1",
      identity: identity("parity-v1"),
      geometry: { kind: "point", values: rows.map((row) => (row.coordinates === null ? null : [...row.coordinates])) },
      temporal: { field: "observedAt", unit: "millisecond", values: rows.map((row) => row.observedAt) },
      dictionary: { field: "category", values: rows.map((row) => row.category) },
      featureIds: { field: "fid", values: rows.map((row) => row.fid) },
    });
    const converted = columnarBatchToResult(batch, CEILING);

    expect(converted.features).toEqual(objectPath.features);
    expect(converted.exceededTransferLimit).toBe(objectPath.exceededTransferLimit);
    expect(converted.totalCount).toBe(objectPath.totalCount);
    // Ordering is positional and identical, not merely set-equal.
    expect(converted.features.map((feature) => feature.attributes.fid)).toEqual([1, 2, 3]);
    converted.features.forEach((feature, index) => {
      expect(feature.geometry).toEqual(objectPath.features[index]!.geometry);
      expect(feature.attributes).toEqual(objectPath.features[index]!.attributes);
    });
  });
});
