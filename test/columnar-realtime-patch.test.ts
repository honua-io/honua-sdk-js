import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ColumnarBatchV1,
  type ColumnarPatchOperationV1,
  type ColumnarPatchV1,
  type ColumnarWorkerFaultEvent,
  type ColumnarWorkerMessageEvent,
  type ColumnarWorkerTransport,
  type CreateGeoArrowBatchInput,
  DEFAULT_COLUMNAR_PATCH_MAX_TOMBSTONE_RATIO,
  HonuaColumnarPatchError,
  applyColumnarPatch,
  columnarPatchLiveMask,
  createColumnarPatch,
  createColumnarPatchOperation,
  createColumnarWorkerSession,
  createGeoArrowBatch,
  createPatchableGeoArrowBatch,
  decodeGeoArrowBatch,
  decodePatchedGeoArrowBatch,
  inspectColumnarPatchState,
  inspectGeoArrowBatch,
  startColumnarWorkerHost,
} from "../src/columnar/index.js";
import { bindGeoArrowPointBatchToDeckGl } from "../src/deckgl/index.js";

/** A patchable live batch declares insertion order: appends never break it. */
function identityFor(schemaId: string) {
  return {
    sourceId: "incidents",
    sourceVersion: "v1",
    schemaVersion: schemaId,
    planId: "live-v1",
    authorizationScope: "public",
    ordering: { stable: false, keys: [] as const },
    freshness: { observedAt: "2026-01-01T00:00:00Z", generation: "0" },
  } as const;
}

const identity = identityFor("incidents@1");

const STATUSES = ["open", "closed", "escalated"] as const;

function pointInput(rows: number, options: { readonly firstId?: number } = {}): CreateGeoArrowBatchInput {
  const firstId = options.firstId ?? 0;
  return {
    id: "live-points",
    sequence: 1,
    schemaId: "incidents@1",
    identity,
    geometry: {
      kind: "point",
      field: "geometry",
      values: Array.from({ length: rows }, (_, row) => [row / 8, -row / 8]),
    },
    temporal: {
      field: "observed",
      unit: "millisecond",
      values: Array.from({ length: rows }, (_, row) => BigInt(1_700_000_000_000 + row)),
    },
    dictionary: {
      field: "status",
      values: Array.from({ length: rows }, (_, row) => STATUSES[row % STATUSES.length]!),
    },
    featureIds: { field: "id", values: Array.from({ length: rows }, (_, row) => firstId + row) },
  };
}

function lineInput(rows: number, verticesPerRow: number): CreateGeoArrowBatchInput {
  return {
    id: "live-lines",
    sequence: 1,
    schemaId: "routes@1",
    identity: identityFor("routes@1"),
    geometry: {
      kind: "linestring",
      field: "geometry",
      values: Array.from({ length: rows }, (_, row) =>
        Array.from({ length: verticesPerRow }, (_, vertex) => [row + vertex, row - vertex]),
      ),
    },
    featureIds: { field: "id", values: Array.from({ length: rows }, (_, row) => row) },
  };
}

function squareRing(x: number, y: number): readonly (readonly number[])[] {
  return [
    [x, y],
    [x + 1, y],
    [x + 1, y + 1],
    [x, y + 1],
    [x, y],
  ];
}

function polygonInput(rows: number): CreateGeoArrowBatchInput {
  return {
    id: "live-zones",
    sequence: 1,
    schemaId: "zones@1",
    identity: identityFor("zones@1"),
    geometry: {
      kind: "polygon",
      field: "geometry",
      values: Array.from({ length: rows }, (_, row) => [squareRing(row * 4, 0)]),
    },
    featureIds: { field: "id", values: Array.from({ length: rows }, (_, row) => row) },
  };
}

/** The exact shape the direct deck.gl point binding accepts. */
function renderableInput(rows: number): CreateGeoArrowBatchInput {
  return {
    id: "live-render",
    sequence: 1,
    schemaId: "render@1",
    identity: identityFor("render@1"),
    geometry: {
      kind: "point",
      field: "geometry",
      coordinateLayout: "interleaved",
      crs: "OGC:CRS84",
      values: Array.from({ length: rows }, (_, row) => [row, -row]),
    },
    featureIds: { field: "id", values: Array.from({ length: rows }, (_, row) => row) },
  };
}

function patch(
  operations: readonly ColumnarPatchOperationV1[],
  options: {
    readonly sequence?: number;
    readonly schemaId?: string;
    readonly geometryKind?: "point" | "linestring" | "polygon";
  } = {},
): ColumnarPatchV1 {
  const sequence = options.sequence ?? 1;
  return createColumnarPatch({
    schemaId: options.schemaId ?? "incidents@1",
    geometryKind: options.geometryKind ?? "point",
    cursor: {
      cursor: `cursor-${sequence}`,
      sequence,
      observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    },
    operations,
  });
}

