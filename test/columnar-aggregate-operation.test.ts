import { describe, expect, it } from "vitest";
import { buildColumnarAggregateFixture } from "../bench/columnar-aggregate-bench.js";
import {
  COLUMNAR_WORKER_CANCEL_KIND,
  COLUMNAR_WORKER_ERROR_KIND,
  COLUMNAR_WORKER_PROGRESS_KIND,
  COLUMNAR_WORKER_PROTOCOL_VERSION,
  COLUMNAR_WORKER_REQUEST_KIND,
  COLUMNAR_WORKER_RESULT_KIND,
  type ColumnarBatchV1,
  type ColumnarWorkerFaultEvent,
  type ColumnarWorkerMessageEvent,
  type ColumnarWorkerOperationContext,
  type ColumnarWorkerTransport,
  type CreateGeoArrowAggregateOperationOptions,
  DEFAULT_GEOARROW_AGGREGATE_MAX_GROUPS,
  type GeoArrowAggregateResult,
  createColumnarWorkerSession,
  createGeoArrowAggregateOperation,
  createGeoArrowBatch,
  inspectColumnarBatch,
  inspectGeoArrowBatch,
  readGeoArrowAggregateBatch,
  startColumnarWorkerHost,
} from "../src/columnar/index.js";

class LoopbackTransport implements ColumnarWorkerTransport {
  readonly messages = new Set<(event: ColumnarWorkerMessageEvent) => void>();
  peer?: LoopbackTransport;
  disposed = false;
  disposeCalls = 0;

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
    this.disposeCalls += 1;
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

const identity = {
  sourceId: "source",
  sourceVersion: "v1",
  schemaVersion: "points-v1",
  planId: "plan-v1",
  authorizationScope: "public",
  ordering: { stable: true, keys: [{ field: "id", direction: "ascending", nulls: "last" }] },
  freshness: { observedAt: "2026-01-01T00:00:00Z" },
} as const;

type Point = readonly number[] | null;

interface PointBatchInput {
  readonly id?: string;
  readonly points: readonly Point[];
  readonly classes?: readonly (string | null)[];
  readonly timestamps?: readonly (bigint | null)[];
  readonly ids?: readonly number[];
  readonly coordinateLayout?: "separated" | "interleaved";
}

function pointBatch(input: PointBatchInput): ColumnarBatchV1 {
  return createGeoArrowBatch({
    id: input.id ?? "source-batch",
    sequence: 7,
    schemaId: "points-v1",
    identity: {
      ...identity,
      ordering: {
        stable: true,
        keys: [
          {
            field: input.ids === undefined ? "geometry" : "id",
            direction: "ascending" as const,
            nulls: "last" as const,
          },
        ],
      },
    },
    geometry: {
      kind: "point",
      field: "geometry",
      coordinateLayout: input.coordinateLayout ?? "separated",
      values: input.points,
    },
    ...(input.timestamps === undefined
      ? {}
      : { temporal: { field: "observed", unit: "millisecond" as const, values: input.timestamps } }),
    ...(input.classes === undefined ? {} : { dictionary: { field: "class", values: input.classes } }),
    ...(input.ids === undefined ? {} : { featureIds: { field: "id", values: input.ids } }),
  }).batch;
}

function context(signal?: AbortSignal): ColumnarWorkerOperationContext {
  const fractions: number[] = [];
  return {
    requestId: "test-request",
    signal: signal ?? new AbortController().signal,
    reportProgress(fraction) {
      if (fractions.length > 0 && fraction < fractions[fractions.length - 1]!) {
        throw new Error(`progress regressed: ${fractions[fractions.length - 1]} -> ${fraction}`);
      }
      fractions.push(fraction);
    },
  };
}

async function aggregate(
  batch: ColumnarBatchV1,
  options: Omit<CreateGeoArrowAggregateOperationOptions, "id" | "schemaId"> &
    Partial<Pick<CreateGeoArrowAggregateOperationOptions, "id" | "schemaId">>,
): Promise<GeoArrowAggregateResult> {
  const { id, schemaId, ...rest } = options;
  const operation = createGeoArrowAggregateOperation({
    id: id ?? "aggregate-batch",
    schemaId: schemaId ?? "aggregate-v1",
    ...rest,
  });
  return readGeoArrowAggregateBatch(await operation(batch, context()));
}

function snapshotBuffers(batch: ColumnarBatchV1): readonly string[] {
  return batch.buffers.map((buffer) =>
    Buffer.from(buffer.data, buffer.byteOffset, buffer.byteLength).toString("base64"),
  );
}

describe("GeoArrow aggregation: dictionary grouping", () => {
  const batch = () =>
    pointBatch({
      points: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], null],
      classes: ["b", "a", "b", null, "a", "b"],
      timestamps: [10n, 20n, null, 40n, 50n, 60n],
      ids: [1, 2, 3, 4, 5, 6],
    });

