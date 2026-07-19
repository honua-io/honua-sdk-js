import * as arrow from "apache-arrow";
import { describe, expect, it } from "vitest";

import {
  type ApacheArrowModuleLike,
  type ColumnarBatchIdentityV1,
  createGeoArrowBatch,
  decodeGeoArrowBatch,
  fromApacheArrowRecordBatch,
  loadApacheArrow,
  toApacheArrowRecordBatch,
} from "../src/columnar/index.js";

const arrowModule = arrow as unknown as ApacheArrowModuleLike;

async function arrowIpcBatches(recordBatches: readonly arrow.RecordBatch[]): Promise<readonly arrow.RecordBatch[]> {
  const bytes = await arrow.RecordBatchStreamWriter.writeAll(recordBatches).toUint8Array();
  const reader = await arrow.RecordBatchReader.from(bytes);
  const batches: arrow.RecordBatch[] = [];
  for await (const batch of reader) batches.push(batch);
  return batches;
}

async function throughArrowIpc(recordBatch: arrow.RecordBatch): Promise<arrow.RecordBatch> {
  const batches = await arrowIpcBatches([recordBatch]);
  expect(batches).toHaveLength(1);
  return batches[0]!;
}

function identity(schemaVersion: string, field = "feature_id"): ColumnarBatchIdentityV1 {
  return {
    sourceId: "places",
    sourceVersion: "v9",
    schemaVersion,
    planId: "plan:sha256:abc",
    authorizationScope: "auth-scope:sha256:def",
    ordering: { stable: true, keys: [{ field, direction: "ascending", nulls: "last" }] },
    freshness: { observedAt: "2026-07-15T12:00:00Z", generation: "9" },
  };
}

