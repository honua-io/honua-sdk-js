import { describe, expect, it } from "vitest";
import {
  createGeoArrowBatch,
  createGeoArrowReprojectOperation,
  decodeGeoArrowBatch,
  inspectGeoArrowBatch,
} from "../src/columnar/index.js";
import type { ColumnarBatchIdentityV1 } from "../src/columnar/index.js";

const identity = (schemaVersion: string, field = "geometry"): ColumnarBatchIdentityV1 => ({
  sourceId: "routes",
  sourceVersion: "source-1",
  schemaVersion,
  planId: "plan-1",
  authorizationScope: "scope-1",
  ordering: { stable: true, keys: [{ field, direction: "ascending", nulls: "last" }] },
  freshness: { observedAt: "2026-07-29T00:00:00Z" },
});

const context = (progress: Array<{ fraction: number; stage?: string }>) => ({
  requestId: "reproject-1",
  signal: new AbortController().signal,
  reportProgress(fraction: number, stage?: string) {
    progress.push({ fraction, stage });
  },
});

describe("GeoArrow reprojection operation", () => {
  it("reprojects nested geometries, preserves columns, and replaces CRS metadata", async () => {
    const { batch } = createGeoArrowBatch({
      id: "routes:0",
      sequence: 8,
      schemaId: "routes@1",
      identity: identity("routes@1"),
      geometry: {
        kind: "linestring",
        crs: "OGC:CRS84",
        values: [
          [
            [1, 2],
            [3, 4],
          ],
          null,
        ],
      },
      temporal: { field: "observed_at", unit: "millisecond", values: [1n, null] },
      dictionary: { field: "status", values: ["open", null] },
      featureIds: { field: "feature_id", values: [10, 11] },
    });
    const progress: Array<{ fraction: number; stage?: string }> = [];
    const operation = createGeoArrowReprojectOperation({
      schemaId: "routes@1:epsg3857",
      identity: identity("routes@1:epsg3857"),
      targetCrs: "EPSG:3857",
      project: ([x, y]) => [x + 100, y + 200],
    });
    const projected = await operation(batch, context(progress));
    const inspection = inspectGeoArrowBatch(projected);
    const decoded = decodeGeoArrowBatch(projected);
    expect(inspection.geometry.crs).toBe("EPSG:3857");
    expect(decoded.rows.map((row) => row.geometry)).toEqual([
      [
        [101, 202],
        [103, 204],
      ],
      null,
    ]);
    expect(decoded.rows.map((row) => row.timestamp)).toEqual([1n, null]);
    expect(decoded.rows.map((row) => row.dictionaryValue)).toEqual(["open", null]);
    expect(decoded.rows.map((row) => row.featureId)).toEqual([10, 11]);
    expect(progress.map((entry) => entry.stage)).toEqual(["decode", "reproject", "complete"]);
  });

  it("fails closed when the host transform changes dimensionality", () => {
    const { batch } = createGeoArrowBatch({
      id: "points:0",
      sequence: 0,
      schemaId: "points@1",
      identity: identity("points@1"),
      geometry: { kind: "point", values: [[1, 2]] },
    });
    const operation = createGeoArrowReprojectOperation({
      schemaId: "points@1:target",
      identity: identity("points@1:target"),
      targetCrs: "EPSG:3857",
      project: () => [1],
    });
    expect(() => operation(batch, context([]))).toThrow("preserve coordinate dimensionality");
  });

  it("preserves an empty Point without invoking the host transform", async () => {
    const { batch } = createGeoArrowBatch({
      id: "points:empty",
      sequence: 0,
      schemaId: "points@1",
      identity: identity("points@1"),
      geometry: { kind: "point", values: [[Number.NaN, Number.NaN], [1, 2], null] },
    });
    const projectedPositions: (readonly number[])[] = [];
    const operation = createGeoArrowReprojectOperation({
      schemaId: "points@1:target",
      identity: identity("points@1:target"),
      targetCrs: "EPSG:3857",
      project: (position) => {
        projectedPositions.push(position);
        return [position[0]! + 10, position[1]! + 20];
      },
    });

    const projected = await operation(batch, context([]));
    const rows = decodeGeoArrowBatch(projected).rows;
    expect((rows[0]!.geometry as readonly number[]).every(Number.isNaN)).toBe(true);
    expect(rows[1]!.geometry).toEqual([11, 22]);
    expect(rows[2]!.geometry).toBeNull();
    expect(projectedPositions).toEqual([[1, 2]]);
  });
});