  it("reduces to exact group counts and metric values with the null group last", async () => {
    const result = await aggregate(batch(), {
      group: { kind: "dictionary" },
      metrics: [
        { name: "features", kind: "count" },
        { name: "observations", kind: "count", column: "temporal" },
        { name: "idSum", kind: "sum", column: "featureId" },
        { name: "minX", kind: "min", column: "x" },
        { name: "maxX", kind: "max", column: "x" },
        { name: "meanX", kind: "mean", column: "x" },
      ],
    });

    expect(result.rows.map((row) => row.key)).toEqual(["a", "b", null]);
    expect(result.rows[0]!.metrics).toEqual({
      features: 2,
      observations: 2,
      idSum: 7,
      minX: 2,
      maxX: 5,
      meanX: 3.5,
    });
    expect(result.rows[1]!.metrics).toEqual({
      features: 3,
      observations: 2,
      idSum: 10,
      minX: 1,
      maxX: 3,
      meanX: 2,
    });
    expect(result.rows[2]!.metrics).toEqual({
      features: 1,
      observations: 1,
      idSum: 4,
      minX: 4,
      maxX: 4,
      meanX: 4,
    });
    expect(result.batch.rowCount).toBe(3);
  });

  it("keeps a metric null rather than zero when a group has no non-null input", async () => {
    const result = await aggregate(
      pointBatch({
        points: [null, null, [3, 3]],
        classes: ["a", "a", "b"],
        ids: [1, 2, 3],
      }),
      {
        group: { kind: "dictionary" },
        metrics: [
          { name: "features", kind: "count" },
          { name: "coordinates", kind: "count", column: "x" },
          { name: "sumX", kind: "sum", column: "x" },
          { name: "meanX", kind: "mean", column: "x" },
        ],
      },
    );

    expect(result.rows.map((row) => row.key)).toEqual(["a", "b"]);
    // A count of non-null values is legitimately zero; a sum or mean is not.
    expect(result.rows[0]!.metrics).toEqual({ features: 2, coordinates: 0, sumX: null, meanX: null });
    expect(result.rows[1]!.metrics).toEqual({ features: 1, coordinates: 1, sumX: 3, meanX: 3 });
  });

  it("skips null-keyed rows entirely under the skip policy", async () => {
    const result = await aggregate(batch(), {
      group: { kind: "dictionary" },
      nullKeys: "skip",
      metrics: [{ name: "features", kind: "count" }],
    });

    expect(result.rows.map((row) => row.key)).toEqual(["a", "b"]);
    expect(result.rows.map((row) => row.metrics.features)).toEqual([2, 3]);
    expect(result.source.skippedRows).toBe(1);
  });