describe("optional Apache Arrow / GeoArrow adapter", () => {
  it("maps a full nullable interleaved point batch to a real RecordBatch and back with zero payload copies", async () => {
    const schemaId = "places@9";
    const created = createGeoArrowBatch({
      id: "places:0",
      sequence: 4,
      rowOffset: 20,
      schemaId,
      identity: identity(schemaId),
      geometry: {
        kind: "point",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [[-157.86, 21.31], null, [-157.77, 21.44]],
      },
      temporal: {
        field: "observed_at",
        unit: "nanosecond",
        timezone: "UTC",
        values: [11n, null, 33n],
      },
      dictionary: { field: "status", ordered: true, values: ["open", null, "closed"] },
      featureIds: { field: "feature_id", values: new Uint32Array([101, 102, 103]) },
    });

    const projected = await toApacheArrowRecordBatch(created.batch, { module: arrowModule });
    expect(projected.recordBatch).toBeInstanceOf(arrow.RecordBatch);
    expect(projected.recordBatch.numRows).toBe(3);
    expect(projected.recordBatch.schema.fields[0]?.metadata.get("ARROW:extension:name")).toBe("geoarrow.point");
    expect(projected.recordBatch.schema.fields[0]?.type.toString()).toBe("FixedSizeList[2]<Float64>");
    expect(projected.metrics).toMatchObject({ rows: 3, copiedBytes: 0 });

    const sourceCoordinates = created.batch.buffers.find(({ id }) => id === "geometry.coordinates")!.data;
    const arrowCoordinates = projected.recordBatch.getChildAt(0)!.data[0]!.children[0]!.values!;
    expect(arrowCoordinates.buffer).toBe(sourceCoordinates);

    const restored = fromApacheArrowRecordBatch(projected.recordBatch);
    expect(restored.metrics.copiedBytes).toBe(0);
    expect(restored.batch.buffers.find(({ id }) => id === "geometry.coordinates")?.data).toBe(sourceCoordinates);
    expect(restored.batch.identity).toEqual(identity(schemaId));
    expect(decodeGeoArrowBatch(restored.batch)).toEqual(decodeGeoArrowBatch(created.batch));
  });

  it("re-wraps logical views after Arrow IPC pads odd nullable and attribute buffers", async () => {
    const schemaId = "ipc-padded@1";
    const created = createGeoArrowBatch({
      id: "ipc-padded:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId),
      geometry: {
        kind: "point",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [[1, 2], null, [5, 6]],
      },
      temporal: { field: "observed_at", unit: "millisecond", values: [1n, null, 3n] },
      dictionary: { field: "status", values: ["a", null, "odd"] },
      featureIds: { field: "feature_id", values: new Uint32Array([10, 11, 12]) },
    });
    const projected = await toApacheArrowRecordBatch(created.batch, { module: arrowModule });
    const decoded = await throughArrowIpc(projected.recordBatch as arrow.RecordBatch);
    expect(decoded.getChildAt(0)!.data[0]!.nullBitmap.byteLength).toBeGreaterThan(1);
    expect(decoded.getChildAt(3)!.data[0]!.values.byteLength).toBeGreaterThan(3 * Uint32Array.BYTES_PER_ELEMENT);

    const restored = fromApacheArrowRecordBatch(decoded);
    const logicalBytes = restored.batch.buffers.reduce((total, { byteLength }) => total + byteLength, 0);
    expect(restored.metrics.copiedBytes).toBe(logicalBytes);
    expect(decodeGeoArrowBatch(restored.batch)).toEqual(decodeGeoArrowBatch(created.batch));
    expect(restored.batch.buffers.find(({ id }) => id === "geometry.validity")?.byteLength).toBe(1);
    expect(restored.batch.buffers.find(({ id }) => id === "feature_id.values")?.byteLength).toBe(12);
    for (const buffer of restored.batch.buffers) expect(buffer.data.byteLength, buffer.id).toBe(buffer.byteLength);
  });

  it.each([
    {
      name: "LineString",
      geometry: {
        kind: "linestring" as const,
        coordinateLayout: "interleaved" as const,
        values: [
          [
            [1, 2],
            [3, 4],
            [5, 6],
          ],
          [],
        ],
      },
      offsetIds: ["geometry.offsets"],
    },
    {
      name: "Polygon",
      geometry: {
        kind: "polygon" as const,
        coordinateLayout: "interleaved" as const,
        values: [
          [
            [
              [0, 0],
              [4, 0],
              [4, 4],
              [0, 0],
            ],
            [
              [1, 1],
              [2, 1],
              [2, 2],
              [1, 1],
            ],
          ],
          [],
        ],
      },
      offsetIds: ["geometry.offsets", "geometry.ring-offsets"],
    },
  ])("trims Arrow IPC padding from odd $name offset vectors without copying", async ({ geometry, offsetIds }) => {
    const schemaId = `ipc-offsets:${geometry.kind}`;
    const created = createGeoArrowBatch({
      id: schemaId,
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry,
    });
    const projected = await toApacheArrowRecordBatch(created.batch, { module: arrowModule });
    const decoded = await throughArrowIpc(projected.recordBatch as arrow.RecordBatch);
    const restored = fromApacheArrowRecordBatch(decoded);

    expect(restored.metrics.copiedBytes).toBeGreaterThan(0);
    expect(decodeGeoArrowBatch(restored.batch)).toEqual(decodeGeoArrowBatch(created.batch));
    for (const id of offsetIds) {
      const expected = created.batch.buffers.find((buffer) => buffer.id === id)!;
      const actual = restored.batch.buffers.find((buffer) => buffer.id === id)!;
      expect(actual.byteLength, id).toBe(expected.byteLength);
      expect(actual.data.byteLength, id).toBeGreaterThanOrEqual(actual.byteOffset + actual.byteLength);
    }
  });

  it("isolates one batch from a shared multi-batch IPC backing before it becomes transferable", async () => {
    const schemaId = "ipc-isolation@1";
    const make = (id: string, x: number) =>
      createGeoArrowBatch({
        id,
        sequence: 0,
        schemaId,
        identity: identity(schemaId, "geometry"),
        geometry: { kind: "point", coordinateLayout: "interleaved", values: [[x, 2]] },
      }).batch;
    const first = await toApacheArrowRecordBatch(make("ipc-isolation:a", 1), { module: arrowModule });
    const second = await toApacheArrowRecordBatch(make("ipc-isolation:b", 999), { module: arrowModule });
    const decoded = await arrowIpcBatches([
      first.recordBatch as arrow.RecordBatch,
      second.recordBatch as arrow.RecordBatch,
    ]);
    expect(decoded).toHaveLength(2);
    const firstForeignCoordinates = decoded[0]!.getChildAt(0)!.data[0]!.children[0]!.values;
    const secondForeignCoordinates = decoded[1]!.getChildAt(0)!.data[0]!.children[0]!.values;
    expect(firstForeignCoordinates.buffer).toBe(secondForeignCoordinates.buffer);

    const imported = fromApacheArrowRecordBatch(decoded[0]!);
    const coordinates = imported.batch.buffers.find(({ id }) => id === "geometry.coordinates")!;
    expect(imported.metrics.copiedBytes).toBe(coordinates.byteLength);
    expect(coordinates.data).not.toBe(firstForeignCoordinates.buffer);
    expect(coordinates.data).not.toBe(secondForeignCoordinates.buffer);
    expect(coordinates.byteOffset).toBe(0);
    expect(coordinates.data.byteLength).toBe(coordinates.byteLength);
    expect(decodeGeoArrowBatch(imported.batch).rows[0]?.geometry).toEqual([1, 2]);

    expect(() =>
      fromApacheArrowRecordBatch(decoded[0]!, { limits: { maxCopiedBytes: coordinates.byteLength - 1 } }),
    ).toThrowError(expect.objectContaining({ code: "copy-limit-exceeded" }));
  });

  it.each([
    {
      name: "separated Point",
      geometry: {
        kind: "point" as const,
        coordinateLayout: "separated" as const,
        values: [
          [1, 2],
          [3, 4],
        ],
      },
      arrowType: "Struct<{x:Float64, y:Float64}>",
    },
    {
      name: "interleaved LineString",
      geometry: {
        kind: "linestring" as const,
        coordinateLayout: "interleaved" as const,
        values: [
          [
            [1, 2],
            [3, 4],
          ],
          [],
        ],
      },
      arrowType: "List<FixedSizeList[2]<Float64>>",
    },
    {
      name: "separated Polygon",
      geometry: {
        kind: "polygon" as const,
        coordinateLayout: "separated" as const,
        values: [
          [
            [
              [0, 0],
              [2, 0],
              [2, 2],
              [0, 0],
            ],
          ],
          null,
        ],
      },
      arrowType: "List<List<Struct<{x:Float64, y:Float64}>>>",
    },
  ])("uses the official Arrow memory shape for $name", async ({ geometry, arrowType }) => {
    const schemaId = `shape:${geometry.kind}`;
    const created = createGeoArrowBatch({
      id: schemaId,
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry,
    });
    const projected = await toApacheArrowRecordBatch(created.batch, { module: arrowModule });

    expect(projected.recordBatch.schema.fields[0]?.type.toString()).toBe(arrowType);
    expect(decodeGeoArrowBatch(fromApacheArrowRecordBatch(projected.recordBatch).batch)).toEqual(
      decodeGeoArrowBatch(created.batch),
    );
  });

  it("loads the peer lazily through an injectable importer", async () => {
    const calls: string[] = [];
    const loaded = await loadApacheArrow({
      importModule: async (specifier) => {
        calls.push(specifier);
        return arrow;
      },
    });
    expect(loaded.RecordBatch).toBe(arrow.RecordBatch);
    expect(calls).toEqual(["apache-arrow"]);
  });

  it("imports a standards-compliant GeoArrow RecordBatch without private Honua metadata", async () => {
    const sourceSchemaId = "standard-source@1";
    const created = createGeoArrowBatch({
      id: "standard-source:0",
      sequence: 0,
      schemaId: sourceSchemaId,
      identity: identity(sourceSchemaId),
      geometry: {
        kind: "point",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [
          [1, 2],
          [3, 4],
        ],
      },
      temporal: { field: "observed_at", unit: "millisecond", values: [1n, 2n] },
      dictionary: { field: "status", ordered: false, values: ["open", "closed"] },
      featureIds: { field: "feature_id", values: new Uint32Array([10, 11]) },
    });
    const projected = await toApacheArrowRecordBatch(created.batch, { module: arrowModule });
    const honuaRecordBatch = projected.recordBatch as arrow.RecordBatch;
    const standard = new arrow.RecordBatch(
      new arrow.Schema([...honuaRecordBatch.schema.fields]),
      honuaRecordBatch.data,
    );
    expect(standard.schema.metadata.size).toBe(0);

    const schemaId = "standard-import@1";
    const imported = fromApacheArrowRecordBatch(standard, {
      id: "standard-import:0",
      schemaId,
      identity: identity(schemaId),
    });
    expect(imported.metrics.copiedBytes).toBe(0);
    expect(imported.batch.buffers.find(({ id }) => id === "geometry.coordinates")?.data).toBe(
      created.batch.buffers.find(({ id }) => id === "geometry.coordinates")?.data,
    );
    expect(decodeGeoArrowBatch(imported.batch).rows).toEqual(decodeGeoArrowBatch(created.batch).rows);

    expect(() => fromApacheArrowRecordBatch(standard)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });

  it("reports structured missing-peer failures without importing Arrow on lightweight paths", async () => {
    const cause = new Error("not installed");
    await expect(
      loadApacheArrow({
        importModule: async () => {
          throw cause;
        },
      }),
    ).rejects.toMatchObject({
      name: "HonuaGeoArrowError",
      code: "missing-peer",
      cause,
      detail: { package: "apache-arrow" },
    });

    await expect(loadApacheArrow({ importModule: async () => ({ RecordBatch: class {} }) })).rejects.toMatchObject({
      code: "missing-peer",
      detail: { package: "apache-arrow", export: expect.any(String) },
    });
  });

  it("rejects sliced or shared foreign buffers instead of hiding a copy", async () => {
    const schemaId = "sliced@1";
    const { batch } = createGeoArrowBatch({
      id: "sliced:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: {
        kind: "point",
        values: [
          [1, 2],
          [3, 4],
        ],
      },
    });
    const { recordBatch } = await toApacheArrowRecordBatch(batch, { module: arrowModule });
    const geometry = recordBatch.getChildAt(0)!;
    const foreign = {
      numRows: recordBatch.numRows,
      schema: recordBatch.schema,
      getChildAt(index: number) {
        if (index !== 0) return recordBatch.getChildAt(index);
        return { ...geometry, data: [{ ...geometry.data[0]!, offset: 1 }] };
      },
    };

    expect(() => fromApacheArrowRecordBatch(foreign)).toThrowError(
      expect.objectContaining({ code: "unsupported-layout" }),
    );
  });

  it("rejects nullable child and feature-id storage that cannot be represented losslessly", async () => {
    const schemaId = "foreign-nulls@1";
    const { batch } = createGeoArrowBatch({
      id: "foreign-nulls:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId),
      geometry: { kind: "point", coordinateLayout: "interleaved", values: [[1, 2]] },
      featureIds: { field: "feature_id", values: new Uint32Array([1]) },
    });
    const { recordBatch } = await toApacheArrowRecordBatch(batch, { module: arrowModule });
    const geometry = recordBatch.getChildAt(0)!;
    const geometryNode = geometry.data[0]!;
    const coordinateNode = geometryNode.children[0]!;
    const nullableCoordinate = {
      numRows: recordBatch.numRows,
      schema: recordBatch.schema,
      getChildAt(index: number) {
        if (index !== 0) return recordBatch.getChildAt(index);
        return {
          ...geometry,
          data: [{ ...geometryNode, children: [{ ...coordinateNode, nullBitmap: new Uint8Array([0]) }] }],
        };
      },
    };
    expect(() => fromApacheArrowRecordBatch(nullableCoordinate)).toThrowError(
      expect.objectContaining({ code: "unsupported-layout" }),
    );

    const featureIds = recordBatch.getChildAt(1)!;
    const nullableIds = {
      numRows: recordBatch.numRows,
      schema: recordBatch.schema,
      getChildAt(index: number) {
        if (index !== 1) return recordBatch.getChildAt(index);
        return { ...featureIds, data: [{ ...featureIds.data[0]!, nullBitmap: new Uint8Array([0]) }] };
      },
    };
    expect(() => fromApacheArrowRecordBatch(nullableIds)).toThrowError(
      expect.objectContaining({ code: "unsupported-layout" }),
    );
  });

  it("bounds private transport metadata before JSON parsing", async () => {
    const schemaId = "metadata-bounds@1";
    const { batch } = createGeoArrowBatch({
      id: "metadata-bounds:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: { kind: "point", values: [[1, 2]] },
    });
    const { recordBatch } = await toApacheArrowRecordBatch(batch, { module: arrowModule });
    const metadata = new Map(recordBatch.schema.metadata);
    metadata.set("honua.columnar.schema.json", `{"padding":"${"x".repeat(128)}"}`);
    const foreign = { ...recordBatch, schema: { ...recordBatch.schema, metadata } };
    expect(() => fromApacheArrowRecordBatch(foreign, { limits: { maxStringBytes: 64 } })).toThrowError(
      expect.objectContaining({ code: "invalid-batch" }),
    );
  });

  it("rejects Arrow field type and extension metadata drift before re-wrapping buffers", async () => {
    const schemaId = "arrow-forged@1";
    const { batch } = createGeoArrowBatch({
      id: "arrow-forged:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: { kind: "point", coordinateLayout: "interleaved", values: [[1, 2]] },
    });
    const { recordBatch } = await toApacheArrowRecordBatch(batch, { module: arrowModule });
    const geometryField = recordBatch.schema.fields[0]!;
    const foreign = {
      numRows: recordBatch.numRows,
      schema: {
        metadata: recordBatch.schema.metadata,
        fields: [{ ...geometryField, type: { toString: () => "Float32" } }],
      },
      getChildAt: recordBatch.getChildAt.bind(recordBatch),
    };

    expect(() => fromApacheArrowRecordBatch(foreign)).toThrowError(expect.objectContaining({ code: "invalid-batch" }));

    const nullableCoordinateType = new arrow.FixedSizeList(2, new arrow.Field("xy", new arrow.Float64(), true));
    const nullableCoordinateField = new arrow.Field(
      geometryField.name,
      nullableCoordinateType,
      geometryField.nullable,
      new Map(geometryField.metadata),
    );
    const forgedNestedNullability = {
      numRows: recordBatch.numRows,
      schema: {
        metadata: recordBatch.schema.metadata,
        fields: [nullableCoordinateField],
      },
      getChildAt: recordBatch.getChildAt.bind(recordBatch),
    };
    expect(() => fromApacheArrowRecordBatch(forgedNestedNullability)).toThrowError(
      expect.objectContaining({ code: "invalid-batch" }),
    );
  });
});
