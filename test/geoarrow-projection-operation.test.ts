import { describe, expect, it } from "vitest";
import {
  createGeoArrowBatch,
  createGeoArrowProjectionOperation,
  decodeGeoArrowBatch,
  inspectGeoArrowBatch,
} from "../src/columnar/index.js";

const identity = (schemaVersion: string, field = "feature_id") => ({
  sourceId: "incidents",
  sourceVersion: "source-1",
  schemaVersion,
  planId: "plan-1",
  authorizationScope: "scope-1",
  ordering: { stable: true, keys: [{ field, direction: "ascending", nulls: "last" }] },
  freshness: { observedAt: "2026-07-29T00:00:00Z" },
});

const context = (progress: Array<{ fraction: number; stage?: string }>) => ({
  requestId: "projection-1",
  signal: new AbortController().signal,
  reportProgress(fraction: number, stage?: string) {
    progress.push({ fraction, stage });
  },
});

describe("GeoArrow projection operation", () => {
  it("projects optional columns while preserving geometry and row order", () => {
    const { batch } = createGeoArrowBatch({
      id: "incidents:0",
      sequence: 4,
      schemaId: "incidents@1",
      identity: identity("incidents@1"),
      geometry: {
        kind: "point",
        coordinateLayout: "interleaved",
        crs: "OGC:CRS84",
        values: [[1, 2], null, [3, 4]],
      },
      temporal: { field: "observed_at", unit: "millisecond", values: [1n, null, 3n] },
      dictionary: { field: "status", values: ["open", null, "closed"] },
      featureIds: { field: "feature_id", values: [10, 11, 12] },
    });
    const progress: Array<{ fraction: number; stage?: string }> = [];
    const projected = createGeoArrowProjectionOperation({
      schemaId: "incidents@1:map",
      identity: identity("incidents@1:map"),
      include: ["featureIds", "dictionary"],
    })(batch, context(progress)) as typeof batch;

    const inspection = inspectGeoArrowBatch(projected);
    const decoded = decodeGeoArrowBatch(projected);
    expect(projected.schema.id).toBe("incidents@1:map");
    expect(inspection.temporal).toBeUndefined();
    expect(inspection.dictionary?.field).toBe("status");
    expect(inspection.featureIds?.values).toEqual(new Uint32Array([10, 11, 12]));
    expect(decoded.rows.map((row) => row.geometry)).toEqual([[1, 2], null, [3, 4]]);
    expect(decoded.rows.map((row) => row.dictionaryValue)).toEqual(["open", null, "closed"]);
    expect(progress.map((entry) => entry.stage)).toEqual(["decode", "project", "complete"]);
  });

  it("honors abort before encoding the projected batch", () => {
    const { batch } = createGeoArrowBatch({
      id: "points:0",
      sequence: 0,
      schemaId: "points@1",
      identity: identity("points@1", "geometry"),
      geometry: { kind: "point", values: [[1, 2]] },
    });
    const controller = new AbortController();
    controller.abort();
    const operation = createGeoArrowProjectionOperation({
      schemaId: "points@1:projected",
      identity: identity("points@1:projected"),
    });
    expect(() => operation(batch, { ...context([]), signal: controller.signal })).toThrow();
  });
});
