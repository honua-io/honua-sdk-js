import { describe, expect, it } from "vitest";
import {
  createColumnarWorkerSession,
  createGeoArrowBatch,
  createGeoArrowFilterOperation,
  createGeoArrowProjectionOperation,
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

function batch() {
  return createGeoArrowBatch({
    id: "source-batch",
    sequence: 4,
    schemaId: "points-v1",
    identity,
    geometry: {
      kind: "point",
      field: "geometry",
      values: [[10, 20], [30, 40], null],
    },
    temporal: {
      field: "observed",
      unit: "millisecond",
      values: [1000n, 2000n, null],
    },
    dictionary: {
      field: "class",
      values: ["keep", "drop", "keep"],
    },
    featureIds: { field: "id", values: [11, 12, 13] },
  }).batch;
}

describe("GeoArrow filter worker operation", () => {
  it("filters rows while preserving optional columns and identity", async () => {
    const progress: number[] = [];
    const operation = createGeoArrowFilterOperation({
      id: "filtered-batch",
      predicate: (row) => row.dictionaryValue === "keep",
    });
    const source = batch();
    const result = await operation(source, {
      requestId: "request-1",
      signal: new AbortController().signal,
      reportProgress: (fraction) => progress.push(fraction),
    });

    expect(result.id).toBe("filtered-batch");
    expect(result.sequence).toBe(4);
    expect(result.identity).toEqual(identity);
    expect(decodeGeoArrowBatch(result).rows).toEqual([
      { geometry: [10, 20], timestamp: 1000n, dictionaryValue: "keep", featureId: 11 },
      { geometry: null, timestamp: null, dictionaryValue: "keep", featureId: 13 },
    ]);
    expect(inspectGeoArrowBatch(result).temporal?.field).toBe("observed");
    expect(inspectGeoArrowBatch(result).dictionary?.field).toBe("class");
    expect(progress.at(-1)).toBe(1);
  });

  it("fails closed when a predicate does not return a boolean", async () => {
    const operation = createGeoArrowFilterOperation({
      id: "invalid-filter",
      predicate: () => "yes" as unknown as boolean,
    });

    await expect(
      operation(batch(), {
        requestId: "request-2",
        signal: new AbortController().signal,
        reportProgress: () => undefined,
      }),
    ).rejects.toThrow("must return a boolean");
  });

  it("runs as a registered worker-host operation", async () => {
    const client = new LoopbackTransport();
    const worker = new LoopbackTransport();
    client.peer = worker;
    worker.peer = client;
    startColumnarWorkerHost({
      transport: worker,
      operations: {
        filter: createGeoArrowFilterOperation({
          id: "worker-filtered",
          predicate: (row) => row.featureId === 13,
        }),
      },
    });
    const session = createColumnarWorkerSession({ createWorker: () => client });
    const result = await session.execute("filter", batch());
    expect(decodeGeoArrowBatch(result.batch).rows).toEqual([
      { geometry: null, timestamp: null, dictionaryValue: "keep", featureId: 13 },
    ]);
    session.dispose();
  });
});

describe("GeoArrow projection worker operation", () => {
  it("retains requested optional columns and assigns the projected identity", async () => {
    const progress: number[] = [];
    const projectedIdentity = { ...identity, schemaVersion: "points-geometry-class-v2" };
    const operation = createGeoArrowProjectionOperation({
      id: "projected-batch",
      schemaId: "points-geometry-class-v2",
      identity: projectedIdentity,
      columns: ["geometry", "dictionary"],
    });
    const result = await operation(batch(), {
      requestId: "request-projection-1",
      signal: new AbortController().signal,
      reportProgress: (fraction) => progress.push(fraction),
    });

    expect(result.id).toBe("projected-batch");
    expect(result.identity).toEqual(projectedIdentity);
    expect(result.rowOffset).toBeUndefined();
    expect(decodeGeoArrowBatch(result).rows).toEqual([
      { geometry: [10, 20], dictionaryValue: "keep" },
      { geometry: [30, 40], dictionaryValue: "drop" },
      { geometry: null, dictionaryValue: "keep" },
    ]);
    expect(inspectGeoArrowBatch(result).temporal).toBeUndefined();
    expect(inspectGeoArrowBatch(result).dictionary?.field).toBe("class");
    expect(progress.at(-1)).toBe(1);
  });

  it("fails closed when an optional requested column is absent", async () => {
    const operation = createGeoArrowProjectionOperation({
      id: "missing-column",
      schemaId: "missing-column-v1",
      identity: { ...identity, schemaVersion: "missing-column-v1" },
      columns: ["geometry", "featureId"],
    });

    await expect(
      operation(batch(), {
        requestId: "request-projection-2",
        signal: new AbortController().signal,
        reportProgress: () => undefined,
      }),
    ).rejects.toThrow("missing feature-id");
  });

  it("round-trips through the registered worker operation", async () => {
    const client = new LoopbackTransport();
    const worker = new LoopbackTransport();
    client.peer = worker;
    worker.peer = client;
    startColumnarWorkerHost({
      transport: worker,
      operations: {
        project: createGeoArrowProjectionOperation({
          id: "worker-projected",
          schemaId: "worker-projected-v1",
          identity: { ...identity, schemaVersion: "worker-projected-v1" },
          columns: ["geometry", "temporal", "featureId"],
        }),
      },
    });
    const session = createColumnarWorkerSession({ createWorker: () => client });
    const result = await session.execute("project", batch());
    expect(decodeGeoArrowBatch(result.batch).rows).toEqual([
      { geometry: [10, 20], timestamp: 1000n, featureId: 11 },
      { geometry: [30, 40], timestamp: 2000n, featureId: 12 },
      { geometry: null, timestamp: null, featureId: 13 },
    ]);
    session.dispose();
  });
});
