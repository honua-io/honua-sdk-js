import { describe, expect, it } from "vitest";
import {
  createColumnarWorkerSession,
  createGeoArrowBatch,
  createGeoArrowTransformOperation,
  decodeGeoArrowBatch,
  inspectGeoArrowBatch,
  startColumnarWorkerHost,
} from "../src/columnar/index.js";
import type {
  ColumnarWorkerFaultEvent,
  ColumnarWorkerMessageEvent,
  ColumnarWorkerTransport,
} from "../src/columnar/index.js";

class LoopbackTransport implements ColumnarWorkerTransport {
  readonly messages = new Set<(event: ColumnarWorkerMessageEvent) => void>();
  peer?: LoopbackTransport;
  disposed = false;

  postMessage(message: unknown, transfer: readonly ArrayBuffer[]): void {
    const cloned = structuredClone(message, { transfer: [...transfer] });
    queueMicrotask(() => {
      if (this.disposed || !this.peer || this.peer.disposed) return;
      for (const listener of this.peer.messages) listener({ data: cloned });
    });
  }

  addEventListener(
    type: "message" | "error",
    listener: ((event: ColumnarWorkerMessageEvent) => void) | ((event: ColumnarWorkerFaultEvent) => void),
  ): void {
    if (type === "message") this.messages.add(listener as (event: ColumnarWorkerMessageEvent) => void);
  }

  removeEventListener(
    type: "message" | "error",
    listener: ((event: ColumnarWorkerMessageEvent) => void) | ((event: ColumnarWorkerFaultEvent) => void),
  ): void {
    if (type === "message") this.messages.delete(listener as (event: ColumnarWorkerMessageEvent) => void);
  }

  dispose(): void {
    this.disposed = true;
    this.messages.clear();
  }
}

const identity = {
  sourceId: "source",
  sourceVersion: "v1",
  schemaVersion: "points-v1",
  planId: "plan-v1",
  authorizationScope: "public",
  ordering: { stable: true, keys: [{ field: "id", direction: "ascending", nulls: "last" }] },
  freshness: { observedAt: "2026-01-01T00:00:00Z" },
} as const;

function sourceBatch() {
  return createGeoArrowBatch({
    id: "source-batch",
    sequence: 4,
    rowOffset: 8,
    schemaId: "points-v1",
    identity,
    geometry: {
      kind: "point",
      field: "geometry",
      dimensions: "xyz",
      crs: "EPSG:4326",
      values: [[10, 20, 3], [30, 40, 4], null],
    },
    temporal: { field: "observed", unit: "millisecond", values: [1000n, 2000n, null] },
    dictionary: { field: "class", values: ["keep", "drop", "keep"] },
    featureIds: { field: "id", values: [11, 12, 13] },
  }).batch;
}

describe("GeoArrow transform worker operation", () => {
  it("transforms XY coordinates while preserving optional columns and protocol identity", async () => {
    const progress: number[] = [];
    const transformedIdentity = { ...identity, schemaVersion: "points-web-mercator-v1" };
    const operation = createGeoArrowTransformOperation({
      id: "transformed-batch",
      schemaId: "points-web-mercator-v1",
      identity: transformedIdentity,
      scale: [2, -1],
      translate: [100, 50],
      outputCrs: "EPSG:3857",
    });
    const result = await operation(sourceBatch(), {
      requestId: "request-transform-1",
      signal: new AbortController().signal,
      reportProgress: (fraction) => progress.push(fraction),
    });

    expect(result.id).toBe("transformed-batch");
    expect(result.sequence).toBe(4);
    expect(result.rowOffset).toBe(8);
    expect(result.identity).toEqual(transformedIdentity);
    expect(decodeGeoArrowBatch(result).rows).toEqual([
      { geometry: [120, 30, 3], timestamp: 1000n, dictionaryValue: "keep", featureId: 11 },
      { geometry: [160, 10, 4], timestamp: 2000n, dictionaryValue: "drop", featureId: 12 },
      { geometry: null, timestamp: null, dictionaryValue: "keep", featureId: 13 },
    ]);
    expect(inspectGeoArrowBatch(result).geometry.crs).toBe("EPSG:3857");
    expect(progress).toEqual([1 / 3, 1]);
  });

  it("transforms every vertex in line and polygon geometries without changing Z/M", async () => {
    const line = createGeoArrowBatch({
      id: "line-batch",
      sequence: 1,
      schemaId: "line-v1",
      identity: {
        ...identity,
        schemaVersion: "line-v1",
        ordering: { ...identity.ordering, keys: [{ ...identity.ordering.keys[0], field: "geometry" }] },
      },
      geometry: {
        kind: "linestring",
        field: "geometry",
        dimensions: "xyz",
        values: [
          [
            [1, 2, 7],
            [3, 4, 8],
          ],
        ],
      },
    }).batch;
    const polygon = createGeoArrowBatch({
      id: "polygon-batch",
      sequence: 1,
      schemaId: "polygon-v1",
      identity: {
        ...identity,
        schemaVersion: "polygon-v1",
        ordering: { ...identity.ordering, keys: [{ ...identity.ordering.keys[0], field: "geometry" }] },
      },
      geometry: {
        kind: "polygon",
        field: "geometry",
        dimensions: "xyz",
        values: [
          [
            [
              [0, 0, 9],
              [2, 0, 9],
              [2, 2, 9],
              [0, 0, 9],
            ],
          ],
        ],
      },
    }).batch;
    const options = {
      id: "output",
      schemaId: "output-v1",
      identity: {
        ...identity,
        schemaVersion: "output-v1",
        ordering: { ...identity.ordering, keys: [{ ...identity.ordering.keys[0], field: "geometry" }] },
      },
      scale: [3, 4] as const,
      translate: [-1, 2] as const,
    };

    const transform = createGeoArrowTransformOperation(options);
    const context = { requestId: "request-transform-2", signal: new AbortController().signal, reportProgress() {} };
    expect(decodeGeoArrowBatch(await transform(line, context)).rows[0]?.geometry).toEqual([
      [2, 10, 7],
      [8, 18, 8],
    ]);
    expect(decodeGeoArrowBatch(await transform(polygon, context)).rows[0]?.geometry).toEqual([
      [
        [-1, 2, 9],
        [5, 2, 9],
        [5, 10, 9],
        [-1, 2, 9],
      ],
    ]);
  });

  it("round-trips through the registered worker operation", async () => {
    const client = new LoopbackTransport();
    const worker = new LoopbackTransport();
    client.peer = worker;
    worker.peer = client;
    startColumnarWorkerHost({
      transport: worker,
      operations: {
        transform: createGeoArrowTransformOperation({
          id: "worker-transformed",
          schemaId: "worker-transformed-v1",
          identity: { ...identity, schemaVersion: "worker-transformed-v1" },
          translate: [5, 6],
        }),
      },
    });
    const session = createColumnarWorkerSession({ createWorker: () => client });
    const result = await session.execute("transform", sourceBatch());
    expect(decodeGeoArrowBatch(result.batch).rows[0]?.geometry).toEqual([15, 26, 3]);
    expect(result.batch.identity?.schemaVersion).toBe("worker-transformed-v1");
    session.dispose();
  });

  it("rejects malformed affine pairs before registering an operation", () => {
    expect(() =>
      createGeoArrowTransformOperation({
        id: "invalid",
        schemaId: "invalid-v1",
        identity,
        scale: [1, Number.NaN],
      }),
    ).toThrow("exactly two finite numbers");
  });
});