  it("handles the single-group and all-distinct extremes", async () => {
    const single = await aggregate(
      pointBatch({
        points: [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
        classes: ["only", "only", "only"],
        ids: [1, 2, 3],
      }),
      { group: { kind: "dictionary" }, metrics: [{ name: "features", kind: "count" }] },
    );
    expect(single.rows).toHaveLength(1);
    expect(single.rows[0]).toEqual({ key: "only", metrics: { features: 3 } });

    const distinct = await aggregate(
      pointBatch({
        points: [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
        classes: ["c", "a", "b"],
        ids: [1, 2, 3],
      }),
      { group: { kind: "dictionary" }, metrics: [{ name: "features", kind: "count" }] },
    );
    expect(distinct.rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
    expect(distinct.rows.map((row) => row.metrics.features)).toEqual([1, 1, 1]);
  });

  it("reduces an empty batch to an empty result", async () => {
    const result = await aggregate(pointBatch({ points: [], classes: [], ids: [] }), {
      group: { kind: "dictionary" },
      metrics: [{ name: "features", kind: "count" }],
    });
    expect(result.batch.rowCount).toBe(0);
    expect(result.rows).toEqual([]);
  });
});

describe("GeoArrow aggregation: temporal truncation grouping", () => {
  it("truncates toward negative infinity and orders buckets ascending", async () => {
    const result = await aggregate(
      pointBatch({
        points: [
          [0, 0],
          [1, 1],
          [2, 2],
          [3, 3],
          [4, 4],
        ],
        timestamps: [0n, 3_599_999n, 3_600_000n, -1n, null],
        ids: [1, 2, 3, 4, 5],
      }),
      {
        group: { kind: "temporal", unit: "hour" },
        metrics: [
          { name: "features", kind: "count" },
          { name: "meanX", kind: "mean", column: "x" },
        ],
      },
    );

    expect(result.rows.map((row) => row.key)).toEqual([-3_600_000, 0, 3_600_000, null]);
    expect(result.rows.map((row) => row.metrics.features)).toEqual([1, 2, 1, 1]);
    expect(result.rows.map((row) => row.metrics.meanX)).toEqual([3, 0.5, 2, 4]);
  });

  it("supports second, minute, hour, and day truncation over the same column", async () => {
    const timestamps = [0n, 1_000n, 61_000n, 3_601_000n, 86_401_000n];
    const source = () =>
      pointBatch({
        points: timestamps.map((_, index) => [index, index] as const),
        timestamps,
        ids: timestamps.map((_, index) => index),
      });
    const keysFor = async (unit: "second" | "minute" | "hour" | "day") =>
      (
        await aggregate(source(), {
          group: { kind: "temporal", unit },
          metrics: [{ name: "features", kind: "count" }],
        })
      ).rows.map((row) => row.key);

    expect(await keysFor("second")).toEqual([0, 1_000, 61_000, 3_601_000, 86_401_000]);
    expect(await keysFor("minute")).toEqual([0, 60_000, 3_600_000, 86_400_000]);
    expect(await keysFor("hour")).toEqual([0, 3_600_000, 86_400_000]);
    expect(await keysFor("day")).toEqual([0, 86_400_000]);
  });
});

describe("GeoArrow aggregation: spatial grid grouping", () => {
  it("bins points into a regular grid ordered by cell x then y", async () => {
    const result = await aggregate(
      pointBatch({
        points: [[0, 0], [9.9, 9.9], [10, 10], [-1, -1], null],
        ids: [1, 2, 3, 4, 5],
      }),
      {
        group: { kind: "grid", cellSize: 10 },
        metrics: [
          { name: "features", kind: "count" },
          { name: "idSum", kind: "sum", column: "featureId" },
        ],
      },
    );

    expect(result.rows.map((row) => row.key)).toEqual([[-1, -1], [0, 0], [1, 1], null]);
    expect(result.rows.map((row) => row.metrics.features)).toEqual([1, 2, 1, 1]);
    expect(result.rows.map((row) => row.metrics.idSum)).toEqual([4, 3, 3, 5]);
  });

  it("honours a rectangular cell size and a shifted origin", async () => {
    const result = await aggregate(
      pointBatch({
        points: [
          [0, 0],
          [4, 9],
          [6, 11],
        ],
        ids: [1, 2, 3],
      }),
      {
        group: { kind: "grid", cellSize: [5, 10], origin: [-5, -10] },
        metrics: [{ name: "features", kind: "count" }],
      },
    );
    expect(result.rows.map((row) => row.key)).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(result.rows.map((row) => row.metrics.features)).toEqual([2, 1]);
  });

  it("treats an empty or null geometry as a null key and bins other rows by bounds centre", async () => {
    const batch = createGeoArrowBatch({
      id: "lines",
      sequence: 1,
      schemaId: "points-v1",
      identity,
      geometry: {
        kind: "linestring",
        field: "geometry",
        values: [
          [
            [0, 0],
            [2, 2],
          ],
          [],
          null,
          [
            [30, 30],
            [32, 32],
          ],
        ],
      },
      featureIds: { field: "id", values: [1, 2, 3, 4] },
    }).batch;

    const result = await aggregate(batch, {
      group: { kind: "grid", cellSize: 10 },
      metrics: [{ name: "features", kind: "count" }],
    });

    expect(result.rows.map((row) => row.key)).toEqual([[0, 0], [3, 3], null]);
    expect(result.rows.map((row) => row.metrics.features)).toEqual([1, 1, 2]);
  });

  it("reads interleaved coordinates the same way as separated ones", async () => {
    const points: readonly Point[] = [
      [0, 0],
      [11, 11],
      [12, 12],
    ];
    const separated = await aggregate(pointBatch({ points, ids: [1, 2, 3], coordinateLayout: "separated" }), {
      group: { kind: "grid", cellSize: 10 },
      metrics: [{ name: "features", kind: "count" }],
    });
    const interleaved = await aggregate(pointBatch({ points, ids: [1, 2, 3], coordinateLayout: "interleaved" }), {
      group: { kind: "grid", cellSize: 10 },
      metrics: [{ name: "features", kind: "count" }],
    });
    expect(interleaved.rows).toEqual(separated.rows);
    expect(separated.rows.map((row) => row.key)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("GeoArrow aggregation: bounds and hostile input", () => {
  it("fails closed on the group ceiling before allocating an output batch, leaving the input intact", async () => {
    const batch = pointBatch({
      points: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      classes: ["a", "b", "c"],
      ids: [1, 2, 3],
    });
    const before = snapshotBuffers(batch);
    const operation = createGeoArrowAggregateOperation({
      id: "aggregate-batch",
      schemaId: "aggregate-v1",
      group: { kind: "dictionary" },
      maxGroups: 2,
      metrics: [{ name: "features", kind: "count" }],
    });

    await expect(operation(batch, context())).rejects.toMatchObject({
      name: "HonuaGeoArrowError",
      code: "group-limit-exceeded",
    });
    expect(snapshotBuffers(batch)).toEqual(before);
    // The input remains a valid, unmutated GeoArrow batch.
    expect(inspectGeoArrowBatch(batch).metrics.rows).toBe(3);
  });

  it("counts the declared null group against the ceiling", async () => {
    const operation = createGeoArrowAggregateOperation({
      id: "aggregate-batch",
      schemaId: "aggregate-v1",
      group: { kind: "dictionary" },
      maxGroups: 1,
      metrics: [{ name: "features", kind: "count" }],
    });
    await expect(
      operation(
        pointBatch({
          points: [
            [1, 1],
            [2, 2],
          ],
          classes: ["a", null],
          ids: [1, 2],
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "group-limit-exceeded" });
  });

  it("rejects a non-finite metric value instead of poisoning a sum", async () => {
    const batch = pointBatch({
      points: [
        [1, 1],
        [2, 2],
      ],
      classes: ["a", "a"],
      ids: [1, 2],
    });
    const xBuffer = batch.buffers.find((buffer) => buffer.id === "geometry.x");
    expect(xBuffer).toBeDefined();
    new Float64Array(xBuffer!.data, xBuffer!.byteOffset, 2)[1] = Number.NaN;

    const operation = createGeoArrowAggregateOperation({
      id: "aggregate-batch",
      schemaId: "aggregate-v1",
      group: { kind: "dictionary" },
      metrics: [{ name: "sumX", kind: "sum", column: "x" }],
    });
    // The reduction refuses to start rather than summing a NaN: batch payload
    // validation owns coordinate finiteness, so the typed failure is
    // `invalid-batch` and it lands before the first row is scanned. The
    // reducer's own non-finite guard is the backstop behind that contract.
    await expect(operation(batch, context())).rejects.toMatchObject({
      name: "HonuaGeoArrowError",
      code: "invalid-batch",
    });
  });

  it("rejects a temporal value too large to aggregate without losing precision", async () => {
    const batch = pointBatch({
      points: [[1, 1]],
      classes: ["a"],
      timestamps: [2n ** 60n],
      ids: [1],
    });
    await expect(
      aggregate(batch, {
        group: { kind: "dictionary" },
        metrics: [{ name: "observedSum", kind: "sum", column: "temporal" }],
      }),
    ).rejects.toMatchObject({ name: "HonuaGeoArrowError", code: "invalid-input" });
  });

  it("rejects unsupported and missing columns with typed errors", async () => {
    const points = pointBatch({ points: [[1, 1]], classes: ["a"], ids: [1] });

    await expect(
      aggregate(points, { group: { kind: "dictionary" }, metrics: [{ name: "z", kind: "sum", column: "z" }] }),
    ).rejects.toMatchObject({ name: "HonuaGeoArrowError", code: "invalid-input" });

    await expect(
      aggregate(pointBatch({ points: [[1, 1]], ids: [1] }), {
        group: { kind: "dictionary" },
        metrics: [{ name: "features", kind: "count" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    await expect(
      aggregate(pointBatch({ points: [[1, 1]], classes: ["a"], ids: [1] }), {
        group: { kind: "temporal", unit: "hour" },
        metrics: [{ name: "features", kind: "count" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    await expect(
      aggregate(pointBatch({ points: [[1, 1]], classes: ["a"] }), {
        group: { kind: "dictionary" },
        metrics: [{ name: "idSum", kind: "sum", column: "featureId" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    const lines = createGeoArrowBatch({
      id: "lines",
      sequence: 1,
      schemaId: "points-v1",
      identity,
      geometry: {
        kind: "linestring",
        field: "geometry",
        values: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
      featureIds: { field: "id", values: [1] },
    }).batch;
    await expect(
      aggregate(lines, {
        group: { kind: "grid", cellSize: 10 },
        metrics: [{ name: "sumX", kind: "sum", column: "x" }],
      }),
    ).rejects.toMatchObject({ code: "unsupported-layout" });
  });

  it("rejects malformed operation options up front", () => {
    const base = { id: "a", schemaId: "s", group: { kind: "dictionary" } } as const;
    expect(() => createGeoArrowAggregateOperation({ ...base, metrics: [] })).toThrow(TypeError);
    expect(() => createGeoArrowAggregateOperation({ ...base, metrics: [{ name: "sum", kind: "sum" }] })).toThrow(
      TypeError,
    );
    expect(() =>
      createGeoArrowAggregateOperation({
        ...base,
        metrics: [
          { name: "a", kind: "count" },
          { name: "a", kind: "count" },
        ],
      }),
    ).toThrow(TypeError);
    expect(() => createGeoArrowAggregateOperation({ ...base, metrics: [{ name: "group", kind: "count" }] })).toThrow(
      TypeError,
    );
    expect(() =>
      createGeoArrowAggregateOperation({ ...base, maxGroups: 0, metrics: [{ name: "a", kind: "count" }] }),
    ).toThrow(TypeError);
    expect(() =>
      createGeoArrowAggregateOperation({
        id: "a",
        schemaId: "s",
        group: { kind: "grid", cellSize: 0 },
        metrics: [{ name: "a", kind: "count" }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createGeoArrowAggregateOperation({
        id: "a",
        schemaId: "s",
        group: { kind: "temporal", unit: "fortnight" as never },
        metrics: [{ name: "a", kind: "count" }],
      }),
    ).toThrow(TypeError);
  });

  it("defaults the group ceiling to the documented value", async () => {
    const result = await aggregate(pointBatch({ points: [[1, 1]], classes: ["a"], ids: [1] }), {
      group: { kind: "dictionary" },
      metrics: [{ name: "features", kind: "count" }],
    });
    expect(result.maxGroups).toBe(DEFAULT_GEOARROW_AGGREGATE_MAX_GROUPS);
    expect(DEFAULT_GEOARROW_AGGREGATE_MAX_GROUPS).toBe(65_536);
  });
});

describe("GeoArrow aggregation: result identity", () => {
  it("records the source batch identity, the group spec, and the metric spec", async () => {
    const source = pointBatch({ points: [[1, 1]], classes: ["a"], ids: [1] });
    const result = await aggregate(source, {
      id: "aggregate-batch",
      schemaId: "class-count-v1",
      group: { kind: "dictionary" },
      metrics: [{ name: "features", kind: "count" }],
    });

    expect(result.batch.identity?.schemaVersion).toBe("class-count-v1");
    expect(result.batch.identity?.sourceId).toBe(identity.sourceId);
    expect(result.batch.identity?.authorizationScope).toBe(identity.authorizationScope);
    expect(result.batch.identity?.freshness).toEqual(identity.freshness);
    expect(result.batch.identity?.ordering).toEqual({
      stable: true,
      keys: [{ field: "group", direction: "ascending", nulls: "last" }],
    });
    expect(result.batch.identity?.planId).toContain(identity.planId);
    expect(result.batch.identity?.planId).toContain('"kind":"dictionary"');
    expect(result.source).toMatchObject({
      batchId: "source-batch",
      schemaId: "points-v1",
      rowCount: 1,
      planId: identity.planId,
    });
  });

  it("separates the cache key of two different aggregations of the same source", async () => {
    const source = () => pointBatch({ points: [[1, 1]], classes: ["a"], ids: [1] });
    const counted = await aggregate(source(), {
      schemaId: "class-count-v1",
      group: { kind: "dictionary" },
      metrics: [{ name: "features", kind: "count" }],
    });
    const summed = await aggregate(source(), {
      schemaId: "class-sum-v1",
      group: { kind: "dictionary" },
      metrics: [{ name: "idSum", kind: "sum", column: "featureId" }],
    });
    const binned = await aggregate(source(), {
      schemaId: "grid-count-v1",
      group: { kind: "grid", cellSize: 10 },
      metrics: [{ name: "features", kind: "count" }],
    });

    const planIds = [counted, summed, binned].map((result) => result.batch.identity?.planId);
    expect(new Set(planIds).size).toBe(3);
    expect(binned.batch.identity?.ordering.keys.map((key) => key.field)).toEqual(["group_x", "group_y"]);
  });
});

describe("GeoArrow aggregation: worker host", () => {
  it("runs end to end through startColumnarWorkerHost with monotonic progress", async () => {
    const progress: number[] = [];
    const session = createColumnarWorkerSession({
      createWorker: () => {
        const [client, worker] = pair();
        startColumnarWorkerHost({
          transport: worker,
          operations: {
            aggregate: createGeoArrowAggregateOperation({
              id: "aggregate-batch",
              schemaId: "class-count-v1",
              group: { kind: "dictionary" },
              metrics: [
                { name: "features", kind: "count" },
                { name: "idSum", kind: "sum", column: "featureId" },
              ],
            }),
          },
        });
        return client;
      },
    });

    const result = await session.execute(
      "aggregate",
      pointBatch({
        points: [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
        classes: ["b", "a", "b"],
        ids: [1, 2, 3],
      }),
      { onProgress: (event) => progress.push(event.fraction) },
    );

    expect(progress.length).toBeGreaterThan(0);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress[progress.length - 1]).toBe(1);
    expect(result.outputMetrics.copiedBytes).toBe(0);

    const decoded = readGeoArrowAggregateBatch(result.batch);
    expect(decoded.rows.map((row) => row.key)).toEqual(["a", "b"]);
    expect(decoded.rows.map((row) => row.metrics.features)).toEqual([1, 2]);
    expect(decoded.rows.map((row) => row.metrics.idSum)).toEqual([2, 4]);
    expect(decoded.source.batchId).toBe("source-batch");
    expect(session.state).toBe("idle");
    session.dispose();
  });

  it("rejects a batch that is not a honua.aggregate result", () => {
    let thrown: unknown;
    try {
      readGeoArrowAggregateBatch(pointBatch({ points: [[1, 1]], ids: [1] }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: "HonuaGeoArrowError", code: "unsupported-layout" });
  });
});

describe("GeoArrow aggregation: cancellation", () => {
  const million = () => buildColumnarAggregateFixture(1_000_000, 1_024).batch;

  it("settles a cancelled million-row aggregation quickly without retiring the transport", async () => {
    const [client, worker] = pair();
    startColumnarWorkerHost({
      transport: worker,
      operations: {
        aggregate: createGeoArrowAggregateOperation({
          id: "aggregate-batch",
          schemaId: "class-count-v1",
          group: { kind: "dictionary" },
          metrics: [{ name: "features", kind: "count" }],
        }),
      },
    });

    const received: Record<string, unknown>[] = [];
    const waiters: { predicate: (message: Record<string, unknown>) => boolean; resolve: () => void }[] = [];
    client.addEventListener("message", (event: ColumnarWorkerMessageEvent) => {
      const message = event.data as Record<string, unknown>;
      received.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index]!.predicate(message)) {
          waiters.splice(index, 1)[0]!.resolve();
        }
      }
    });
    const waitFor = (predicate: (message: Record<string, unknown>) => boolean): Promise<void> =>
      received.some(predicate)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ predicate, resolve }));

    const batch = million();
    client.postMessage(
      {
        kind: COLUMNAR_WORKER_REQUEST_KIND,
        version: COLUMNAR_WORKER_PROTOCOL_VERSION,
        requestId: "cancel-me",
        operation: "aggregate",
        batch,
        metrics: inspectColumnarBatch(batch),
      },
      [],
    );

    // Wait for a *scan* progress event, not merely the first one. The operation
    // reports `inspect` before it validates the batch's packed payload, and
    // NFR-003 is a budget on cancelling a run that is already scanning.
    await waitFor((message) => message.kind === COLUMNAR_WORKER_PROGRESS_KIND && message.stage === "scan");
    const requestedAt = performance.now();
    client.postMessage(
      { kind: COLUMNAR_WORKER_CANCEL_KIND, version: COLUMNAR_WORKER_PROTOCOL_VERSION, requestId: "cancel-me" },
      [],
    );
    await waitFor((message) => message.kind === COLUMNAR_WORKER_ERROR_KIND && message.code === "aborted");
    const settleMs = performance.now() - requestedAt;

    expect(settleMs).toBeLessThan(50);
    expect(received.some((message) => message.kind === COLUMNAR_WORKER_RESULT_KIND)).toBe(false);
    expect(client.disposed).toBe(false);
    expect(worker.disposed).toBe(false);

    // The same transport still serves the next request: it was not retired.
    const followUp = pointBatch({ points: [[1, 1]], classes: ["a"], ids: [1] });
    client.postMessage(
      {
        kind: COLUMNAR_WORKER_REQUEST_KIND,
        version: COLUMNAR_WORKER_PROTOCOL_VERSION,
        requestId: "follow-up",
        operation: "aggregate",
        batch: followUp,
        metrics: inspectColumnarBatch(followUp),
      },
      [],
    );
    await waitFor((message) => message.kind === COLUMNAR_WORKER_RESULT_KIND && message.requestId === "follow-up");
    client.dispose();
    worker.dispose();
  }, 120_000);

  it("leaves the session idle and reusable after a mid-run cancel", async () => {
    const session = createColumnarWorkerSession({
      createWorker: () => {
        const [client, worker] = pair();
        startColumnarWorkerHost({
          transport: worker,
          operations: {
            aggregate: createGeoArrowAggregateOperation({
              id: "aggregate-batch",
              schemaId: "class-count-v1",
              group: { kind: "dictionary" },
              metrics: [{ name: "features", kind: "count" }],
            }),
          },
        });
        return client;
      },
    });

    const controller = new AbortController();
    const started = performance.now();
    const cancelled = session.execute("aggregate", buildColumnarAggregateFixture(200_000, 64).batch, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await expect(cancelled).rejects.toMatchObject({ name: "HonuaColumnarWorkerError", code: "aborted" });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(session.state).toBe("idle");

    const next = await session.execute("aggregate", pointBatch({ points: [[1, 1]], classes: ["a"], ids: [1] }));
    expect(readGeoArrowAggregateBatch(next.batch).rows.map((row) => row.key)).toEqual(["a"]);
    session.dispose();
  }, 120_000);
});

describe("GeoArrow aggregation: determinism", () => {
  it("emits a byte-identical result whatever the yield cadence", async () => {
    const source = () =>
      pointBatch({
        points: Array.from({ length: 5_000 }, (_, index) => [index % 97, index % 89] as const),
        classes: Array.from({ length: 5_000 }, (_, index) => `class-${index % 32}`),
        ids: Array.from({ length: 5_000 }, (_, index) => index),
      });
    const reduce = async (yieldIntervalRows: number): Promise<readonly string[]> => {
      const operation = createGeoArrowAggregateOperation({
        id: "aggregate-batch",
        schemaId: "aggregate-v1",
        group: { kind: "dictionary" },
        metrics: [
          { name: "features", kind: "count" },
          { name: "sumX", kind: "sum", column: "x" },
          { name: "meanX", kind: "mean", column: "x" },
          { name: "minX", kind: "min", column: "x" },
        ],
        yieldIntervalRows,
      });
      return snapshotBuffers(await operation(source(), context()));
    };

    // The yield cadence is the only scheduling knob the operation exposes. If
    // the output survives changing it, no worker scheduling decision moves it.
    const baseline = await reduce(64);
    expect(await reduce(1)).toEqual(baseline);
    expect(await reduce(4_999)).toEqual(baseline);
    expect(await reduce(1_000_000)).toEqual(baseline);
  });

  it("reduces a permuted batch to the same sums a naive running total would lose", async () => {
    // Every permutation holds the same multiset, and the exact sum is 2. A
    // naive running total returns 0 for the first order because each 1 falls
    // off the bottom of 1e16; compensation recovers the exact answer.
    const orders: readonly (readonly number[])[] = [
      [1e16, 1, 1, -1e16],
      [1, -1e16, 1e16, 1],
      [-1e16, 1, 1e16, 1],
      [1, 1, 1e16, -1e16],
    ];
    const naive = orders[0]!.reduce((total, value) => total + value, 0);
    expect(naive).toBe(0);

    for (const order of orders) {
      const result = await aggregate(
        pointBatch({
          points: order.map((value) => [value, 0] as const),
          classes: order.map(() => "a"),
          ids: order.map((_, index) => index),
        }),
        {
          group: { kind: "dictionary" },
          metrics: [
            { name: "sumX", kind: "sum", column: "x" },
            { name: "meanX", kind: "mean", column: "x" },
          ],
        },
      );
      expect(result.rows[0]!.metrics.sumX).toBe(2);
      expect(result.rows[0]!.metrics.meanX).toBe(0.5);
    }
  });

  it("orders groups by key rather than by the order they were first seen", async () => {
    const ascending = await aggregate(
      pointBatch({
        points: [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
        classes: ["a", "b", "c"],
        ids: [1, 2, 3],
      }),
      { group: { kind: "dictionary" }, metrics: [{ name: "features", kind: "count" }] },
    );
    const shuffled = await aggregate(
      pointBatch({
        points: [
          [3, 3],
          [1, 1],
          [2, 2],
        ],
        classes: ["c", "a", "b"],
        ids: [3, 1, 2],
      }),
      { group: { kind: "dictionary" }, metrics: [{ name: "features", kind: "count" }] },
    );
    expect(shuffled.rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
    expect(shuffled.rows).toEqual(ascending.rows);
  });

  it("collapses duplicate dictionary entries encoding the same value into one group", async () => {
    // Two dictionary indices, one string. A first-seen-index grouping would
    // emit two rows and make the result depend on the encoder's dictionary.
    const batch = pointBatch({
      points: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      classes: ["a", "b", "a"],
      ids: [1, 2, 3],
    });
    const offsets = batch.buffers.find((buffer) => buffer.id === "class.offsets");
    const values = batch.buffers.find((buffer) => buffer.id === "class.values");
    const indices = batch.buffers.find((buffer) => buffer.id === "class.indices");
    expect(offsets && values && indices).toBeTruthy();
    // Rewrite the dictionary as ["a", "a"] and point row 1 at the second entry.
    new Uint8Array(values!.data, values!.byteOffset, values!.byteLength).set([0x61, 0x61]);
    new Int32Array(indices!.data, indices!.byteOffset, 3).set([0, 1, 0]);

    const result = await aggregate(batch, {
      group: { kind: "dictionary" },
      metrics: [{ name: "features", kind: "count" }],
    });
    expect(result.rows.map((row) => row.key)).toEqual(["a"]);
    expect(result.rows[0]!.metrics.features).toBe(3);
  });
});
