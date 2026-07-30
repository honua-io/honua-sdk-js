import { describe, expect, it } from "vitest";
import {
  createGeoArrowBatch,
  decodeGeoArrowBatch,
  deserializeGeoArrowBatch,
  inspectGeoArrowBatch,
  serializeGeoArrowBatch,
} from "../src/query-planner/index.js";
import type { ColumnarBatchIdentityV1 } from "../src/query-planner/index.js";

const identity = (schemaVersion: string): ColumnarBatchIdentityV1 => ({
  sourceId: "parcels",
  sourceVersion: "source-1",
  schemaVersion,
  planId: "plan-1",
  authorizationScope: "public",
  ordering: { stable: true, keys: [{ field: "geometry", direction: "ascending", nulls: "last" }] },
  freshness: { observedAt: "2026-07-30T00:00:00Z" },
});

describe("versioned GeoArrow batch serialization", () => {
  it("round-trips point, null, CRS, temporal, dictionary, and feature-id columns", () => {
    const created = createGeoArrowBatch({
      id: "parcels:0",
      sequence: 3,
      schemaId: "parcels@1",
      identity: identity("parcels@1"),
      geometry: { kind: "point", crs: "EPSG:4326", values: [[-157, 21], null] },
      temporal: { field: "observed_at", unit: "millisecond", values: [1n, null] },
      dictionary: { field: "status", values: ["open", null] },
      featureIds: { field: "feature_id", values: [7, 8] },
    });
    const bytes = serializeGeoArrowBatch(created.batch);
    const restored = deserializeGeoArrowBatch(bytes);

    expect(inspectGeoArrowBatch(restored.batch).geometry.crs).toBe("EPSG:4326");
    expect(decodeGeoArrowBatch(restored.batch).rows).toEqual(decodeGeoArrowBatch(created.batch).rows);
    expect(restored.metrics.backingBuffers).toBeGreaterThan(0);
  });

  it("round-trips linestring nested geometry", () => {
    const kind = "linestring" as const;
    const values = [
      [
        [1, 2],
        [3, 4],
      ],
    ] as const;
    const created = createGeoArrowBatch({
      id: `${kind}:0`,
      sequence: 0,
      schemaId: `${kind}@1`,
      identity: identity(`${kind}@1`),
      geometry: { kind, values },
    });
    const restored = deserializeGeoArrowBatch(serializeGeoArrowBatch(created.batch));
    expect(decodeGeoArrowBatch(restored.batch).rows).toEqual(decodeGeoArrowBatch(created.batch).rows);
  });

  it("round-trips polygon nested geometry", () => {
    const kind = "polygon" as const;
    const values = [
      [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [0, 0],
        ],
      ],
    ] as const;
    const created = createGeoArrowBatch({
      id: `${kind}:0`,
      sequence: 0,
      schemaId: `${kind}@1`,
      identity: identity(`${kind}@1`),
      geometry: { kind, values },
    });
    const restored = deserializeGeoArrowBatch(serializeGeoArrowBatch(created.batch));
    expect(decodeGeoArrowBatch(restored.batch).rows).toEqual(decodeGeoArrowBatch(created.batch).rows);
  });

  it("rejects envelopes above the caller's persistence ceiling", () => {
    const { batch } = createGeoArrowBatch({
      id: "points:0",
      sequence: 0,
      schemaId: "points@1",
      identity: identity("points@1"),
      geometry: { kind: "point", values: [[1, 2]] },
    });
    expect(() => serializeGeoArrowBatch(batch, { maxSerializedBytes: 1 })).toThrow("envelope");
    expect(() => deserializeGeoArrowBatch(new Uint8Array([123, 32]), { maxSerializedBytes: 1 })).toThrow("limit");
  });

  it("reports the accepted input byte length", () => {
    const { batch } = createGeoArrowBatch({
      id: "points:0",
      sequence: 0,
      schemaId: "points@1",
      identity: identity("points@1"),
      geometry: { kind: "point", values: [[1, 2]] },
    });
    const persisted = serializeGeoArrowBatch(batch);
    const padded = new TextEncoder().encode(` \n${new TextDecoder().decode(persisted)}\n`);

    expect(deserializeGeoArrowBatch(padded).metrics.serializedBytes).toBe(padded.byteLength);
  });
});
