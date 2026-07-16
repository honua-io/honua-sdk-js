import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";

import {
  type ColumnarBatchIdentityV1,
  type ColumnarTransferMessageV1,
  GEOARROW_SPEC_VERSION,
  HONUA_GEOARROW_LAYOUT_VERSION,
  createGeoArrowBatch,
  decodeGeoArrowBatch,
  inspectGeoArrowBatch,
  leaseColumnarBatch,
} from "../src/columnar/index.js";

function identity(schemaVersion: string, orderField = "feature_id"): ColumnarBatchIdentityV1 {
  return {
    sourceId: "incidents-live",
    sourceVersion: "source:v42",
    schemaVersion,
    planId: "plan:sha256:abc",
    authorizationScope: "auth-scope:sha256:def",
    ordering: {
      stable: true,
      keys: [{ field: orderField, direction: "ascending", nulls: "last" }],
    },
    freshness: {
      observedAt: "2026-07-15T12:00:00Z",
      staleAfter: "2026-07-15T12:00:30Z",
      validator: 'W/"incidents-42"',
      generation: "42",
    },
  };
}

describe("normative Honua GeoArrow batches", () => {
  it("round-trips nullable separated points, CRS, timestamps, dictionaries, identity, and order", () => {
    const schemaId = "incidents-schema@7";
    const created = createGeoArrowBatch({
      id: "incidents:batch:9",
      sequence: 9,
      rowOffset: 30,
      schemaId,
      identity: identity(schemaId),
      geometry: {
        kind: "point",
        coordinateLayout: "separated",
        dimensions: "xy",
        crs: {
          $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
          type: "GeographicCRS",
          name: "WGS 84 (CRS84)",
        },
        values: [[-157.86, 21.31], null, [-157.77, 21.44]],
      },
      temporal: {
        field: "observed_at",
        unit: "millisecond",
        timezone: "UTC",
        values: [1_721_044_800_000n, null, 1_721_044_802_000n],
      },
      dictionary: { field: "status", ordered: true, values: ["open", null, "open"] },
      featureIds: { field: "feature_id", values: new Uint32Array([101, 102, 103]) },
    });

    expect(created.batch.identity).toEqual(identity(schemaId));
    expect(created.batch.schema.metadata).toMatchObject({
      "honua.geoarrow.layout.version": HONUA_GEOARROW_LAYOUT_VERSION,
      "honua.geoarrow.spec.version": GEOARROW_SPEC_VERSION,
      "honua.geoarrow.geometry.kind": "point",
      "honua.geoarrow.geometry.coordinate-layout": "separated",
    });
    expect(created.batch.schema.fields[0]?.metadata).toMatchObject({
      "ARROW:extension:name": "geoarrow.point",
    });
    expect(created.metrics).toMatchObject({ rows: 3, vertices: 3, rings: 0, dictionaryValues: 1 });
    expect(created.metrics.copiedBytes).toBe(created.metrics.backingBytes);

    const inspection = inspectGeoArrowBatch(created.batch);
    expect(inspection.geometry.coordinates.x?.buffer).toBe(
      created.batch.buffers.find(({ id }) => id === "geometry.x")?.data,
    );
    expect(inspection.geometry.coordinates.y?.buffer).toBe(
      created.batch.buffers.find(({ id }) => id === "geometry.y")?.data,
    );
    expect(inspection.metrics.copiedBytes).toBe(0);

    expect(decodeGeoArrowBatch(created.batch)).toEqual({
      rows: [
        {
          geometry: [-157.86, 21.31],
          timestamp: 1_721_044_800_000n,
          dictionaryValue: "open",
          featureId: 101,
        },
        { geometry: null, timestamp: null, dictionaryValue: null, featureId: 102 },
        {
          geometry: [-157.77, 21.44],
          timestamp: 1_721_044_802_000n,
          dictionaryValue: "open",
          featureId: 103,
        },
      ],
      metrics: { rows: 3, vertices: 3, rings: 0, dictionaryValues: 1, materializedRows: 3 },
    });
  });

  it("round-trips interleaved LineString offsets without object conversion in inspection", () => {
    const schemaId = "routes@1";
    const created = createGeoArrowBatch({
      id: "routes:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: {
        kind: "linestring",
        coordinateLayout: "interleaved",
        values: [
          [
            [0, 0],
            [1, 1],
          ],
          null,
          [],
          [
            [2, 3],
            [4, 5],
            [6, 7],
          ],
        ],
      },
    });

    const inspection = inspectGeoArrowBatch(created.batch);
    expect(Array.from(inspection.geometry.offsets ?? [])).toEqual([0, 2, 2, 2, 5]);
    expect(Array.from(inspection.geometry.coordinates.interleaved ?? [])).toEqual([0, 0, 1, 1, 2, 3, 4, 5, 6, 7]);
    expect(decodeGeoArrowBatch(created.batch).rows.map(({ geometry }) => geometry)).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
      null,
      [],
      [
        [2, 3],
        [4, 5],
        [6, 7],
      ],
    ]);
  });

  it("round-trips polygon ring offsets and enforces closed rings", () => {
    const schemaId = "parcels@2";
    const ring = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 0],
    ];
    const created = createGeoArrowBatch({
      id: "parcels:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: { kind: "polygon", values: [[ring], [], null] },
    });

    const inspection = inspectGeoArrowBatch(created.batch);
    expect(Array.from(inspection.geometry.offsets ?? [])).toEqual([0, 1, 1, 1]);
    expect(Array.from(inspection.geometry.ringOffsets ?? [])).toEqual([0, 4]);
    expect(decodeGeoArrowBatch(created.batch).rows.map(({ geometry }) => geometry)).toEqual([[ring], [], null]);

    expect(() =>
      createGeoArrowBatch({
        id: "bad-ring",
        sequence: 0,
        schemaId,
        identity: identity(schemaId, "geometry"),
        geometry: {
          kind: "polygon",
          values: [
            [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [2, 2],
              ],
            ],
          ],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });

  it("preserves identity and normative semantics through a real ownership transfer", async () => {
    const schemaId = "transfer@1";
    const { batch } = createGeoArrowBatch({
      id: "transfer:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: { kind: "point", coordinateLayout: "interleaved", values: [[1, 2], null] },
    });
    const lease = leaseColumnarBatch(batch);
    const { port1, port2 } = new MessageChannel();
    const received = new Promise<ColumnarTransferMessageV1>((resolve) => port2.once("message", resolve));

    try {
      await lease.transfer((message, transfer) => port1.postMessage(message, [...transfer]));
      const message = await received;
      expect(message.metrics.copiedBytes).toBe(0);
      expect(message.batch.identity).toEqual(identity(schemaId, "geometry"));
      expect(decodeGeoArrowBatch(message.batch).rows.map(({ geometry }) => geometry)).toEqual([[1, 2], null]);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("fails closed on every semantic materialization and payload allocation ceiling", () => {
    const schemaId = "limits@1";
    const input = {
      id: "limits:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: {
        kind: "linestring" as const,
        values: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
      dictionary: { field: "class", values: ["road"] },
    };

    expect(() => createGeoArrowBatch(input, { maxRows: 1, maxVertices: 1 })).toThrowError(
      expect.objectContaining({ code: "vertex-limit-exceeded" }),
    );
    expect(() => createGeoArrowBatch(input, { maxRows: 1, maxCopiedBytes: 8 })).toThrowError(
      expect.objectContaining({ code: "copy-limit-exceeded" }),
    );
    expect(() => createGeoArrowBatch(input, { maxRows: 1, maxDictionaryValues: 1 })).not.toThrow();

    const { batch } = createGeoArrowBatch(input);
    expect(() => decodeGeoArrowBatch(batch, { maxRows: 1, maxVertices: 1 })).toThrowError(
      expect.objectContaining({ code: "vertex-limit-exceeded" }),
    );
  });

  it("rejects schema/layout drift and corrupted offset buffers", () => {
    const schemaId = "adversarial@1";
    const { batch } = createGeoArrowBatch({
      id: "adversarial:0",
      sequence: 0,
      schemaId,
      identity: identity(schemaId, "geometry"),
      geometry: {
        kind: "linestring",
        values: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
    });
    const offsets = batch.buffers.find(({ id }) => id === "geometry.offsets")!;
    new Int32Array(offsets.data, offsets.byteOffset, 2).set([1, 0]);
    expect(() => inspectGeoArrowBatch(batch)).toThrowError(expect.objectContaining({ code: "invalid-batch" }));

    expect(() => inspectGeoArrowBatch({ ...batch, identity: undefined })).toThrowError(
      expect.objectContaining({ code: "invalid-batch" }),
    );
  });
});