/** Digest of everything a patch could mutate: payload bytes plus declared state. */
function digest(batch: ColumnarBatchV1): string {
  const hash = createHash("sha256");
  hash.update(`${batch.id}|${batch.rowCount}|${JSON.stringify(batch.schema.metadata ?? {})}`);
  hash.update(JSON.stringify(batch.identity ?? {}));
  for (const buffer of batch.buffers) {
    hash.update(`${buffer.id}|${buffer.byteOffset}|${buffer.byteLength}|`);
    hash.update(new Uint8Array(buffer.data, buffer.byteOffset, buffer.byteLength));
  }
  return hash.digest("hex");
}

function backings(batch: ColumnarBatchV1): readonly ArrayBuffer[] {
  return batch.buffers.map((buffer) => buffer.data);
}

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

function pair(): readonly [LoopbackTransport, LoopbackTransport] {
  const client = new LoopbackTransport();
  const worker = new LoopbackTransport();
  client.peer = worker;
  worker.peer = client;
  return [client, worker];
}

describe("columnar realtime patches", () => {
  it("appends, updates, and deletes a point batch in place", () => {
    const created = createPatchableGeoArrowBatch(pointInput(8), { reserve: { rows: 8 } });
    expect(created.state.capacity.rows).toBe(8);
    expect(created.metrics.reservedBytes).toBeGreaterThan(0);
    const before = backings(created.batch);

    const outcome = applyColumnarPatch(
      created.batch,
      patch([
        { op: "append", featureId: 100, geometry: [9, -9], timestamp: 5n, dictionaryValue: "open" },
        { op: "update", featureId: 2, geometry: [42, -42], dictionaryValue: "closed" },
        { op: "delete", featureId: 5 },
      ]),
    );

    expect(outcome.outcome).toBe("patched-in-place");
    if (outcome.outcome !== "patched-in-place") return;
    expect(outcome.bufferIdentityPreserved).toBe(true);
    expect(backings(outcome.batch)).toEqual(before);
    expect(outcome.batch.rowCount).toBe(9);
    expect(outcome.metrics).toMatchObject({
      appendedRows: 1,
      updatedRows: 1,
      deletedRows: 1,
      rowsTouched: 3,
      backingBytesAllocated: 0,
      tombstones: 1,
      liveRows: 8,
    });
    expect(outcome.state.tombstoneRanges).toEqual([[5, 5]]);
    expect(outcome.state.sequence).toBe(1);
    expect(outcome.state.cursor).toBe("cursor-1");
    expect(outcome.batch.identity?.freshness.generation).toBe("1");

    // The patched batch is still a normative GeoArrow batch.
    const inspection = inspectGeoArrowBatch(outcome.batch);
    expect(inspection.metrics.rows).toBe(9);

    const read = decodePatchedGeoArrowBatch(outcome.batch);
    expect(read.rows).toHaveLength(8);
    expect(read.rows.some((row) => row.featureId === 5)).toBe(false);
    const updated = read.rows.find((row) => row.featureId === 2);
    expect(updated?.geometry).toEqual([42, -42]);
    expect(updated?.dictionaryValue).toBe("closed");
    const appended = read.rows.at(-1);
    expect(appended).toMatchObject({ featureId: 100, timestamp: 5n, dictionaryValue: "open" });
    expect(appended?.geometry).toEqual([9, -9]);
    expect([...columnarPatchLiveMask(outcome.state)]).toEqual([1, 1, 1, 1, 1, 0, 1, 1, 1]);
  });

  it("appends, updates, and deletes a linestring batch in place", () => {
    const created = createPatchableGeoArrowBatch(lineInput(4, 3), {
      reserve: { rows: 8, vertices: 64 },
    });
    const before = backings(created.batch);
    const outcome = applyColumnarPatch(
      created.batch,
      patch(
        [
          {
            op: "append",
            featureId: 900,
            geometry: [
              [0, 0],
              [1, 1],
              [2, 2],
            ],
          },
          {
            op: "update",
            featureId: 1,
            geometry: [
              [7, 7],
              [8, 8],
              [9, 9],
            ],
          },
          { op: "delete", featureId: 3 },
        ],
        { schemaId: "routes@1", geometryKind: "linestring" },
      ),
      { thresholds: { maxTombstoneRatio: 0.5 } },
    );

    expect(outcome.outcome).toBe("patched-in-place");
    if (outcome.outcome !== "patched-in-place") return;
    expect(backings(outcome.batch)).toEqual(before);
    expect(outcome.batch.rowCount).toBe(5);
    expect(outcome.state.tombstoneCount).toBe(1);
    const read = decodePatchedGeoArrowBatch(outcome.batch);
    expect(read.rows).toHaveLength(4);
    expect(read.rows.find((row) => row.featureId === 1)?.geometry).toEqual([
      [7, 7],
      [8, 8],
      [9, 9],
    ]);
    expect(read.rows.at(-1)?.geometry).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("appends, updates, and deletes a polygon batch in place", () => {
    const created = createPatchableGeoArrowBatch(polygonInput(4), {
      reserve: { rows: 8, vertices: 64, rings: 16 },
    });
    const before = backings(created.batch);
    const outcome = applyColumnarPatch(
      created.batch,
      patch(
        [
          { op: "append", featureId: 700, geometry: [squareRing(50, 50)] },
          { op: "update", featureId: 2, geometry: [squareRing(-5, -5)] },
          { op: "delete", featureId: 0 },
        ],
        { schemaId: "zones@1", geometryKind: "polygon" },
      ),
      { thresholds: { maxTombstoneRatio: 0.5 } },
    );

    expect(outcome.outcome).toBe("patched-in-place");
    if (outcome.outcome !== "patched-in-place") return;
    expect(backings(outcome.batch)).toEqual(before);
    expect(outcome.batch.rowCount).toBe(5);
    const read = decodePatchedGeoArrowBatch(outcome.batch);
    expect(read.rows).toHaveLength(4);
    expect(read.rows.find((row) => row.featureId === 2)?.geometry).toEqual([squareRing(-5, -5)]);
    expect(read.rows.at(-1)?.geometry).toEqual([squareRing(50, 50)]);
    expect(inspectGeoArrowBatch(outcome.batch).metrics.rings).toBe(5);
  });

  it("compacts polygon rings and vertices through a rebuild", () => {
    const created = createPatchableGeoArrowBatch(
      {
        ...polygonInput(4),
        geometry: {
          kind: "polygon",
          field: "geometry",
          // Row 1 carries a hole, so ring offsets are not one-per-row.
          values: [
            [squareRing(0, 0)],
            [squareRing(10, 0), squareRing(10.25, 0.25)],
            [squareRing(20, 0)],
            [squareRing(30, 0)],
          ],
        },
      },
      { reserve: { rows: 4, vertices: 40, rings: 8 } },
    );
    const outcome = applyColumnarPatch(
      created.batch,
      patch(
        [
          { op: "delete", featureId: 0 },
          { op: "delete", featureId: 2 },
          { op: "append", featureId: 77, geometry: [squareRing(40, 0)] },
        ],
        { schemaId: "zones@1", geometryKind: "polygon" },
      ),
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("tombstone-ratio");
    const rows = decodePatchedGeoArrowBatch(outcome.batch).rows;
    expect(rows.map((row) => row.featureId)).toEqual([1, 3, 77]);
    expect(rows.map((row) => row.geometry)).toEqual([
      [squareRing(10, 0), squareRing(10.25, 0.25)],
      [squareRing(30, 0)],
      [squareRing(40, 0)],
    ]);
    const inspection = inspectGeoArrowBatch(outcome.batch);
    expect(inspection.metrics.rings).toBe(4);
    expect(inspection.metrics.vertices).toBe(20);
  });

  it("rebuilds when the tombstone ratio ceiling is crossed", () => {
    const created = createPatchableGeoArrowBatch(pointInput(8), { reserve: { rows: 8 } });
    const outcome = applyColumnarPatch(
      created.batch,
      patch([
        { op: "delete", featureId: 1 },
        { op: "delete", featureId: 3 },
        { op: "delete", featureId: 6 },
      ]),
    );
    expect(3 / 8).toBeGreaterThan(DEFAULT_COLUMNAR_PATCH_MAX_TOMBSTONE_RATIO);
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("tombstone-ratio");
    expect(outcome.bufferIdentityPreserved).toBe(false);
    expect(outcome.batch.id).not.toBe(created.batch.id);
    expect(outcome.batch.identity?.freshness.generation).toBe("1");
    expect(outcome.batch.rowCount).toBe(5);
    expect(outcome.state.tombstoneCount).toBe(0);
    expect(outcome.state.capacity.rows).toBe(8);
    const read = decodePatchedGeoArrowBatch(outcome.batch);
    expect(read.rows.map((row) => row.featureId)).toEqual([0, 2, 4, 5, 7]);
    expect(read.rows.map((row) => row.dictionaryValue)).toEqual(
      [0, 2, 4, 5, 7].map((row) => STATUSES[row % STATUSES.length]),
    );
    expect(read.rows.map((row) => row.timestamp)).toEqual(
      [0, 2, 4, 5, 7].map((row) => BigInt(1_700_000_000_000 + row)),
    );
  });

  it("rebuilds when the tombstone overlay ceiling is crossed", () => {
    const created = createPatchableGeoArrowBatch(pointInput(20), { reserve: { rows: 4 } });
    const outcome = applyColumnarPatch(
      created.batch,
      patch([
        { op: "delete", featureId: 1 },
        { op: "delete", featureId: 3 },
        { op: "delete", featureId: 5 },
      ]),
      { thresholds: { maxTombstoneRatio: 1, maxTombstoneOverlayBytes: 4 } },
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("tombstone-overlay");
    expect(outcome.batch.rowCount).toBe(17);
  });

  it("rebuilds when the capacity ceiling is crossed", () => {
    const created = createPatchableGeoArrowBatch(pointInput(4), { reserve: { rows: 2 } });
    const outcome = applyColumnarPatch(
      created.batch,
      patch([
        { op: "append", featureId: 40, geometry: [1, 1], timestamp: 1n, dictionaryValue: "open" },
        { op: "append", featureId: 41, geometry: [2, 2], timestamp: 2n, dictionaryValue: "open" },
        { op: "append", featureId: 42, geometry: [3, 3], timestamp: 3n, dictionaryValue: "open" },
      ]),
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("capacity");
    expect(outcome.batch.rowCount).toBe(7);
    expect(decodePatchedGeoArrowBatch(outcome.batch).rows.map((row) => row.featureId)).toEqual([
      0, 1, 2, 3, 40, 41, 42,
    ]);
  });

  it("rebuilds when the geometry vertex-growth ceiling is crossed", () => {
    const created = createPatchableGeoArrowBatch(lineInput(2, 2), {
      reserve: { rows: 32, vertices: 512 },
    });
    expect(created.state.baseVertices).toBe(4);
    const outcome = applyColumnarPatch(
      created.batch,
      patch(
        [
          {
            op: "append",
            featureId: 500,
            geometry: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
            ],
          },
        ],
        { schemaId: "routes@1", geometryKind: "linestring" },
      ),
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("vertex-growth");
    expect(outcome.batch.rowCount).toBe(3);
    expect(inspectGeoArrowBatch(outcome.batch).metrics.vertices).toBe(8);
    expect(inspectColumnarPatchState(outcome.batch).baseVertices).toBe(8);
    expect(decodePatchedGeoArrowBatch(outcome.batch).rows.map((row) => row.geometry)).toEqual([
      [
        [0, 0],
        [1, -1],
      ],
      [
        [1, 1],
        [2, 0],
      ],
      [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ],
    ]);
  });

  it("rebuilds when a batch declares no reserved capacity", () => {
    const batch = createGeoArrowBatch(pointInput(3)).batch;
    expect(inspectColumnarPatchState(batch).capacity.rows).toBe(0);
    const outcome = applyColumnarPatch(
      batch,
      patch([{ op: "append", featureId: 30, geometry: [3, 3], timestamp: 9n, dictionaryValue: "open" }]),
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("capacity");
    expect(outcome.batch.rowCount).toBe(4);
  });

  it("rebuilds when a patch needs a dictionary value the batch does not carry", () => {
    const created = createPatchableGeoArrowBatch(pointInput(4), { reserve: { rows: 8 } });
    const outcome = applyColumnarPatch(
      created.batch,
      patch([{ op: "append", featureId: 60, geometry: [6, 6], timestamp: 6n, dictionaryValue: "merged" }]),
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("layout");
    expect(decodePatchedGeoArrowBatch(outcome.batch).rows.at(-1)?.dictionaryValue).toBe("merged");
  });

  it("rebuilds when an update changes a row's vertex count", () => {
    const created = createPatchableGeoArrowBatch(lineInput(4, 2), {
      reserve: { rows: 16, vertices: 128 },
    });
    const outcome = applyColumnarPatch(
      created.batch,
      patch(
        [
          {
            op: "update",
            featureId: 1,
            geometry: [
              [5, 5],
              [6, 6],
              [7, 7],
            ],
          },
          { op: "delete", featureId: 2 },
        ],
        { schemaId: "routes@1", geometryKind: "linestring" },
      ),
      { thresholds: { maxTombstoneRatio: 1, maxVertexGrowthRatio: 8 } },
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("layout");
    expect(outcome.metrics).toMatchObject({ updatedRows: 1, deletedRows: 1, tombstones: 0 });
    const rows = decodePatchedGeoArrowBatch(outcome.batch).rows;
    expect(rows.map((row) => row.featureId)).toEqual([0, 1, 3]);
    expect(rows.map((row) => row.geometry)).toEqual([
      [
        [0, 0],
        [1, -1],
      ],
      [
        [5, 5],
        [6, 6],
        [7, 7],
      ],
      [
        [3, 3],
        [4, 2],
      ],
    ]);
    expect(inspectGeoArrowBatch(outcome.batch).metrics.vertices).toBe(7);
  });

  it("applies non-geometry updates through a rebuild", () => {
    const created = createPatchableGeoArrowBatch(pointInput(8), { reserve: { rows: 8 } });
    const outcome = applyColumnarPatch(
      created.batch,
      patch([
        { op: "update", featureId: 1, timestamp: 42n, dictionaryValue: "closed" },
        { op: "delete", featureId: 0 },
        { op: "delete", featureId: 2 },
        { op: "delete", featureId: 4 },
      ]),
    );
    expect(outcome.outcome).toBe("rebuilt");
    if (outcome.outcome !== "rebuilt") return;
    expect(outcome.reason).toBe("tombstone-ratio");
    const rows = decodePatchedGeoArrowBatch(outcome.batch).rows;
    expect(rows.map((row) => row.featureId)).toEqual([1, 3, 5, 6, 7]);
    expect(rows[0]).toMatchObject({ timestamp: 42n, dictionaryValue: "closed" });
    expect(rows[0]?.geometry).toEqual([1 / 8, -1 / 8]);
    expect(rows.map((row) => row.dictionaryValue)).toEqual([
      "closed",
      ...[3, 5, 6, 7].map((row) => STATUSES[row % STATUSES.length]),
    ]);
  });

  it("rejects a rebuild-forcing patch when rebuilds are disabled", () => {
    const created = createPatchableGeoArrowBatch(pointInput(4), { reserve: { rows: 0 } });
    const snapshot = digest(created.batch);
    const outcome = applyColumnarPatch(
      created.batch,
      patch([{ op: "append", featureId: 60, geometry: [6, 6], timestamp: 6n, dictionaryValue: "open" }]),
      { allowRebuild: false },
    );
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome !== "rejected") return;
    expect(outcome.code).toBe("rebuild-required");
    expect(outcome.detail).toMatchObject({ reason: "capacity" });
    expect(digest(created.batch)).toBe(snapshot);
  });

  it("keeps the batch byte-identical for every typed rejection", () => {
    const created = createPatchableGeoArrowBatch(pointInput(6), { reserve: { rows: 8 } });
    const applied = applyColumnarPatch(created.batch, patch([{ op: "delete", featureId: 4 }], { sequence: 5 }));
    expect(applied.outcome).toBe("patched-in-place");
    if (applied.outcome !== "patched-in-place") return;
    const batch = applied.batch;
    const snapshot = digest(batch);

    const rejections: readonly { readonly code: string; readonly patch: ColumnarPatchV1 }[] = [
      { code: "stale-sequence", patch: patch([{ op: "delete", featureId: 1 }], { sequence: 4 }) },
      { code: "duplicate-sequence", patch: patch([{ op: "delete", featureId: 1 }], { sequence: 5 }) },
      { code: "unknown-feature-id", patch: patch([{ op: "delete", featureId: 999 }], { sequence: 6 }) },
      { code: "deleted-feature-id", patch: patch([{ op: "delete", featureId: 4 }], { sequence: 6 }) },
      {
        code: "duplicate-feature-id",
        patch: patch([{ op: "append", featureId: 1, geometry: [1, 1], timestamp: 1n, dictionaryValue: "open" }], {
          sequence: 6,
        }),
      },
      {
        code: "geometry-kind-drift",
        patch: patch([{ op: "delete", featureId: 1 }], { sequence: 6, geometryKind: "polygon" }),
      },
      {
        code: "schema-drift",
        patch: patch([{ op: "delete", featureId: 1 }], { sequence: 6, schemaId: "incidents@2" }),
      },
      {
        code: "schema-drift",
        patch: patch([{ op: "update", featureId: 1, geometry: [1, 1] }], { sequence: 6, schemaId: "incidents@2" }),
      },
      {
        code: "invalid-geometry",
        patch: patch([{ op: "update", featureId: 1, geometry: [1, 1, 1] }], { sequence: 6 }),
      },
      {
        code: "incomplete-append",
        patch: patch([{ op: "append", featureId: 77, geometry: [1, 1], timestamp: 1n }], { sequence: 6 }),
      },
      {
        code: "duplicate-feature-id",
        patch: patch(
          [
            { op: "update", featureId: 1, geometry: [1, 1] },
            { op: "delete", featureId: 1 },
          ],
          { sequence: 6 },
        ),
      },
    ];

    for (const rejection of rejections) {
      const outcome = applyColumnarPatch(batch, rejection.patch);
      expect(outcome.outcome, rejection.code).toBe("rejected");
      if (outcome.outcome !== "rejected") continue;
      expect(outcome.code).toBe(rejection.code);
      expect(outcome.batch).toBe(batch);
      expect(digest(batch)).toBe(snapshot);
    }
  });

  it("rejects a patch against a batch without a feature-id column", () => {
    const created = createPatchableGeoArrowBatch(
      {
        id: "anonymous",
        sequence: 1,
        schemaId: "incidents@1",
        identity,
        geometry: { kind: "point", field: "geometry", values: [[0, 0]] },
      },
      { reserve: { rows: 4 } },
    );
    const outcome = applyColumnarPatch(created.batch, patch([{ op: "delete", featureId: 0 }]));
    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome !== "rejected") return;
    expect(outcome.code).toBe("missing-feature-id-column");
  });

  it("rejects appends and sort-key updates on an ordered batch", () => {
    const ordered = createPatchableGeoArrowBatch(
      {
        ...pointInput(4),
        identity: {
          ...identity,
          ordering: { stable: true, keys: [{ field: "observed", direction: "ascending", nulls: "last" }] },
        },
      },
      { reserve: { rows: 4 } },
    );
    const appendOutcome = applyColumnarPatch(
      ordered.batch,
      patch([{ op: "append", featureId: 90, geometry: [1, 1], timestamp: 1n, dictionaryValue: "open" }]),
    );
    expect(appendOutcome.outcome).toBe("rejected");
    if (appendOutcome.outcome === "rejected") expect(appendOutcome.code).toBe("ordering-conflict");

    const updateOutcome = applyColumnarPatch(ordered.batch, patch([{ op: "update", featureId: 1, timestamp: 9n }]));
    expect(updateOutcome.outcome).toBe("rejected");
    if (updateOutcome.outcome === "rejected") expect(updateOutcome.code).toBe("ordering-conflict");

    // A delete does not move a row, so the declared order survives it.
    const deleteOutcome = applyColumnarPatch(ordered.batch, patch([{ op: "delete", featureId: 1 }]));
    expect(deleteOutcome.outcome).toBe("patched-in-place");
  });

  it("throws typed errors for structurally invalid patches", () => {
    expect(() => patch([{ op: "update", featureId: 1 } as ColumnarPatchOperationV1])).toThrow(HonuaColumnarPatchError);
    expect(() => patch([{ op: "append", featureId: -1, geometry: null }])).toThrow(HonuaColumnarPatchError);
    expect(() => patch([{ op: "delete", featureId: 1 }], { sequence: 1 })).not.toThrow();
    expect(() =>
      createColumnarPatch({
        schemaId: "incidents@1",
        geometryKind: "point",
        cursor: { cursor: "c", sequence: 1, observedAt: "not-a-time" },
        operations: [],
      }),
    ).toThrow(HonuaColumnarPatchError);
    expect(() =>
      createColumnarPatch({
        schemaId: "incidents@1",
        geometryKind: "point",
        cursor: { cursor: "c", sequence: 1, observedAt: "2026-01-01T00:00:00Z" },
        operations: [{ op: "delete", featureId: 1 }],
        maxOperations: 0,
      }),
    ).toThrow(/limit is 0/);
  });

  it("applies successive patches deterministically", () => {
    const build = (): ColumnarBatchV1 => createPatchableGeoArrowBatch(pointInput(6), { reserve: { rows: 6 } }).batch;
    const stream = [
      patch([{ op: "append", featureId: 50, geometry: [5, 5], timestamp: 50n, dictionaryValue: "open" }], {
        sequence: 1,
      }),
      patch([{ op: "update", featureId: 0, geometry: [0.5, -0.5] }], { sequence: 2 }),
      patch([{ op: "delete", featureId: 3 }], { sequence: 3 }),
    ];
    const run = (): ColumnarBatchV1 => {
      let batch = build();
      for (const next of stream) {
        const outcome = applyColumnarPatch(batch, next);
        expect(outcome.outcome).toBe("patched-in-place");
        if (outcome.outcome === "rejected") throw new Error(outcome.code);
        batch = outcome.batch;
      }
      return batch;
    };
    expect(digest(run())).toBe(digest(run()));
    const final = run();
    expect(inspectColumnarPatchState(final).generation).toBe(3);
    expect(decodePatchedGeoArrowBatch(final).rows.map((row) => row.featureId)).toEqual([0, 1, 2, 4, 5, 50]);
  });

  it("frees a tombstoned feature id only through a compacting rebuild", () => {
    const created = createPatchableGeoArrowBatch(pointInput(8), { reserve: { rows: 8 } });
    const deleted = applyColumnarPatch(created.batch, patch([{ op: "delete", featureId: 2 }], { sequence: 1 }));
    expect(deleted.outcome).toBe("patched-in-place");
    if (deleted.outcome !== "patched-in-place") return;
    const recreated = applyColumnarPatch(
      deleted.batch,
      patch([{ op: "append", featureId: 2, geometry: [99, 99], timestamp: 99n, dictionaryValue: "open" }], {
        sequence: 2,
      }),
    );
    expect(recreated.outcome).toBe("rebuilt");
    if (recreated.outcome !== "rebuilt") return;
    expect(recreated.reason).toBe("layout");
    // The compacted batch carries no overlay: a stale range would hide a row.
    expect(recreated.state.tombstoneCount).toBe(0);
    expect(recreated.batch.schema.metadata?.["honua.columnar-patch.tombstones"]).toBeUndefined();
    const rows = decodePatchedGeoArrowBatch(recreated.batch).rows;
    expect(rows.map((row) => row.featureId)).toEqual([0, 1, 3, 4, 5, 6, 7, 2]);
    expect(rows.filter((row) => row.featureId === 2)).toHaveLength(1);
    expect(rows.at(-1)?.geometry).toEqual([99, 99]);
  });

  it("copies only the appended rows' bytes into a million-row batch", () => {
    const rows = 1_000_000;
    const appended = 1_000;
    const limits = { maxRows: rows + appended };
    const created = createPatchableGeoArrowBatch(pointInput(rows), {
      ...limits,
      reserve: { rows: appended * 4 },
    });
    const before = backings(created.batch);
    const beforeBytes = before.map((backing) => backing.byteLength);

    const operations: ColumnarPatchOperationV1[] = Array.from({ length: appended }, (_, index) => ({
      op: "append" as const,
      featureId: rows + index,
      geometry: [index, -index],
      timestamp: BigInt(index),
      dictionaryValue: "open",
    }));
    const outcome = applyColumnarPatch(created.batch, patch(operations), { limits });

    expect(outcome.outcome).toBe("patched-in-place");
    if (outcome.outcome !== "patched-in-place") return;
    expect(outcome.bufferIdentityPreserved).toBe(true);
    expect(backings(outcome.batch)).toEqual(before);
    expect(backings(outcome.batch).map((backing) => backing.byteLength)).toEqual(beforeBytes);

    // No column is nullable, so the appended rows cost exactly x + y (16),
    // the timestamp (8), the dictionary index (4), and the feature id (4).
    expect(outcome.metrics.payloadBytesCopied).toBe(appended * (16 + 8 + 4 + 4));
    expect(outcome.metrics.metadataBytes).toBeLessThanOrEqual(4_096);
    expect(outcome.metrics.backingBytesAllocated).toBe(0);
    expect(outcome.batch.rowCount).toBe(rows + appended);

    const inspection = inspectGeoArrowBatch(outcome.batch, limits);
    expect(inspection.metrics.rows).toBe(rows + appended);
    expect(inspection.featureIds?.values.at(-1)).toBe(rows + appended - 1);
    expect(inspection.geometry.coordinates.x?.at(-1)).toBe(appended - 1);
  }, 120_000);

  it("writes and compacts nulls when the batch declares nullable columns", () => {
    const created = createPatchableGeoArrowBatch(
      {
        id: "live-nullable",
        sequence: 1,
        schemaId: "incidents@1",
        identity,
        geometry: { kind: "point", field: "geometry", values: [[0, 0], null, [2, -2], [3, -3]] },
        temporal: { field: "observed", unit: "millisecond", values: [1n, null, 3n, 4n] },
        dictionary: { field: "status", values: ["open", null, "closed", "open"] },
        featureIds: { field: "id", values: [0, 1, 2, 3] },
      },
      { reserve: { rows: 4 } },
    );

    const patched = applyColumnarPatch(
      created.batch,
      patch([
        { op: "append", featureId: 10, geometry: null, timestamp: null, dictionaryValue: null },
        { op: "update", featureId: 1, geometry: [1, -1], timestamp: 2n, dictionaryValue: "closed" },
        { op: "update", featureId: 3, geometry: null, timestamp: null, dictionaryValue: null },
      ]),
    );
    expect(patched.outcome).toBe("patched-in-place");
    if (patched.outcome !== "patched-in-place") return;
    const rows = decodePatchedGeoArrowBatch(patched.batch).rows;
    expect(rows.map((row) => row.geometry)).toEqual([[0, 0], [1, -1], [2, -2], null, null]);
    expect(rows.map((row) => row.timestamp)).toEqual([1n, 2n, 3n, null, null]);
    expect(rows.map((row) => row.dictionaryValue)).toEqual(["open", "closed", "closed", null, null]);

    const rebuilt = applyColumnarPatch(
      patched.batch,
      patch(
        [
          { op: "delete", featureId: 0 },
          { op: "delete", featureId: 2 },
        ],
        { sequence: 2 },
      ),
    );
    expect(rebuilt.outcome).toBe("rebuilt");
    if (rebuilt.outcome !== "rebuilt") return;
    const compacted = decodePatchedGeoArrowBatch(rebuilt.batch).rows;
    expect(compacted.map((row) => row.featureId)).toEqual([1, 3, 10]);
    expect(compacted.map((row) => row.geometry)).toEqual([[1, -1], null, null]);
    expect(compacted.map((row) => row.timestamp)).toEqual([2n, null, null]);
    expect(compacted.map((row) => row.dictionaryValue)).toEqual(["closed", null, null]);
  });

  it("keeps a deck.gl binding valid across an in-place patch and invalidates it on rebuild", () => {
    const created = createPatchableGeoArrowBatch(renderableInput(4), { reserve: { rows: 4 } });
    const binding = bindGeoArrowPointBatchToDeckGl({ layerId: "live", batch: created.batch });
    const bound = binding.request.data.attributes.getPosition.value as Float64Array;
    const coordinates = (batch: ColumnarBatchV1): ArrayBuffer =>
      batch.buffers.find((buffer) => buffer.id === "geometry.coordinates")!.data;
    expect(bound.buffer).toBe(coordinates(created.batch));
    expect(binding.metrics.rows).toBe(4);

    const patched = applyColumnarPatch(
      created.batch,
      patch(
        [
          { op: "append", featureId: 40, geometry: [10, -10] },
          { op: "update", featureId: 1, geometry: [7.5, -7.5] },
        ],
        { schemaId: "render@1" },
      ),
    );
    expect(patched.outcome).toBe("patched-in-place");
    if (patched.outcome !== "patched-in-place") return;

    // The binding taken before the patch still aliases the batch's buffer, and
    // the in-place update is visible through it without rebinding.
    expect(bound.buffer).toBe(coordinates(patched.batch));
    expect([bound[2], bound[3]]).toEqual([7.5, -7.5]);

    // Rebinding is what surfaces the appended row; the buffer is unchanged.
    const rebound = bindGeoArrowPointBatchToDeckGl({ layerId: "live", batch: patched.batch });
    expect(rebound.metrics.rows).toBe(5);
    expect((rebound.request.data.attributes.getPosition.value as Float64Array).buffer).toBe(bound.buffer);

    const rebuilt = applyColumnarPatch(
      patched.batch,
      patch(
        [
          { op: "delete", featureId: 0 },
          { op: "delete", featureId: 2 },
        ],
        { schemaId: "render@1", sequence: 2 },
      ),
    );
    expect(rebuilt.outcome).toBe("rebuilt");
    if (rebuilt.outcome !== "rebuilt") return;
    expect(rebuilt.reason).toBe("tombstone-ratio");
    expect(coordinates(rebuilt.batch)).not.toBe(bound.buffer);
    const afterRebuild = bindGeoArrowPointBatchToDeckGl({ layerId: "live", batch: rebuilt.batch });
    expect(afterRebuild.metrics.rows).toBe(3);
    expect((afterRebuild.request.data.attributes.getPosition.value as Float64Array).buffer).not.toBe(bound.buffer);
  });

  it("runs as a registered worker operation with progress and cancellation", async () => {
    const [clientTransport, workerTransport] = pair();
    const created = createPatchableGeoArrowBatch(pointInput(16), { reserve: { rows: 16 } });
    const host = startColumnarWorkerHost({
      transport: workerTransport,
      operations: {
        patch: createColumnarPatchOperation({
          patch: patch([
            { op: "append", featureId: 300, geometry: [3, 3], timestamp: 3n, dictionaryValue: "open" },
            { op: "delete", featureId: 4 },
          ]),
        }),
      },
    });
    const session = createColumnarWorkerSession({ createWorker: () => clientTransport });
    const fractions: number[] = [];
    const result = await session.execute("patch", created.batch, {
      onProgress: (progress) => fractions.push(progress.fraction),
    });
    expect(result.batch.rowCount).toBe(17);
    expect(fractions.length).toBeGreaterThan(0);
    expect([...fractions].sort((left, right) => left - right)).toEqual(fractions);
    expect(fractions.at(-1)).toBe(1);
    const state = inspectColumnarPatchState(result.batch);
    expect(state.tombstoneCount).toBe(1);
    expect(state.liveRowCount).toBe(16);
    session.dispose();
    host.dispose();
  });

  it("surfaces a rejection through the worker as a typed operation failure", async () => {
    const [clientTransport, workerTransport] = pair();
    const created = createPatchableGeoArrowBatch(pointInput(4), { reserve: { rows: 4 } });
    const host = startColumnarWorkerHost({
      transport: workerTransport,
      operations: { patch: createColumnarPatchOperation({ patch: patch([{ op: "delete", featureId: 999 }]) }) },
    });
    const session = createColumnarWorkerSession({ createWorker: () => clientTransport });
    // The host does not forward an operation's message across the boundary.
    await expect(session.execute("patch", created.batch)).rejects.toMatchObject({
      name: "HonuaColumnarWorkerError",
      code: "operation-failed",
    });
    session.dispose();
    host.dispose();
  });

  it("cancels cooperatively before mutating the batch", async () => {
    const created = createPatchableGeoArrowBatch(pointInput(8), { reserve: { rows: 8 } });
    const snapshot = digest(created.batch);
    const controller = new AbortController();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = createColumnarPatchOperation({
      patch: async () => {
        await gate;
        return patch([{ op: "append", featureId: 800, geometry: [8, 8], timestamp: 8n, dictionaryValue: "open" }]);
      },
    });
    const pending = operation(created.batch, {
      requestId: "request-1",
      signal: controller.signal,
      reportProgress: () => {},
    });
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(digest(created.batch)).toBe(snapshot);
  });
});
